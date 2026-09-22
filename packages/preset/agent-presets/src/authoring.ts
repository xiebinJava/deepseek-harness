/**
 * Copying, reading, and deleting locally authored presets.
 *
 * Authoring is confined to a `user` root: the shipped `.system` set is part of
 * the deployment, and letting a browser rewrite it would turn "reset to a known
 * preset" into something the same caller could have broken first.
 *
 * The only authoring write is a whole-directory copy of an existing preset.
 * No caller supplies composition text: the inputs are ids the host resolves
 * against its own roots plus an optional display name, so authoring grants no
 * capability the copied preset did not already carry.
 * @module @deepseek-ai/dsh-agent-presets/authoring
 */

import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import yaml from 'js-yaml'
import { METADATA_FILE, renderPresetMetadata } from './metadata.ts'
import { PRESET_ID, type AgentPreset, type PresetRoot } from './preset.ts'
import type {
  AgentPresetBindingOption, AgentPresetDraft, AgentPresetDraftInput, AgentPresetPublishResult,
  AgentPresetTestResult, AgentPresetVersion,
} from './types.ts'

/** Sidecar containing the editor's safe, structured draft. */
export const DRAFT_FILE = 'agent.draft.yml'

/** Files under this directory are immutable published composition snapshots. */
const VERSION_DIR = 'versions'
const COMPOSITION_FILE = 'agent.cordis.yml'

/** The editor accepts ids, never package specifiers or filesystem paths. */
const BINDING_ID = /^[a-z0-9][a-z0-9-]*$/

const WORKSPACES: readonly AgentPresetBindingOption[] = [
  { id: 'generic', label: '通用工作区', description: '可在没有专用业务工作区时使用。' },
  { id: 'pms', label: 'PMS 业务工作区', description: '项目、节点、任务、成员与排期能力。' },
]

/**
 * These are ids, not import paths. Existing composition rows are added to the
 * catalog at read time, while the PMS entry is the first explicitly supported
 * registered capability for newly authored PMS Agents.
 */
const REGISTERED_PLUGIN_OPTIONS: readonly AgentPresetBindingOption[] = [
  { id: 'pms', label: 'PMS 能力', description: 'PMS 查询、预览和受权限保护的命令。' },
]

/** The only plugin that this editor is currently allowed to add to a draft. */
const REGISTERED_PLUGIN_MODULES: Readonly<Record<string, { name: string; config: Record<string, unknown> }>> = {
  pms: { name: '@deepseek-ai/dsh-pms', config: { mode: 'agent' } },
}

/** Tool inventory used by the non-executing draft preview. */
const PREVIEW_TOOLS: Readonly<Record<string, readonly string[]>> = {
  pms: ['pms_project_list', 'pms_project_get', 'pms_task_list', 'pms_people_list', 'pms_command_preview'],
}

/** Destructive tools are never available to the draft preview. */
const PREVIEW_BLOCKED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  pms: ['pms_command_execute'],
}

const REGISTERED_SKILL_OPTIONS: readonly AgentPresetBindingOption[] = [
  { id: 'pms-context', label: 'PMS 上下文读取', description: '优先读取当前 PMS 工作区与业务上下文。' },
  { id: 'pms-data-accuracy', label: '项目数据准确性', description: '只依据本次工具返回的数据回答，不猜测。' },
]

interface DraftFile extends AgentPresetDraftInput {
  version?: number
  publishedRevision?: string
  history?: readonly AgentPresetVersion[]
}

interface CompositionRow {
  id?: unknown
  name?: unknown
  config?: unknown
  disabled?: unknown
  [key: string]: unknown
}

const textValue = (value: unknown): string => typeof value === 'string' ? value : ''

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
  : []

const draftPayload = (input: AgentPresetDraftInput): AgentPresetDraftInput => ({
  identityPrompt: input.identityPrompt,
  behaviorPrompt: input.behaviorPrompt,
  selectedSkills: [...new Set(input.selectedSkills.map(value => value.trim()).filter(Boolean))],
  selectedPlugins: [...new Set(input.selectedPlugins.map(value => value.trim()).filter(Boolean))],
  workspaceBindings: [...new Set(input.workspaceBindings.map(value => value.trim()).filter(Boolean))],
})

const revisionOf = (input: AgentPresetDraftInput): string => createHash('sha256')
  .update(JSON.stringify(draftPayload(input)))
  .digest('hex')

const fingerprintOf = (content: string): string => createHash('sha256')
  .update('dsh-agent-composition\0')
  .update(content)
  .digest('hex')

function draftInvalid(agentPreset: string, field: string, values: readonly string[]): RemoteError<'agent-preset/draft-invalid'> {
  return new RemoteError(
    'agent-preset/draft-invalid',
    `agent-presets: ${field} contains unregistered binding(s): ${values.join(', ')}`,
    { agentPreset, field, values },
  )
}

function draftConflict(agentPreset: string, expectedRevision: string, actualRevision: string): RemoteError<'agent-preset/draft-conflict'> {
  return new RemoteError(
    'agent-preset/draft-conflict',
    `agent-presets: draft for "${agentPreset}" is stale; reload before saving`,
    { agentPreset, expectedRevision, actualRevision },
  )
}

function rowsOf(content: string): CompositionRow[] {
  const parsed = yaml.load(content)
  if (!Array.isArray(parsed)) throw new Error('agent-presets: composition must be a YAML list')
  return parsed.filter((row): row is CompositionRow => typeof row === 'object' && row !== null && !Array.isArray(row))
}

function bindingOptions(rows: readonly CompositionRow[]): AgentPresetBindingOption[] {
  const options = rows.flatMap((row) => {
    const id = typeof row.id === 'string' ? row.id : undefined
    const moduleName = typeof row.name === 'string' ? row.name : undefined
    if (id === undefined || moduleName === undefined || id === 'persona') return []
    return [{ id, label: id, description: moduleName }]
  })
  const merged = [...REGISTERED_PLUGIN_OPTIONS, ...options]
  return [...new Map(merged.map(option => [option.id, option])).values()]
}

function personaPrompts(rows: readonly CompositionRow[]): { identityPrompt: string; behaviorPrompt: string } {
  const persona = rows.find(row => row.name === '@deepseek-ai/dsh-persona')
  const config = persona?.config
  const values = typeof config === 'object' && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
  return { identityPrompt: textValue(values.prefix), behaviorPrompt: textValue(values.suffix) }
}

function presetDir(preset: AgentPreset): string {
  return dirname(preset.path)
}

function draftPath(preset: AgentPreset): string {
  return join(presetDir(preset), DRAFT_FILE)
}

function versionPath(preset: AgentPreset, version: number): string {
  return join(presetDir(preset), VERSION_DIR, `v${version}`, COMPOSITION_FILE)
}

function ensureUserPreset(roots: readonly PresetRoot[], preset: AgentPreset): void {
  if (preset.trust !== 'user') throw notWritable(preset.id, 'it ships with the deployment')
  const root = writableRoot(roots, preset.id)
  const expected = join(root, preset.id, COMPOSITION_FILE)
  if (!isAbsolute(preset.path) || resolve(preset.path) !== resolve(expected)) {
    throw notWritable(preset.id, 'it does not live under the writable preset root')
  }
}

async function readDraftFile(preset: AgentPreset): Promise<DraftFile | undefined> {
  try {
    const parsed = yaml.load(await readFile(draftPath(preset), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    if (typeof value.identityPrompt !== 'string' || typeof value.behaviorPrompt !== 'string') return undefined
    return {
      identityPrompt: value.identityPrompt,
      behaviorPrompt: value.behaviorPrompt,
      selectedSkills: stringList(value.selectedSkills),
      selectedPlugins: stringList(value.selectedPlugins),
      workspaceBindings: stringList(value.workspaceBindings),
      ...typeof value.version === 'number' && Number.isInteger(value.version) ? { version: value.version } : {},
      ...typeof value.publishedRevision === 'string' ? { publishedRevision: value.publishedRevision } : {},
      ...Array.isArray(value.history) ? { history: value.history.filter(item => typeof item === 'object' && item !== null) as AgentPresetVersion[] } : {},
    }
  } catch {
    return undefined
  }
}

async function availableSkills(preset: AgentPreset): Promise<AgentPresetBindingOption[]> {
  const root = join(presetDir(preset), 'skills')
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    entries = []
  }
  const local = entries
    .filter(entry => entry.isDirectory() && BINDING_ID.test(entry.name))
    .map(entry => ({ id: entry.name, label: entry.name, description: '此 Agent 目录中的本地 Skill。' }))
  return [...new Map([...REGISTERED_SKILL_OPTIONS, ...local].map(option => [option.id, option])).values()]
}

function validateInput(
  preset: AgentPreset,
  input: AgentPresetDraftInput,
  plugins: readonly AgentPresetBindingOption[],
  skills: readonly AgentPresetBindingOption[],
): AgentPresetDraftInput {
  const next = draftPayload(input)
  if (next.identityPrompt.length > 20000) throw draftInvalid(preset.id, 'identityPrompt', [String(next.identityPrompt.length)])
  if (next.behaviorPrompt.length > 20000) throw draftInvalid(preset.id, 'behaviorPrompt', [String(next.behaviorPrompt.length)])
  for (const [field, values, allowed] of [
    ['selectedPlugins', next.selectedPlugins, plugins.map(option => option.id)] as const,
    ['selectedSkills', next.selectedSkills, skills.map(option => option.id)] as const,
    ['workspaceBindings', next.workspaceBindings, WORKSPACES.map(option => option.id)] as const,
  ]) {
    const invalid = values.filter(value => !BINDING_ID.test(value) || !allowed.includes(value))
    if (invalid.length > 0) throw draftInvalid(preset.id, field, invalid)
  }
  if (next.workspaceBindings.includes('pms') && !next.selectedPlugins.includes('pms')) {
    throw draftInvalid(preset.id, 'selectedPlugins', ['pms (PMS 工作区必需)'])
  }
  return next
}

/** Read an Agent's structured draft and its host-owned binding catalogs. */
export async function readDraftDocument(preset: AgentPreset): Promise<AgentPresetDraft> {
  const content = await readComposition(preset)
  const rows = rowsOf(content)
  const prompts = personaPrompts(rows)
  const plugins = bindingOptions(rows)
  const skills = await availableSkills(preset)
  const stored = await readDraftFile(preset)
  const input = stored === undefined ? {
    ...prompts,
    selectedSkills: [],
    selectedPlugins: rows.flatMap(row => typeof row.id === 'string' && row.id !== 'persona' && row.disabled !== true ? [row.id] : []),
    workspaceBindings: preset.workspaceTypes === undefined ? [] : [...preset.workspaceTypes],
  } : draftPayload(stored)
  const normalized = validateInput(preset, input, plugins, skills)
  const history = stored?.history ?? []
  return {
    ...normalized,
    agentPreset: preset.id,
    revision: revisionOf(normalized),
    ...stored?.publishedRevision === undefined ? {} : { publishedRevision: stored.publishedRevision },
    version: stored?.version ?? history.at(-1)?.version ?? 0,
    availableSkills: skills,
    availablePlugins: plugins,
    availableWorkspaces: WORKSPACES,
    history,
  }
}

/** Store one draft in a user-owned preset with optimistic concurrency. */
export async function saveDraftDocument(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
  expectedRevision: string,
  input: AgentPresetDraftInput,
): Promise<AgentPresetDraft> {
  ensureUserPreset(roots, preset)
  const current = await readDraftDocument(preset)
  if (current.revision !== expectedRevision) throw draftConflict(preset.id, expectedRevision, current.revision)
  const normalized = validateInput(preset, input, current.availablePlugins, current.availableSkills)
  const file: DraftFile = {
    ...normalized,
    ...current.version === 0 ? {} : { version: current.version },
    ...current.publishedRevision === undefined ? {} : { publishedRevision: current.publishedRevision },
    ...current.history.length === 0 ? {} : { history: current.history },
  }
  await writeFileAtomic(draftPath(preset), yaml.dump(file, { lineWidth: -1 }), { mode: 0o600, dirMode: 0o700 })
  return await readDraftDocument(preset)
}

/** Publish a draft into a new immutable composition generation. */
export async function publishDraftDocument(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
  expectedRevision: string,
): Promise<AgentPresetPublishResult> {
  ensureUserPreset(roots, preset)
  const current = await readDraftDocument(preset)
  if (current.revision !== expectedRevision) throw draftConflict(preset.id, expectedRevision, current.revision)
  const content = await readComposition(preset)
  const rows = rowsOf(content)
  if (!rows.some(row => row.name === '@deepseek-ai/dsh-persona')) {
    throw draftInvalid(preset.id, 'composition', ['@deepseek-ai/dsh-persona'])
  }
  const existingIds = new Set(rows.flatMap(row => typeof row.id === 'string' ? [row.id] : []))
  const nextRows = rows.map((row) => {
    const id = typeof row.id === 'string' ? row.id : undefined
    const next = { ...row }
    if (row.name === '@deepseek-ai/dsh-persona') {
      const config = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
        ? { ...(row.config as Record<string, unknown>) }
        : {}
      config.prefix = current.identityPrompt
      config.suffix = current.behaviorPrompt
      next.config = config
    }
    if (id !== undefined && id !== 'persona' && bindingOptions(rows).some(option => option.id === id)) {
      if (current.selectedPlugins.includes(id)) delete next.disabled
      else next.disabled = true
    }
    return next
  })
  for (const pluginId of current.selectedPlugins) {
    const registered = REGISTERED_PLUGIN_MODULES[pluginId]
    if (registered !== undefined && !existingIds.has(pluginId)) {
      nextRows.push({ id: pluginId, name: registered.name, config: { ...registered.config } })
    }
  }
  const nextContent = yaml.dump(nextRows, { lineWidth: -1, noRefs: true })
  const version = current.version + 1
  const publishedAt = new Date().toISOString()
  const fingerprint = fingerprintOf(nextContent)
  const versionRecord: AgentPresetVersion = { version, revision: current.revision, fingerprint, publishedAt }
  await mkdir(dirname(versionPath(preset, version)), { recursive: true, mode: 0o700 })
  await writeFileAtomic(versionPath(preset, version), nextContent, { mode: 0o600, dirMode: 0o700 })
  await writeFileAtomic(preset.path, nextContent, { mode: 0o600, dirMode: 0o700 })
  await writeFileAtomic(draftPath(preset), yaml.dump({
    identityPrompt: current.identityPrompt,
    behaviorPrompt: current.behaviorPrompt,
    selectedSkills: current.selectedSkills,
    selectedPlugins: current.selectedPlugins,
    workspaceBindings: current.workspaceBindings,
    version,
    publishedRevision: current.revision,
    history: [...current.history, versionRecord],
  } satisfies DraftFile, { lineWidth: -1 }), { mode: 0o600, dirMode: 0o700 })
  return { agentPreset: preset.id, version, revision: current.revision, fingerprint, publishedAt }
}

/**
 * Validate and inspect a draft without writing, mounting, calling an LLM, or
 * executing a tool. This is deliberately a catalog preview rather than a
 * second runtime: the later PMS end-to-end test owns real query/command flow.
 */
export async function testDraftDocument(
  preset: AgentPreset,
  input: AgentPresetDraftInput,
): Promise<AgentPresetTestResult> {
  const current = await readDraftDocument(preset)
  const normalized = validateInput(preset, input, current.availablePlugins, current.availableSkills)
  const availableTools = [...new Set(normalized.selectedPlugins.flatMap(id => PREVIEW_TOOLS[id] ?? []))]
  const blockedTools = [...new Set(normalized.selectedPlugins.flatMap(id => PREVIEW_BLOCKED_TOOLS[id] ?? []))]
  return {
    agentPreset: preset.id,
    revision: revisionOf(normalized),
    version: current.version,
    selectedSkills: normalized.selectedSkills,
    selectedPlugins: normalized.selectedPlugins,
    availableTools,
    blockedTools,
    message: '仅完成配置校验和工具目录预览，未挂载 Agent、未调用模型、未执行任何工具。',
  }
}

/**
 * Refuse one authoring request the deployment does not allow.
 * @param presetId - what the caller tried to change, for the diagnostic.
 * @param reason - why authoring is refused.
 * @returns the failure to throw.
 */
function notWritable(presetId: string, reason: string): RemoteError<'agent-preset/read-only'> {
  return new RemoteError(
    'agent-preset/read-only',
    `agent-presets: preset "${presetId}" cannot be written: ${reason}`,
    { agentPreset: presetId, reason },
  )
}

/**
 * Refuse a copy onto an id something already occupies. Both the roster check
 * and the on-disk check answer with it, so a taken id reads the same either way.
 * @param presetId - the id that is already taken.
 * @returns the failure to throw.
 */
export function presetExists(presetId: string): RemoteError<'agent-preset/invalid'> {
  const reason = `preset "${presetId}" already exists — `
    + 'a copy never overwrites; delete the existing preset first or choose another id'
  return new RemoteError('agent-preset/invalid', `agent-presets: ${reason}`, { agentPreset: presetId, reason })
}

/**
 * The root locally authored presets are written to.
 * @param roots - the configured roots in precedence order.
 * @param presetId - the preset the caller is authoring, named by the refusal.
 * @returns the absolute path of the first `user` root.
 * @throws when the deployment configured no writable root.
 */
export function writableRoot(roots: readonly PresetRoot[], presetId: string): string {
  const root = roots.find(candidate => candidate.trust === 'user')
  if (root === undefined) {
    throw notWritable(presetId, 'this deployment configures no user-writable preset root')
  }
  return resolve(expandHomePath(root.path))
}

/**
 * Read one preset's composition text.
 * @param preset - the resolved preset.
 * @returns the file's contents.
 */
export async function readComposition(preset: AgentPreset): Promise<string> {
  return await readFile(preset.path, 'utf8')
}

/** Whether anything occupies the path (cp's own errorOnExist backstops races). */
async function occupied(path: string): Promise<boolean> {
  let present = true
  try {
    await stat(path)
  } catch {
    // Every stat failure means the same thing here: nothing usable occupies
    // the path, so the copy may claim it.
    present = false
  }
  return present
}

/**
 * Re-tighten a copied tree to owner-only. A shipped preset is world-readable
 * in its install and `cp` preserves that; the copy carries the same weight as
 * the settings document beside it, so group/other access is stripped. A
 * file's owner-execute bit survives — a preset may ship runnable helpers.
 */
async function tightenModes(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await tightenModes(target)
    } else {
      /* v8 ignore next -- Windows exposes no POSIX owner-execute bit; the POSIX lane covers both file modes. */
      await chmod(target, ((await stat(target)).mode & 0o100) === 0 ? 0o600 : 0o700)
    }
  }
}

/**
 * Create a preset by copying an existing one's whole directory.
 *
 * The copy carries everything the source directory holds — composition,
 * metadata, skill directories, assets — because a preset is its directory,
 * not one file. Symlinks are dereferenced so the copy is self-contained
 * rather than a set of links back into the install it was copied from.
 *
 * The copied metadata is then rewritten: the source's description is kept
 * (the file is the author's to edit afterwards), but its name and roster
 * `order` are not — a copy presenting itself identically to its source, or
 * sorted into the shipped set's declared order, would make the roster stop
 * distinguishing them. With no name given and no description to keep, the
 * file is removed so the copy publishes nothing rather than a blank.
 * @param roots - the configured roots; the first `user` one receives the copy.
 * @param source - the resolved preset the copy starts from.
 * @param id - the new preset's id, which becomes its directory name.
 * @param name - display name for the copy; omitted falls back to the id.
 * @returns the absolute path of the new preset directory.
 * @throws when the id is unusable or already occupied on disk, or the
 * deployment configures no writable root.
 */
export async function copyComposition(
  roots: readonly PresetRoot[],
  source: AgentPreset,
  id: string,
  name?: string,
): Promise<string> {
  if (!PRESET_ID.test(id)) {
    const reason = `preset id ${JSON.stringify(id)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root'
    throw new RemoteError('agent-preset/invalid', `agent-presets: ${reason}`, { agentPreset: id, reason })
  }
  const dir = join(writableRoot(roots, id), id)
  // The roster check upstream only sees discovered presets; a directory with
  // no composition file still occupies the name and deserves a readable
  // refusal rather than a filesystem error code.
  if (await occupied(dir)) throw presetExists(id)
  try {
    await cp(dirname(source.path), dir, {
      recursive: true, dereference: true, force: false, errorOnExist: true,
    })
    await tightenModes(dir)
    const rendered = renderPresetMetadata({
      ...name === undefined ? {} : { name },
      ...source.description === undefined ? {} : { description: source.description },
    })
    const metadataPath = join(dir, METADATA_FILE)
    if (rendered === undefined) {
      await rm(metadataPath, { force: true })
    } else {
      await writeFileAtomic(metadataPath, rendered, { mode: 0o600, dirMode: 0o700 })
    }
  } catch (error) {
    // A half-copied directory would be invisible to discovery at best and a
    // mountable-but-incomplete preset at worst; a failed copy leaves nothing.
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * Delete a locally authored preset.
 *
 * A shipped preset is refused: it belongs to the deployment. A preset a live
 * session mounted is NOT refused — the composition was read at creation and is
 * never re-read, so that session keeps running exactly as it was.
 * @param roots - the configured roots.
 * @param preset - the resolved preset to remove.
 * @throws when the preset ships with the deployment or lies outside the writable root.
 */
export async function deleteComposition(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
): Promise<void> {
  if (preset.trust !== 'user') {
    throw notWritable(preset.id, 'it ships with the deployment')
  }
  const dir = join(writableRoot(roots, preset.id), preset.id)
  // Belt and braces over the id pattern: the resolved directory must still be
  // the one the writable root owns, whatever discovery reported.
  if (!isAbsolute(preset.path) || !preset.path.startsWith(dir)) {
    throw notWritable(preset.id, 'it does not live under the writable preset root')
  }
  await rm(dir, { recursive: true, force: true })
}
