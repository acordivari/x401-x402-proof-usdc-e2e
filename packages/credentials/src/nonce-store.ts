/**
 * Single-use OID4VP nonces — the replay gate of a current x401 verifier.
 *
 * The July build sealed an encrypted, authenticated challenge into the nonce
 * and re-derived everything from it, because the SDK of the time shipped no
 * nonce handling at all. Proof's guidance is now simpler and stricter: mint a
 * random nonce per PROOF-REQUEST, remember it, and accept it exactly once
 * (`getNonce()` on the verified credential must find and delete it). The
 * interface below is the shape Proof's own Workers library uses, so a shared
 * store (KV/D1/Redis) drops in without touching callers.
 */
export interface NonceStore {
  /** Mint and remember a fresh nonce (≥16 chars, cryptographically random). */
  mint(): Promise<string>;
  /** True exactly once per minted, unexpired nonce; consumes it. */
  verify(nonce: string): Promise<boolean>;
}

export interface InMemoryNonceStoreOptions {
  /** How long an unanswered nonce stays acceptable. Default 10 minutes. */
  ttlMs?: number;
  /** Bound on outstanding nonces; the oldest are dropped past it. */
  maxOutstanding?: number;
  now?: () => number;
}

/** Process-local store: fine for one instance, not for a fleet. */
export class InMemoryNonceStore implements NonceStore {
  private readonly issued = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: InMemoryNonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.max = opts.maxOutstanding ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  async mint(): Promise<string> {
    this.sweep();
    const nonce = crypto.randomUUID();
    this.issued.set(nonce, this.now() + this.ttlMs);
    while (this.issued.size > this.max) {
      const oldest = this.issued.keys().next().value as string;
      this.issued.delete(oldest);
    }
    return nonce;
  }

  async verify(nonce: string): Promise<boolean> {
    const expiresAt = this.issued.get(nonce);
    if (expiresAt === undefined) return false;
    this.issued.delete(nonce); // consumed whether or not it is still fresh
    return this.now() < expiresAt;
  }

  /** Outstanding (minted, unconsumed, unexpired) nonces — for tests and status. */
  get size(): number {
    this.sweep();
    return this.issued.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [n, exp] of this.issued) if (t >= exp) this.issued.delete(n);
  }
}
