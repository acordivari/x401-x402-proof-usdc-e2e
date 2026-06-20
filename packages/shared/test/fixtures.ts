/** Builders for valid wire objects so tests can mutate one field at a time. */
import {
  USDC_ADDRESS,
  X402_NETWORK,
  X402_VERSION,
} from "../src/constants.ts";
import type { PaymentPayload, PaymentRequirements } from "../src/schemas.ts";
import type {
  CartMandate,
  IntentMandate,
  PaymentMandate,
} from "../src/mandates.ts";

export const MERCHANT = "0x1111111111111111111111111111111111111111" as const;
export const AGENT_WALLET = "0x2222222222222222222222222222222222222222" as const;
export const OTHER_MERCHANT = "0x3333333333333333333333333333333333333333" as const;
export const NONCE = "0x" + "ab".repeat(32);

export const NOW = 1_900_000_000; // fixed clock for deterministic tests

export function requirements(
  over: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    asset: USDC_ADDRESS,
    amount: "1500000", // $1.50
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
    extra: {},
    ...over,
  };
}

export function payload(
  over: Partial<PaymentPayload["payload"]["authorization"]> = {},
): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    payload: {
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: AGENT_WALLET,
        to: MERCHANT,
        value: "1500000",
        validAfter: String(NOW - 60),
        validBefore: String(NOW + 600),
        nonce: NONCE,
        ...over,
      },
    },
  };
}

export function intent(over: Partial<IntentMandate> = {}): IntentMandate {
  return {
    type: "IntentMandate",
    id: "11111111-1111-4111-8111-111111111111",
    principal: {
      sub: "auth0|abc123",
      idp: "https://tenant.us.auth0.com/",
      email: "buyer@example.com",
      emailVerified: true,
    },
    agentWallet: AGENT_WALLET,
    scope: {
      maxAmount: "5000000", // $5.00 cap
      currency: "USDC",
      merchantAllowlist: [MERCHANT],
      allowedCategories: ["otc-medicine", "vitamins"],
    },
    issuedAt: NOW - 100,
    expiresAt: NOW + 3600,
    nonce: "intent-nonce-1",
    ...over,
  };
}

export function cart(over: Partial<CartMandate> = {}): CartMandate {
  return {
    type: "CartMandate",
    id: "22222222-2222-4222-8222-222222222222",
    intentId: "11111111-1111-4111-8111-111111111111",
    merchant: MERCHANT,
    items: [
      {
        sku: "sku-allergy-relief",
        name: "Allergy relief tablets",
        category: "otc-medicine",
        unitPrice: "1500000",
        quantity: 1,
      },
    ],
    total: "1500000",
    currency: "USDC",
    issuedAt: NOW - 10,
    expiresAt: NOW + 300,
    nonce: "cart-nonce-1",
    ...over,
  };
}

export function paymentMandate(
  over: Partial<PaymentMandate> = {},
): PaymentMandate {
  return {
    type: "PaymentMandate",
    id: "33333333-3333-4333-8333-333333333333",
    cartId: "22222222-2222-4222-8222-222222222222",
    payTo: MERCHANT,
    asset: USDC_ADDRESS,
    amount: "1500000",
    network: X402_NETWORK,
    nonce: "payment-nonce-1",
    ...over,
  };
}
