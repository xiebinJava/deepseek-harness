/** Client-safe payloads and event declarations owned by the agent-preset domain. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PresetTrust } from './preset.ts'

export type { PresetTrust } from './preset.ts'

/**
 * One roster row as a client reads it. Path-free: a preset is addressed by id
 * everywhere off the Host, and the composition's location is the Host's own.
 */
export interface AgentPresetRow {
  /** Stable identifier; also the label's fallback. */
  readonly id: string
  /** Trust of the root this preset was discovered under. */
  readonly trust: PresetTrust
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Display name the preset published. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
  /** Workspace types this preset is intended for; absent means generic. */
  readonly workspaceTypes?: readonly string[]
  /** Capability labels published by the preset. */
  readonly capabilities?: readonly string[]
  /** Whether the published preset can be selected for new sessions. */
  readonly enabled?: boolean
  /** Why this preset cannot compose a session; absent when it can. */
  readonly broken?: string
}

/** The roster one deployment currently supplies, with its authoring capability. */
export interface AgentPresetRoster {
  /** Every preset the configured roots supply, first-root-wins per id. */
  readonly presets: readonly AgentPresetRow[]
  /** Whether this deployment has a root locally authored presets go to. */
  readonly authorable: boolean
  /** Whether visible mode selection is enabled for unnamed new sessions. */
  readonly modeSelectionEnabled: boolean
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No configured root supplies the requested id. */
    'agent-preset/not-found': { readonly agentPreset: string; readonly available: readonly string[] }
    /** The id is unusable, already taken, or its composition cannot be installed. */
    'agent-preset/invalid': { readonly agentPreset: string; readonly reason: string }
    /** The preset is discovered but explicitly disabled by its publisher. */
    'agent-preset/disabled': { readonly agentPreset: string }
    /** The preset ships with the deployment and is not the user's to change. */
    'agent-preset/read-only': { readonly agentPreset: string; readonly reason: string }
    /** The session's conversation has started, so its composition is fixed. */
    'agent-preset/locked': { readonly sessionId: SessionId; readonly agentPreset: string }
    /** A resumed Session would run a different composition than its log records. */
    'agent-preset/composition-conflict': {
      readonly sessionId: SessionId
      readonly agentPreset: string
      readonly requestedFingerprint: string
      readonly existingFingerprint: string
    }
    /** Another editor saved the preset after this editor loaded it. */
    'agent-preset/draft-conflict': {
      readonly agentPreset: string
      readonly expectedRevision: string
      readonly actualRevision: string
    }
    /** The draft names a binding that is not in the host-owned catalog. */
    'agent-preset/draft-invalid': {
      readonly agentPreset: string
      readonly field: string
      readonly values: readonly string[]
    }
  }
}

/** One preset's composition text beside the row it belongs to. */
export interface AgentPresetDocument {
  /** The preset the composition belongs to. */
  readonly agentPreset: string
  /** Trust of the root this preset was discovered under. */
  readonly trust: PresetTrust
  /** The composition exactly as stored. */
  readonly content: string
  /** Display name the preset published. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
  /** Workspace types this preset is intended for; absent means generic. */
  readonly workspaceTypes?: readonly string[]
  /** Capability labels published by the preset. */
  readonly capabilities?: readonly string[]
  /** Whether the published preset can be selected for new sessions. */
  readonly enabled?: boolean
}

/** A safe binding option exposed by the Agent editor. */
export interface AgentPresetBindingOption {
  /** Stable catalog id; never a module path. */
  readonly id: string
  /** Human-facing label. */
  readonly label: string
  /** Short explanation shown beside the checkbox. */
  readonly description?: string
}

/** User-editable fields accepted by the Agent editor. */
export interface AgentPresetDraftInput {
  /** The Agent's identity: who it is and what it owns. */
  readonly identityPrompt: string
  /** The Agent's operating procedure: how it should work. */
  readonly behaviorPrompt: string
  /** Registered Skill ids enabled for this composition. */
  readonly selectedSkills: readonly string[]
  /** Registered plugin/entry ids enabled for this composition. */
  readonly selectedPlugins: readonly string[]
  /** Workspace ids this Agent may be offered in. */
  readonly workspaceBindings: readonly string[]
}

/** One immutable published composition record. */
export interface AgentPresetVersion {
  readonly version: number
  readonly revision: string
  readonly fingerprint: string
  readonly publishedAt: string
}

/** Draft plus the catalogs needed to render the editor. */
export interface AgentPresetDraft extends AgentPresetDraftInput {
  readonly agentPreset: string
  /** Hash of the current draft, used for optimistic concurrency. */
  readonly revision: string
  /** Revision last published, when this preset has a published draft. */
  readonly publishedRevision?: string
  /** Monotonic published version, zero before the first publish. */
  readonly version: number
  readonly availableSkills: readonly AgentPresetBindingOption[]
  readonly availablePlugins: readonly AgentPresetBindingOption[]
  readonly availableWorkspaces: readonly AgentPresetBindingOption[]
  readonly history: readonly AgentPresetVersion[]
}

/** Result returned after a draft becomes the active composition. */
export interface AgentPresetPublishResult {
  readonly agentPreset: string
  readonly version: number
  readonly revision: string
  readonly fingerprint: string
  readonly publishedAt: string
}

/** Read-only result for testing a draft without mounting or executing it. */
export interface AgentPresetTestResult {
  readonly agentPreset: string
  readonly revision: string
  readonly version: number
  readonly selectedSkills: readonly string[]
  readonly selectedPlugins: readonly string[]
  /** Tools that the draft may expose in a read-only preview scope. */
  readonly availableTools: readonly string[]
  /** Tools deliberately blocked in the preview scope. */
  readonly blockedTools: readonly string[]
  readonly message: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentPreset: string | null
    agentCompositionFingerprint: string | null
  }
  interface SessionProjectionMap {
    /** Preset the Session runs, or null when the deployment composes none. */
    agentPreset: string | null
    /** SHA-256 identity of the exact composition generation the Session runs. */
    agentCompositionFingerprint: string | null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One session committed a different agent preset to its durable log.
     * Consumers invalidate only state derived from that session's composition.
     * @mode emit
     * @param sessionId - the session whose composition changed.
     * @param agentPreset - the preset recorded by the committed selection.
     */
    'agent-preset/selected'(
      sessionId: SessionId,
      agentPreset: string,
      agentCompositionFingerprint?: string,
    ): void
  }
}

export {}
