import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-pms',
  ['lib/types/index.js'],
  { hostPhase: true },
)
