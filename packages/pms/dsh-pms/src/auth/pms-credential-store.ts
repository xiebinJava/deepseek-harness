import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'

/**
 * The PMS session DSH holds on behalf of the signed-in person. It survives DSH
 * restarts (the credentials provider is a file) and dies when PMS revokes the
 * session, which is what makes "log out of PMS, the assistant stops working"
 * true without any extra signalling.
 */
export interface PmsSsoCredential {
  readonly version: 1
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  /** SSO subject the credential was minted for, so another user never reuses it. */
  readonly subject: string
  readonly userId?: number
  readonly email?: string
}

const RECORD_KEY = credentialKey('dsh-pms', 'sso-session')
const VERSION = 1

export class PmsCredentialStore {
  constructor(private readonly credentials: CredentialProvider | undefined) {}

  get available(): boolean {
    return this.credentials !== undefined
  }

  async read(): Promise<PmsSsoCredential | undefined> {
    if (this.credentials === undefined) return undefined
    const record = await this.credentials.readRecord(RECORD_KEY)
    return parse(payloadOf(record))
  }

  /** Serialized read-modify-write so two refreshes cannot rotate the token twice. */
  async write(
    replace: (current: PmsSsoCredential | undefined) => PmsSsoCredential | undefined,
  ): Promise<PmsSsoCredential | undefined> {
    if (this.credentials === undefined) return undefined
    const record = await this.credentials.modifyRecord(RECORD_KEY, async (current) => {
      const existing = parse(payloadOf(current))
      const next = replace(existing)
      if (next === undefined) return undefined
      return { kind: 'grant', payload: next }
    })
    return parse(payloadOf(record))
  }

  async clear(): Promise<void> {
    await this.credentials?.deleteRecord(RECORD_KEY)
  }
}

/** Only a grant record carries an owner-defined payload. */
function payloadOf(record: CredentialRecord | undefined): unknown {
  return record !== undefined && record.kind === 'grant' ? record.payload : undefined
}

function parse(payload: unknown): PmsSsoCredential | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = payload as Partial<PmsSsoCredential>
  if (value.version !== VERSION) return undefined
  if (typeof value.accessToken !== 'string' || value.accessToken === '') return undefined
  if (typeof value.refreshToken !== 'string' || value.refreshToken === '') return undefined
  if (typeof value.subject !== 'string' || value.subject === '') return undefined
  return {
    version: VERSION,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : 0,
    subject: value.subject,
    ...(typeof value.userId === 'number' ? { userId: value.userId } : {}),
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
  }
}
