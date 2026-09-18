/**
 * The session-log record of which preset a session actually runs.
 *
 * The creation header names the preset a session STARTED with, and it is
 * deep-frozen because that is a creation fact. A session may still change
 * preset while it is blank, and the effect of that change outlives the blank
 * window: the first turn — and every turn after it — runs under the newly
 * mounted composition. Recording the change is what keeps the log honest, and
 * it is required outright by the repo's model-visible ⟺ logged rule, since the
 * preset decides the tool schemas and prompt sections the model sees.
 *
 * Reconstruction reads the `agentPreset` Session projection, never the header
 * alone.
 * @module @deepseek-ai/dsh-agent-presets/session
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's agent preset was chosen after creation, while the session
     * was still blank. Log-only: it records the composition later turns ran
     * under, so a resumed or forked session rebuilds the same one instead of
     * the header's creation-time value.
     */
    'agent-preset/selected': {
      agentPreset: string
      /** SHA-256 identity of the exact composition mounted for this session. */
      agentCompositionFingerprint?: string
    }
  }
}

const agentPresetSchema = z.union([z.string(), z.null()])

/** Current Session preset, initialized from its header and advanced by selection events. */
export const agentPresetProjectionDefinition = {
  key: 'agentPreset',
  stateSchema: agentPresetSchema,
  init: header => header.agentPreset ?? null,
  apply: (state, event) => event.type === 'agent-preset/selected'
    ? event.data.agentPreset
    : state,
  wire: { viewSchema: agentPresetSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'agentPreset', string | null>

const agentCompositionFingerprintSchema = z.union([z.string(), z.null()])

/** Exact mounted composition identity for the current Session Agent. */
export const agentCompositionFingerprintProjectionDefinition = {
  key: 'agentCompositionFingerprint',
  stateSchema: agentCompositionFingerprintSchema,
  init: () => null,
  apply: (state, event) => event.type === 'agent-preset/selected'
    // A legacy selection event identifies a new Agent but not its exact
    // composition. Carrying the previous Agent's fingerprint would make a
    // mixed-version switch look reproducible when it is not.
    ? event.data.agentCompositionFingerprint ?? null
    : state,
  wire: {
    viewSchema: agentCompositionFingerprintSchema,
    view: state => state,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'agentCompositionFingerprint', string | null>
