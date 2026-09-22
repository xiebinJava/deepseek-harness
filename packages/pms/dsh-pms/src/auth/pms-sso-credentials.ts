import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { PmsCredentialProvider } from '../client/PmsIntegrationClient.ts'
import { PmsCredentialStore, type PmsSsoCredential } from './pms-credential-store.ts'
import {
  PmsSsoError,
  exchangePmsSsoSession,
  refreshPmsSsoSession,
  revokePmsSsoSession,
  type PmsSsoSessionOptions,
} from './pms-sso-session.ts'

/** The SSO identity DSH proved for the current browser session, if any. */
export interface BrowserIdentityLike {
  idToken(): string | undefined
  identity?(): { subject: string; email?: string } | undefined
}

export interface PmsSsoCredentialsOptions extends PmsSsoSessionOptions {
  credentials?: CredentialProvider
  identity?: BrowserIdentityLike
}

/**
 * Keeps DSH holding one PMS session for the signed-in person:
 * - acquire it from the verified SSO ID token (no embedded PMS page needed),
 * - persist it so a browser refresh or DSH restart does not drop the binding,
 * - rotate it when PMS rejects it, and drop it when it cannot be recovered,
 * - never hand one person's session to a different SSO subject.
 */
export class PmsSsoCredentials implements PmsCredentialProvider {
  private readonly store: PmsCredentialStore
  private inflight: Promise<PmsSsoCredential | undefined> | undefined
  /** Last acquired session, so a deployment without a credential store still holds it. */
  private held: PmsSsoCredential | undefined
  /**
   * ID token whose PMS session was explicitly revoked. While the same SSO login
   * is still in use the assistant must stay signed out instead of silently
   * minting a replacement session — that is what "log out of PMS, DSH follows"
   * means. A new SSO login (a different token) clears it.
   */
  private revokedIdToken: string | undefined

  constructor(private readonly options: PmsSsoCredentialsOptions) {
    this.store = new PmsCredentialStore(options.credentials)
  }

  get persistent(): boolean {
    return this.store.available
  }

  async accessToken(): Promise<string | undefined> {
    const credential = await this.current()
    return credential?.accessToken
  }

  async refresh(): Promise<string | undefined> {
    const held = await this.store.read() ?? this.held
    const rotated = held === undefined ? undefined : await this.rotate(held)
    return rotated?.accessToken ?? (await this.acquire(true))?.accessToken
  }

  /** Explicit sign-out: stop using this SSO login and revoke the PMS session. */
  async clear(): Promise<void> {
    const held = await this.store.read()
    this.suspendForCurrentLogin()
    if (held !== undefined) {
      await revokePmsSsoSession(this.options, held).catch(() => undefined)
      await this.store.clear()
    }
    this.inflight = undefined
  }

  /** PMS rejected the held session: stop supplying tokens for this SSO login. */
  async suspend(): Promise<void> {
    this.suspendForCurrentLogin()
    this.held = undefined
    await this.store.clear()
    this.inflight = undefined
  }

  private suspendForCurrentLogin(): void {
    this.revokedIdToken = this.options.identity?.idToken?.()
  }

  private async current(): Promise<PmsSsoCredential | undefined> {
    const held = await this.store.read() ?? this.held
    const subject = this.options.identity?.identity?.()?.subject
    if (held !== undefined) {
      // Another person signed in to DSH: never reuse the previous session.
      if (subject !== undefined && held.subject !== subject) {
        this.held = undefined
        await this.store.clear()
      } else if (held.expiresAt > Date.now()) {
        return held
      } else {
        // Rotate the held session first: the SSO ID token may already be gone.
        return (await this.rotate(held)) ?? this.acquire(true)
      }
    }
    return this.acquire(false)
  }

  /** Rotates one held session; returns `undefined` once PMS refuses it. */
  private async rotate(held: PmsSsoCredential): Promise<PmsSsoCredential | undefined> {
    try {
      const rotated = await refreshPmsSsoSession(this.options, held)
      this.held = rotated
      await this.store.write(() => rotated)
      return rotated
    } catch (error) {
      // Revoked (the user logged out of PMS) or expired: forget it, and do not
      // silently replace a revoked session while the same SSO login is in use.
      if (error instanceof PmsSsoError && (error.status === 401 || error.status === 403)) {
        this.suspendForCurrentLogin()
      }
      this.held = undefined
      await this.store.clear()
      return undefined
    }
  }

  /** Acquires once at a time so concurrent tools never mint two PMS sessions. */
  private acquire(force: boolean): Promise<PmsSsoCredential | undefined> {
    const pending = this.inflight
    if (pending !== undefined && !force) return pending
    const attempt = (async (): Promise<PmsSsoCredential | undefined> => {
      const identity = this.options.identity?.identity?.()
      const idToken = this.options.identity?.idToken?.()
      if (identity === undefined || idToken === undefined || idToken === '') return undefined
      if (idToken === this.revokedIdToken) return undefined
      const credential = await exchangePmsSsoSession(this.options, idToken, identity.subject)
      this.held = credential
      await this.store.write(() => credential)
      return credential
    })().finally(() => {
      if (this.inflight === attempt) this.inflight = undefined
    })
    this.inflight = attempt
    return attempt
  }
}
