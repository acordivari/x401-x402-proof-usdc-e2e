import { describe, expect, it } from "vitest";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  dollarsToAtomic,
  type ExternalPaymentRequirements,
} from "@agentic-payments/shared";
import {
  createSpendGuardPolicy,
  evaluateQuote,
  type SpendGuardConfig,
} from "../src/live/guard.ts";

const PAY_TO = "0xcb6700f80203f2f6f0e0ea9ed464046fc7406bae" as const;

function quote(
  overrides: Partial<ExternalPaymentRequirements> = {},
): ExternalPaymentRequirements {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA.caip2,
    asset: BASE_SEPOLIA.usdcAddress,
    amount: dollarsToAtomic("0.01").toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: {},
    ...overrides,
  };
}

const guard: SpendGuardConfig = {
  network: BASE_SEPOLIA,
  maxPerCallAtomic: dollarsToAtomic("0.05"),
};

describe("evaluateQuote", () => {
  it("accepts an exact USDC quote on the allowed network under the cap", () => {
    expect(evaluateQuote(quote(), guard).ok).toBe(true);
  });

  it("rejects a quote over the per-call cap", () => {
    const res = evaluateQuote(quote({ amount: dollarsToAtomic("0.06").toString() }), guard);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.join()).toMatch(/per-call cap/);
  });

  it("rejects the wrong network even when everything else matches", () => {
    const res = evaluateQuote(quote({ network: BASE_MAINNET.caip2 }), guard);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.join()).toMatch(/network/);
  });

  it("rejects a non-USDC asset on the allowed network", () => {
    const res = evaluateQuote(
      quote({ asset: "0x1111111111111111111111111111111111111111" }),
      guard,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.join()).toMatch(/USDC/);
  });

  it("rejects a non-exact scheme", () => {
    const res = evaluateQuote(quote({ scheme: "upto" }), guard);
    expect(res.ok).toBe(false);
  });

  it("enforces the payee allowlist when pinned", () => {
    const pinned = { ...guard, payToAllowlist: [PAY_TO] as const };
    expect(evaluateQuote(quote(), pinned).ok).toBe(true);
    const swapped = quote({
      payTo: "0x2222222222222222222222222222222222222222",
    });
    expect(evaluateQuote(swapped, pinned).ok).toBe(false);
  });
});

describe("createSpendGuardPolicy", () => {
  it("filters offered requirements to those passing the guard", () => {
    const policy = createSpendGuardPolicy(guard);
    const good = quote();
    const tooExpensive = quote({ amount: dollarsToAtomic("9.99").toString() });
    const kept = policy(2, [good, tooExpensive] as never);
    expect(kept).toEqual([good]);
  });

  it("fails closed on unparseable options and payee swaps", () => {
    const policy = createSpendGuardPolicy({ ...guard, payToAllowlist: [PAY_TO] });
    const swapped = quote({ payTo: "0x2222222222222222222222222222222222222222" });
    const garbage = { totally: "unrelated" };
    expect(policy(2, [swapped, garbage] as never)).toEqual([]);
  });
});
