/**
 * Offline end-to-end for the MANDATE-BOUND live buyer: a human "presents once"
 * (the same x401 local-credential flow as the delegated demo) to sign a
 * durable, scoped IntentMandate; the live buyer then enforces it wallet-side
 * against the in-repo merchant — signature, payee allowlist, cumulative cap,
 * expiry, and wallet binding — with no HAM support needed from the merchant.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMerchantApp, type MerchantApp } from "@agentic-payments/merchant";
import { BASE_SEPOLIA, dollarsToAtomic } from "@agentic-payments/shared";
import {
  issueLiveGrant,
  runLiveBuy,
  verifyMandateGrant,
  LiveSpendJournal,
  type LiveBuyOptions,
  type LiveMandateFile,
} from "@agentic-payments/agent";

const MERCHANT_PAY_TO = "0x000000000000000000000000000000000000dead" as const;

let merchant: MerchantApp;
let server: Server;
let base: string;
let agentWallet: `0x${string}`;
let grant: LiveMandateFile;

function grantPath(g: LiveMandateFile): string {
  const p = join(mkdtempSync(join(tmpdir(), "live-mandate-")), "mandate.json");
  writeFileSync(p, JSON.stringify(g));
  return p;
}

function options(overrides: Partial<LiveBuyOptions> = {}): LiveBuyOptions {
  return {
    url: `${base}/buy/ibuprofen-200`, // 0.75 USDC in the catalog
    network: BASE_SEPOLIA,
    maxPerCallUsdc: "2.00",
    budgetUsdc: "50.00", // flag budget out of the way: the MANDATE is the cap under test
    method: "GET",
    journalPath: join(mkdtempSync(join(tmpdir(), "live-buy-")), "spend.json"),
    execute: true,
    readBalance: async () => dollarsToAtomic("100.00"),
    mandatePath: grantPath(grant),
    ...overrides,
  };
}

beforeAll(async () => {
  const key = generatePrivateKey();
  agentWallet = privateKeyToAccount(key).address.toLowerCase() as `0x${string}`;
  process.env.WALLET_MODE = "local";
  process.env.AGENT_PRIVATE_KEY = key;

  merchant = createMerchantApp({ facilitatorMode: "mock", payTo: MERCHANT_PAY_TO });
  await new Promise<void>((resolve) => {
    server = merchant.app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The human presents once: a 2.00 USDC standing grant for this payee + wallet.
  grant = await issueLiveGrant({
    merchantAllowlist: [MERCHANT_PAY_TO],
    budgetUsdc: "2.00",
    ttlSeconds: 3600,
    network: BASE_SEPOLIA,
    holder: "andrew@example.com",
    agentWallet,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("mandate-bound live buyer (offline E2E)", () => {
  it("issues a signed, verifiable standing mandate from the x401 presentation", async () => {
    expect(grant.intent.proof?.signature).toBeTruthy();
    expect(grant.intent.principal.verifiedVia).toBe("x401-vp");
    expect(grant.intent.principal.email).toBe("andrew@example.com");
    expect(grant.intent.agentWallet).toBe(agentWallet);
    const check = await verifyMandateGrant({ grant, agentWallet, network: BASE_SEPOLIA.caip2 });
    expect(check.ok).toBe(true);
  });

  it("pays under the mandate and charges the spend against it", async () => {
    const opts = options();
    expect(await runLiveBuy(opts)).toBe(0);
    const entries = new LiveSpendJournal(opts.journalPath).entries();
    expect(entries[0]?.status).toBe("paid");
    expect(entries[0]?.mandateId).toBe(grant.intent.id);
  });

  it("refuses a payee that is not on the mandate allowlist", async () => {
    const other = await issueLiveGrant({
      merchantAllowlist: ["0x1111111111111111111111111111111111111111"],
      budgetUsdc: "2.00",
      ttlSeconds: 3600,
      network: BASE_SEPOLIA,
      holder: "andrew@example.com",
      agentWallet,
    });
    // The merchant's quote pays MERCHANT_PAY_TO, which this mandate does not allow.
    expect(await runLiveBuy(options({ mandatePath: grantPath(other) }))).toBe(1);
  });

  it("refuses once cumulative spend would exceed the mandate cap", async () => {
    const opts = options();
    // Pre-charge 1.50 against the mandate in the journal; 0.75 more won't fit in 2.00.
    new LiveSpendJournal(opts.journalPath).reserve({
      url: `${base}/buy/allergy-relief-24`,
      network: BASE_SEPOLIA.caip2,
      amountAtomic: dollarsToAtomic("1.50").toString(),
      payTo: MERCHANT_PAY_TO,
      mandateId: grant.intent.id,
    });
    expect(await runLiveBuy(opts)).toBe(1);
  });

  it("refuses a tampered mandate (signature no longer verifies)", async () => {
    const tampered: LiveMandateFile = structuredClone(grant);
    tampered.intent.scope.maxAmount = dollarsToAtomic("1000.00").toString();
    expect(await runLiveBuy(options({ mandatePath: grantPath(tampered) }))).toBe(1);
  });

  it("refuses an expired mandate", async () => {
    const expired: LiveMandateFile = structuredClone(grant);
    const check = await verifyMandateGrant({
      grant: expired,
      now: expired.intent.expiresAt + 1,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.violations.join()).toMatch(/expired/);
  });

  it("refuses when the mandate binds a different agent wallet", async () => {
    const otherWallet = privateKeyToAccount(generatePrivateKey())
      .address.toLowerCase() as `0x${string}`;
    const foreign = await issueLiveGrant({
      merchantAllowlist: [MERCHANT_PAY_TO],
      budgetUsdc: "2.00",
      ttlSeconds: 3600,
      network: BASE_SEPOLIA,
      holder: "andrew@example.com",
      agentWallet: otherWallet,
    });
    expect(await runLiveBuy(options({ mandatePath: grantPath(foreign) }))).toBe(1);
  });

  it("refuses a mandate granted for a different network", async () => {
    const check = await verifyMandateGrant({ grant, network: "eip155:8453" });
    expect(check.ok).toBe(false);
  });
});
