import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, dollarsToAtomic } from "@agentic-payments/shared";
import { LiveSpendJournal } from "../src/live/journal.ts";

const NET = BASE_SEPOLIA.caip2;

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), "live-journal-")), "spend.json");
}

function reserveCents(journal: LiveSpendJournal, cents: string) {
  return journal.reserve({
    url: "https://example.test/paid",
    network: NET,
    amountAtomic: dollarsToAtomic(cents).toString(),
    payTo: "0xcb6700f80203f2f6f0e0ea9ed464046fc7406bae",
  });
}

describe("LiveSpendJournal", () => {
  it("counts reservations and payments toward spend, but not failures", () => {
    const journal = new LiveSpendJournal(freshPath());
    const a = reserveCents(journal, "0.01"); // stays reserved
    const b = reserveCents(journal, "0.02");
    journal.commit(b.id, "0xabc");
    const c = reserveCents(journal, "0.04");
    journal.fail(c.id, "server 500, no receipt");

    expect(journal.spentAtomic(NET)).toBe(dollarsToAtomic("0.03"));
    expect(journal.remainingAtomic(dollarsToAtomic("0.10"), NET)).toBe(
      dollarsToAtomic("0.07"),
    );
    void a;
  });

  it("survives a restart (durable budget)", () => {
    const path = freshPath();
    const first = new LiveSpendJournal(path);
    const entry = reserveCents(first, "0.05");
    first.commit(entry.id, "0xdef");

    const reloaded = new LiveSpendJournal(path);
    expect(reloaded.spentAtomic(NET)).toBe(dollarsToAtomic("0.05"));
    expect(reloaded.entries()[0]?.txHash).toBe("0xdef");
  });

  it("floors remaining budget at zero", () => {
    const journal = new LiveSpendJournal(freshPath());
    reserveCents(journal, "0.05");
    expect(journal.remainingAtomic(dollarsToAtomic("0.01"), NET)).toBe(0n);
  });

  it("refuses to start from a corrupt journal instead of forgetting spend", () => {
    const path = freshPath();
    writeFileSync(path, "{not json");
    expect(() => new LiveSpendJournal(path)).toThrow();
  });

  it("scopes spend per network", () => {
    const journal = new LiveSpendJournal(freshPath());
    reserveCents(journal, "0.05");
    expect(journal.spentAtomic("eip155:8453")).toBe(0n);
  });

  it("writes valid JSON to disk (atomic persist)", () => {
    const path = freshPath();
    const journal = new LiveSpendJournal(path);
    reserveCents(journal, "0.01");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(1);
  });
});
