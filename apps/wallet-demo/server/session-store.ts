/**
 * Orchestrator session store — the swappable seam for where per-client session
 * state lives. The default is per-process in-memory (sessions vanish on restart);
 * the file store makes them DURABLE. Generic over the session shape (it only needs
 * `lastSeen` for idle eviction), so it doesn't couple to `ClientSession`.
 *
 * Methods are `T | Promise<T>` so the in-memory/file paths stay synchronous (the
 * middleware just `await`s the result) while a future external store (Redis/DB,
 * for multi-instance sharing) can be async — same convention as `SpendLedger`.
 *
 * NOTE: durability across a restart also needs a STABLE cookie signing secret
 * (`DEMO_SESSION_SECRET`); with the local random-per-boot secret the data persists
 * but the old signed cookies won't verify.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface SessionStore<T extends { lastSeen: number }> {
  get(sid: string): (T | undefined) | Promise<T | undefined>;
  set(sid: string, session: T): void | Promise<void>;
  delete(sid: string): void | Promise<void>;
  /** Evict sessions idle longer than `maxAgeMs`. */
  sweep(maxAgeMs: number): void | Promise<void>;
}

/** Per-process, non-durable (the default). */
export class InMemorySessionStore<T extends { lastSeen: number }> implements SessionStore<T> {
  protected readonly sessions = new Map<string, T>();

  get(sid: string): T | undefined {
    return this.sessions.get(sid);
  }
  set(sid: string, session: T): void {
    this.sessions.set(sid, session);
  }
  delete(sid: string): void {
    this.sessions.delete(sid);
  }
  sweep(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [sid, s] of this.sessions) if (s.lastSeen < cutoff) this.sessions.delete(sid);
  }
}

/**
 * Durable store: all sessions are kept in memory and the whole set is persisted to
 * a JSON file on every mutation, reloaded on construct. Sessions survive a restart.
 */
export class FileSessionStore<T extends { lastSeen: number }> extends InMemorySessionStore<T> {
  constructor(private readonly filePath: string) {
    super();
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, T>;
      for (const [sid, session] of Object.entries(raw)) this.sessions.set(sid, session);
    } catch {
      /* no file yet — start empty */
    }
  }

  override set(sid: string, session: T): void {
    super.set(sid, session);
    this.persist();
  }
  override delete(sid: string): void {
    super.delete(sid);
    this.persist();
  }
  override sweep(maxAgeMs: number): void {
    const before = this.sessions.size;
    super.sweep(maxAgeMs);
    if (this.sessions.size !== before) this.persist();
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.sessions)));
  }
}
