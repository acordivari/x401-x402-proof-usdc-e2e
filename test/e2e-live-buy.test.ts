/**
 * Offline end-to-end for the LIVE BUYER: the same runLiveBuy flow that pays
 * real external x402 endpoints, exercised against the in-repo merchant with
 * the mock facilitator — preflight decode, guard evaluation, dry-run stop,
 * guarded payment, and the durable spend journal. No keys, no funds, no chain
 * (the balance reader is injected, per the swappable-seam doctrine).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { createMerchantApp, type MerchantApp } from "@agentic-payments/merchant";
import { BASE_SEPOLIA, dollarsToAtomic } from "@agentic-payments/shared";
import { runLiveBuy, LiveSpendJournal, type LiveBuyOptions } from "@agentic-payments/agent";

let merchant: MerchantApp;
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.WALLET_MODE = "local";
  process.env.AGENT_PRIVATE_KEY = generatePrivateKey();
  merchant = createMerchantApp({
    facilitatorMode: "mock",
    payTo: "0x000000000000000000000000000000000000dead",
  });
  await new Promise<void>((resolve) => {
    server = merchant.app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function options(overrides: Partial<LiveBuyOptions> = {}): LiveBuyOptions {
  return {
    url: `${base}/buy/allergy-relief-24`, // 1.50 USDC in the catalog
    network: BASE_SEPOLIA,
    maxPerCallUsdc: "2.00",
    budgetUsdc: "5.00",
    method: "GET",
    journalPath: join(mkdtempSync(join(tmpdir(), "live-buy-")), "spend.json"),
    execute: false,
    readBalance: async () => dollarsToAtomic("10.00"),
    ...overrides,
  };
}

describe("live buyer against the offline merchant (E2E)", () => {
  it("dry run decodes the quote, passes the guard, and pays nothing", async () => {
    const opts = options();
    expect(await runLiveBuy(opts)).toBe(0);
    expect(new LiveSpendJournal(opts.journalPath).entries()).toHaveLength(0);
    expect(merchant.orders.all()).toHaveLength(0);
  });

  it("refuses when the quote exceeds the per-call cap", async () => {
    const opts = options({ maxPerCallUsdc: "0.05", execute: true });
    expect(await runLiveBuy(opts)).toBe(1);
    expect(new LiveSpendJournal(opts.journalPath).entries()).toHaveLength(0);
  });

  it("refuses when the durable budget has no headroom", async () => {
    const opts = options({ execute: true });
    const journal = new LiveSpendJournal(opts.journalPath);
    journal.reserve({
      url: "https://elsewhere.test",
      network: BASE_SEPOLIA.caip2,
      amountAtomic: dollarsToAtomic("4.00").toString(),
      payTo: "0x000000000000000000000000000000000000dead",
    });
    expect(await runLiveBuy(opts)).toBe(1); // 1.50 > 5.00 - 4.00
  });

  it("refuses when the wallet balance cannot cover the price", async () => {
    const opts = options({
      execute: true,
      readBalance: async () => dollarsToAtomic("0.10"),
    });
    expect(await runLiveBuy(opts)).toBe(1);
  });

  it("pays with --yes: settles via x402 and records the spend as paid", async () => {
    const opts = options({ execute: true });
    expect(await runLiveBuy(opts)).toBe(0);

    const entries = new LiveSpendJournal(opts.journalPath).entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("paid");
    expect(entries[0]?.amountAtomic).toBe(dollarsToAtomic("1.50").toString());

    const orders = merchant.orders.all();
    expect(orders.length).toBeGreaterThan(0);
  });
});
