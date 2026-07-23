import { describe, expect, it } from "vitest";
import {
  CartMandate,
  IntentMandate,
  buildAgentDid,
  parseAgentDid,
  validateCartAgainstIntent,
  validatePayerAgainstIntent,
  validatePaymentAgainstCart,
} from "../src/mandates.ts";
import {
  AGENT_WALLET,
  cart,
  intent,
  NOW,
  OTHER_MERCHANT,
  paymentMandate,
} from "./fixtures.ts";

describe("validateCartAgainstIntent (Cart ⊆ Intent)", () => {
  it("accepts a cart within scope, cap, and time window", () => {
    expect(validateCartAgainstIntent(cart(), intent(), NOW)).toEqual({ ok: true });
  });

  it("rejects a cart bound to a different intent", () => {
    const res = validateCartAgainstIntent(
      cart({ intentId: "99999999-9999-4999-8999-999999999999" }),
      intent(),
      NOW,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/not bound to this intent/);
  });

  it("rejects a merchant not on the allowlist", () => {
    const res = validateCartAgainstIntent(cart({ merchant: OTHER_MERCHANT }), intent(), NOW);
    expect(res.ok === false && res.violations.join()).toMatch(/not on the intent allowlist/);
  });

  it("rejects a disallowed item category", () => {
    const res = validateCartAgainstIntent(
      cart({
        items: [
          {
            sku: "sku-soda",
            name: "Cola 12pk",
            category: "beverages",
            unitPrice: "1500000",
            quantity: 1,
          },
        ],
      }),
      intent(),
      NOW,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/categories not authorized/);
  });

  it("rejects a cart total over the intent cap", () => {
    const res = validateCartAgainstIntent(
      cart({
        items: [
          {
            sku: "sku-bulk",
            name: "Bulk pack",
            category: "otc-medicine",
            unitPrice: "6000000",
            quantity: 1,
          },
        ],
        total: "6000000",
      }),
      intent(),
      NOW,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/exceeds intent cap/);
  });

  it("rejects an inconsistent total (does not match line items)", () => {
    const res = validateCartAgainstIntent(cart({ total: "1400000" }), intent(), NOW);
    expect(res.ok === false && res.violations.join()).toMatch(/does not equal sum of items/);
  });

  it("rejects an expired intent", () => {
    const res = validateCartAgainstIntent(cart(), intent({ expiresAt: NOW - 1 }), NOW);
    expect(res.ok === false && res.violations.join()).toMatch(/expired/);
  });

  it("sums multi-line, multi-quantity carts correctly", () => {
    const res = validateCartAgainstIntent(
      cart({
        items: [
          { sku: "a", name: "A", category: "vitamins", unitPrice: "1000000", quantity: 2 },
          { sku: "b", name: "B", category: "otc-medicine", unitPrice: "500000", quantity: 1 },
        ],
        total: "2500000",
      }),
      intent(),
      NOW,
    );
    expect(res).toEqual({ ok: true });
  });
});

describe("validatePaymentAgainstCart (Payment ⊆ Cart)", () => {
  it("accepts a payment that pays the cart merchant the cart total", () => {
    expect(validatePaymentAgainstCart(paymentMandate(), cart())).toEqual({ ok: true });
  });

  it("rejects a payment bound to a different cart", () => {
    const res = validatePaymentAgainstCart(
      paymentMandate({ cartId: "00000000-0000-4000-8000-000000000000" }),
      cart(),
    );
    expect(res.ok === false && res.violations.join()).toMatch(/not bound to this cart/);
  });

  it("rejects a payment amount that does not equal the cart total", () => {
    const res = validatePaymentAgainstCart(paymentMandate({ amount: "1400000" }), cart());
    expect(res.ok === false && res.violations.join()).toMatch(/does not equal cart total/);
  });

  it("rejects paying a different recipient than the cart merchant", () => {
    const res = validatePaymentAgainstCart(paymentMandate({ payTo: OTHER_MERCHANT }), cart());
    expect(res.ok === false && res.violations.join()).toMatch(/does not match cart merchant/);
  });
});

describe("did:pkh Agent Identifiers (x401 PR #17)", () => {
  it("builds and parses round-trip, normalizing the address to lowercase", () => {
    const did = buildAgentDid("eip155:84532", "0xAbCd000000000000000000000000000000000001");
    expect(did).toBe("did:pkh:eip155:84532:0xabcd000000000000000000000000000000000001");
    expect(parseAgentDid(did)).toEqual({
      network: "eip155:84532",
      address: "0xabcd000000000000000000000000000000000001",
    });
  });

  it("refuses malformed identifiers", () => {
    expect(parseAgentDid("did:agent:0x" + "11".repeat(20))).toBeUndefined();
    expect(parseAgentDid("did:pkh:eip155:84532:0x1234")).toBeUndefined();
    expect(parseAgentDid("did:pkh:solana:0x" + "11".repeat(20))).toBeUndefined();
  });
});

describe("validatePayerAgainstIntent (Payer ⊆ Intent, pre-settlement)", () => {
  const NETWORK = "eip155:84532" as const;
  const bound = intent({ agentId: buildAgentDid(NETWORK, AGENT_WALLET) });

  it("accepts the authorized wallet on the bound chain", () => {
    expect(validatePayerAgainstIntent({ address: AGENT_WALLET, network: NETWORK }, bound).ok).toBe(true);
  });

  it("is case-insensitive on the payer address", () => {
    const wallet = "0xabcdef0000000000000000000000000000000abc" as const;
    const b = intent({ agentWallet: wallet, agentId: buildAgentDid(NETWORK, wallet) });
    const res = validatePayerAgainstIntent(
      { address: "0xABCDEF0000000000000000000000000000000ABC", network: NETWORK },
      b,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a different wallet with payer_agent_mismatch", () => {
    const res = validatePayerAgainstIntent({ address: OTHER_MERCHANT, network: NETWORK }, bound);
    expect(res.ok === false && res.violations.join()).toMatch(/payer_agent_mismatch/);
  });

  it("rejects the right wallet on the wrong chain — the chain id is part of the identity", () => {
    const mainnetBound = intent({ agentId: buildAgentDid("eip155:1", AGENT_WALLET) });
    const res = validatePayerAgainstIntent({ address: AGENT_WALLET, network: NETWORK }, mainnetBound);
    expect(res.ok === false && res.violations.join()).toMatch(/payer_agent_mismatch/);
  });

  it("fails closed on an unreadable agentId binding", () => {
    const malformed = { ...intent(), agentId: "did:agent:not-a-pkh" };
    const res = validatePayerAgainstIntent({ address: AGENT_WALLET, network: NETWORK }, malformed);
    expect(res.ok === false && res.violations.join()).toMatch(/not a valid did:pkh/);
  });

  it("still enforces the bare wallet binding on legacy intents without agentId", () => {
    const legacy = intent(); // no agentId
    expect(validatePayerAgainstIntent({ address: AGENT_WALLET, network: NETWORK }, legacy).ok).toBe(true);
    const res = validatePayerAgainstIntent({ address: OTHER_MERCHANT, network: NETWORK }, legacy);
    expect(res.ok === false && res.violations.join()).toMatch(/payer_agent_mismatch/);
  });
});

describe("mandate schema validation", () => {
  it("parses valid mandates", () => {
    expect(() => IntentMandate.parse(intent())).not.toThrow();
    expect(() => CartMandate.parse(cart())).not.toThrow();
  });

  it("rejects an intent with an empty merchant allowlist", () => {
    const bad = intent();
    bad.scope.merchantAllowlist = [];
    expect(() => IntentMandate.parse(bad)).toThrow();
  });
});
