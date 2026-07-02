/**
 * File-durable spend journal for the live buyer — the wallet-side analogue of
 * the merchant's SpendLedger. Every attempted payment is recorded BEFORE the
 * client signs (reserve), then marked paid/failed. Cumulative-budget checks
 * count reservations and payments, so a crash mid-payment over-counts and can
 * never let the agent spend past its budget (same fail-safe direction as the
 * merchant ledger's commit/release).
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt
 * the journal; an unreadable existing journal is a hard error, not an empty
 * start — silently forgetting past spend would defeat the budget.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  id: string;
  at: string; // ISO timestamp
  url: string;
  network: string; // CAIP-2
  amountAtomic: string;
  payTo: string;
  status: "reserved" | "paid" | "failed";
  txHash?: string;
  note?: string;
}

export class LiveSpendJournal {
  private items: JournalEntry[];

  constructor(private readonly filePath: string) {
    this.items = this.load();
  }

  private load(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(
        `spend journal ${this.filePath} exists but cannot be read: ${(err as Error).message}`,
      );
    }
    const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
    if (!Array.isArray(parsed.entries)) {
      throw new Error(`spend journal ${this.filePath} is malformed (no entries array)`);
    }
    return parsed.entries;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: this.items }, null, 2));
    renameSync(tmp, this.filePath);
  }

  entries(): readonly JournalEntry[] {
    return this.items;
  }

  /** Cumulative spend on a network: reservations + payments (never failed). */
  spentAtomic(network: string): bigint {
    return this.items
      .filter((e) => e.network === network && e.status !== "failed")
      .reduce((acc, e) => acc + BigInt(e.amountAtomic), 0n);
  }

  /** Budget headroom left on a network under `capAtomic` (floor 0). */
  remainingAtomic(capAtomic: bigint, network: string): bigint {
    const left = capAtomic - this.spentAtomic(network);
    return left > 0n ? left : 0n;
  }

  reserve(
    entry: Omit<JournalEntry, "id" | "at" | "status">,
  ): JournalEntry {
    const record: JournalEntry = {
      ...entry,
      id: randomUUID(),
      at: new Date().toISOString(),
      status: "reserved",
    };
    this.items.push(record);
    this.persist();
    return record;
  }

  commit(id: string, txHash?: string): void {
    this.update(id, { status: "paid", txHash });
  }

  fail(id: string, note: string): void {
    this.update(id, { status: "failed", note });
  }

  private update(id: string, patch: Partial<JournalEntry>): void {
    const entry = this.items.find((e) => e.id === id);
    if (!entry) throw new Error(`journal entry ${id} not found`);
    Object.assign(entry, patch);
    this.persist();
  }
}
