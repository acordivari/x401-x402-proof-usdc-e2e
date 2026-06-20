import { describe, expect, it } from "vitest";
import {
  CartMandate,
  IntentMandate,
  validateCartAgainstIntent,
  validatePaymentAgainstCart,
} from "../src/mandates.ts";
import {
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
