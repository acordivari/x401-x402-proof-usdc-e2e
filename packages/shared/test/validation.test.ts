import { describe, expect, it } from "vitest";
import {
  validatePaymentPayload,
  validateRequirementsBeforePaying,
} from "../src/validation.ts";
import { PaymentPayload } from "../src/schemas.ts";
import {
  AGENT_WALLET,
  NOW,
  OTHER_MERCHANT,
  payload,
  requirements,
} from "./fixtures.ts";

const opts = { nowSeconds: NOW, expectedFrom: AGENT_WALLET };

describe("validatePaymentPayload", () => {
  it("accepts a well-formed, in-window, exact-amount payment", () => {
    const res = validatePaymentPayload(payload(), requirements(), opts);
    expect(res).toEqual({ ok: true });
  });

  it("rejects payment to the wrong recipient", () => {
    const res = validatePaymentPayload(
      payload({ to: OTHER_MERCHANT }),
      requirements(),
      opts,
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.violations.join()).toMatch(/does not match merchant/);
  });

  it("rejects an over- or under-payment (exact scheme)", () => {
    const over = validatePaymentPayload(payload({ value: "1500001" }), requirements(), opts);
    const under = validatePaymentPayload(payload({ value: "1499999" }), requirements(), opts);
    expect(over.ok).toBe(false);
    expect(under.ok).toBe(false);
  });

  it("rejects an expired authorization", () => {
    const res = validatePaymentPayload(
      payload({ validBefore: String(NOW - 1) }),
      requirements(),
      opts,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/expired/);
  });

  it("rejects an authorization that is not yet valid", () => {
    const res = validatePaymentPayload(
      payload({ validAfter: String(NOW + 100) }),
      requirements(),
      opts,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/not yet valid/);
  });

  it("rejects a non-allowlisted asset", () => {
    const res = validatePaymentPayload(
      payload(),
      requirements({ asset: "0x9999999999999999999999999999999999999999" }),
      opts,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/not on the allowlist/);
  });

  it("rejects a payer that is not the authorized agent wallet", () => {
    const res = validatePaymentPayload(
      payload({ from: OTHER_MERCHANT }),
      requirements(),
      opts,
    );
    expect(res.ok === false && res.violations.join()).toMatch(/not the authorized agent/);
  });

  it("accumulates multiple violations at once", () => {
    const res = validatePaymentPayload(
      payload({ to: OTHER_MERCHANT, value: "999" }),
      requirements(),
      opts,
    );
    expect(res.ok === false && res.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("schema parsing", () => {
  it("normalizes addresses to lowercase on parse", () => {
    const upper = payload();
    upper.payload.authorization.to = "0xABCDEF0000000000000000000000000000000001" as any;
    const parsed = PaymentPayload.parse(upper);
    expect(parsed.payload.authorization.to).toBe(
      "0xabcdef0000000000000000000000000000000001",
    );
  });

  it("rejects a malformed nonce", () => {
    const bad = payload();
    (bad.payload.authorization as any).nonce = "not-hex";
    expect(() => PaymentPayload.parse(bad)).toThrow();
  });
});

describe("validateRequirementsBeforePaying", () => {
  it("passes for a clean USDC quote", () => {
    expect(validateRequirementsBeforePaying(requirements())).toEqual({ ok: true });
  });

  it("refuses a zero-amount quote", () => {
    const res = validateRequirementsBeforePaying(requirements({ amount: "0" }));
    expect(res.ok).toBe(false);
  });
});
