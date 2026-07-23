/**
 * Human Authorization Mandate (HAM) — the protocol contribution of this
 * sandbox. Modeled on Google AP2's Intent -> Cart -> Payment chain, but with
 * the authorizing human's OIDC identity bound into the Intent mandate.
 *
 * This file holds the data model (Zod) + the PURE scope-validation logic that
 * proves Payment ⊆ Cart ⊆ Intent. Cryptographic signing/verification of the
 * mandates (Phase 2) lives in packages/identity and wraps these types.
 */
import { z } from "zod";
import { USDC_SYMBOL, X402_NETWORK } from "./constants.ts";
import { EvmAddress, UintString } from "./schemas.ts";
import { collect, type ValidationResult } from "./result.ts";

/** Optional detached signature over the mandate (populated in Phase 2). */
export const MandateProof = z.object({
  alg: z.string(), // e.g. "EdDSA" | "ES256"
  kid: z.string(), // key id of the issuer
  signature: z.string(), // base64url signature over the canonical mandate
});

/** The human principal, as asserted by the OIDC IdP or an x401 VC presentation. */
export const Principal = z.object({
  sub: z.string().min(1), // OIDC subject, or VC-derived stable subject
  idp: z.string().min(1), // issuer (OIDC issuer, or VC issuer e.g. Proof)
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  // How the identity was established. Backward compatible (optional): the OIDC
  // path may omit it; the x401 VC path sets "x401-vp" and records what the human
  // selectively disclosed, for a non-repudiable audit trail.
  verifiedVia: z.enum(["oidc", "x401-vp"]).optional(),
  credential: z
    .object({
      id: z.string(), // e.g. proof_id_default
      issuer: z.string(), // the VC issuer (Proof / local)
      presentationDigest: z.string().optional(), // sha256(vp_token) for audit
      claimsDisclosed: z.array(z.string()).optional(), // which claims were revealed
    })
    .optional(),
});
export type Principal = z.infer<typeof Principal>;

/**
 * Wallet-native Agent Identifier (`did:pkh:eip155:<chainId>:<address>`) —
 * the optional identity profile proposed in x401 PR #17: it ties an Agent to
 * an EVM account, with the chain id part of the identity.
 */
export const AgentDid = z
  .string()
  .regex(/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/, "invalid did:pkh agent identifier");

export function buildAgentDid(network: `eip155:${number}`, address: string): string {
  return `did:pkh:${network}:${address.toLowerCase()}`;
}

/** Parse a did:pkh Agent Identifier; address comes back normalized lowercase. */
export function parseAgentDid(
  did: string,
): { network: `eip155:${number}`; address: `0x${string}` } | undefined {
  const m = /^did:pkh:(eip155:\d+):(0x[0-9a-fA-F]{40})$/.exec(did);
  if (!m) return undefined;
  return {
    network: m[1] as `eip155:${number}`,
    address: m[2]!.toLowerCase() as `0x${string}`,
  };
}

/**
 * Intent Mandate — signed by the human after OIDC login. Authorizes a specific
 * agent wallet to spend up to a cap, at allowlisted merchants, within a window.
 */
export const IntentMandate = z.object({
  type: z.literal("IntentMandate"),
  id: z.string().uuid(),
  principal: Principal,
  agentWallet: EvmAddress, // the agent authorized to act for the principal
  // Wallet-native did:pkh binding of the same agent (x401 PR #17). Optional for
  // backward compatibility with already-signed mandates; when present, verifiers
  // MUST match the payer against it with the chain id as part of the identity.
  agentId: AgentDid.optional(),
  scope: z.object({
    maxAmount: UintString, // atomic USDC cap for the whole intent
    currency: z.literal(USDC_SYMBOL),
    merchantAllowlist: z.array(EvmAddress).min(1),
    allowedCategories: z.array(z.string().min(1)).min(1),
  }),
  issuedAt: z.number().int().nonnegative(), // unix seconds
  expiresAt: z.number().int().positive(), // unix seconds
  nonce: z.string().min(1), // replay protection (jti-like)
  proof: MandateProof.optional(),
});
export type IntentMandate = z.infer<typeof IntentMandate>;

export const CartItem = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  unitPrice: UintString, // atomic USDC
  quantity: z.number().int().positive(),
});
export type CartItem = z.infer<typeof CartItem>;

/** Cart Mandate — exact items + final price, bound to an Intent. */
export const CartMandate = z.object({
  type: z.literal("CartMandate"),
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  merchant: EvmAddress,
  items: z.array(CartItem).min(1),
  total: UintString, // atomic USDC; must equal sum(items)
  currency: z.literal(USDC_SYMBOL),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(1),
  proof: MandateProof.optional(),
});
export type CartMandate = z.infer<typeof CartMandate>;

/** Payment Mandate — links the on-chain payment to a Cart. */
export const PaymentMandate = z.object({
  type: z.literal("PaymentMandate"),
  id: z.string().uuid(),
  cartId: z.string().uuid(),
  payTo: EvmAddress,
  asset: EvmAddress,
  amount: UintString, // atomic USDC; must equal cart total
  network: z.literal(X402_NETWORK),
  nonce: z.string().min(1),
  proof: MandateProof.optional(),
});
export type PaymentMandate = z.infer<typeof PaymentMandate>;

/** Sum of unitPrice * quantity across cart line items (atomic USDC). */
export function cartItemsTotal(items: readonly CartItem[]): bigint {
  return items.reduce(
    (acc, it) => acc + BigInt(it.unitPrice) * BigInt(it.quantity),
    0n,
  );
}

/**
 * Verify Cart ⊆ Intent: same intent, allowlisted merchant, allowed categories,
 * internally-consistent total, within the cap, and the intent is currently
 * valid (not expired, already active). Pure — no crypto here.
 */
export function validateCartAgainstIntent(
  cart: CartMandate,
  intent: IntentMandate,
  nowSeconds: number,
): ValidationResult {
  const computed = cartItemsTotal(cart.items);
  const allowed = new Set(intent.scope.allowedCategories);
  const offendingCategories = cart.items
    .map((i) => i.category)
    .filter((c) => !allowed.has(c));

  return collect([
    cart.intentId !== intent.id ? "cart is not bound to this intent" : null,
    nowSeconds >= intent.expiresAt ? "intent has expired" : null,
    nowSeconds < intent.issuedAt ? "intent is not yet active" : null,
    !intent.scope.merchantAllowlist.includes(cart.merchant)
      ? `merchant ${cart.merchant} is not on the intent allowlist`
      : null,
    offendingCategories.length > 0
      ? `categories not authorized: ${[...new Set(offendingCategories)].join(", ")}`
      : null,
    computed.toString() !== cart.total
      ? `cart total ${cart.total} does not equal sum of items ${computed}`
      : null,
    BigInt(cart.total) > BigInt(intent.scope.maxAmount)
      ? `cart total ${cart.total} exceeds intent cap ${intent.scope.maxAmount}`
      : null,
  ]);
}

/**
 * Verify Payer ⊆ Intent — x401 PR #17's proof/payment binding, applied at the
 * payment protocol's *non-settling* verification step (i.e. BEFORE settlement).
 * The payer identity is derived from the signed payment authorization (the
 * EIP-3009 `from` plus the chain the payment settles on) and must match the
 * intent's wallet binding; when the intent carries a wallet-native `agentId`
 * (did:pkh), the chain id is part of the identity. Violations carry the PR's
 * normative `payer_agent_mismatch` error token. Pure — no crypto here.
 */
export function validatePayerAgainstIntent(
  payer: { address: string; network: `eip155:${number}` },
  intent: IntentMandate,
): ValidationResult {
  const address = payer.address.toLowerCase();
  const violations: (string | null)[] = [
    address !== intent.agentWallet.toLowerCase()
      ? `payer_agent_mismatch: payer ${payer.address} is not the authorized agent wallet ${intent.agentWallet}`
      : null,
  ];
  if (intent.agentId !== undefined) {
    const bound = parseAgentDid(intent.agentId);
    if (!bound) {
      // Schema-validated mandates can't hit this, but a foreign mandate might:
      // an unreadable binding must never widen into "no binding" — fail closed.
      violations.push(
        `payer_agent_mismatch: intent agentId ${intent.agentId} is not a valid did:pkh identifier`,
      );
    } else if (bound.network !== payer.network || bound.address !== address) {
      violations.push(
        `payer_agent_mismatch: payer ${buildAgentDid(payer.network, address)} does not match bound agent ${intent.agentId}`,
      );
    }
  }
  return collect(violations);
}

/** Verify Payment ⊆ Cart: same cart, pays the cart merchant the cart total. */
export function validatePaymentAgainstCart(
  payment: PaymentMandate,
  cart: CartMandate,
): ValidationResult {
  return collect([
    payment.cartId !== cart.id ? "payment is not bound to this cart" : null,
    payment.payTo !== cart.merchant
      ? `payment payTo ${payment.payTo} does not match cart merchant ${cart.merchant}`
      : null,
    payment.amount !== cart.total
      ? `payment amount ${payment.amount} does not equal cart total ${cart.total}`
      : null,
  ]);
}
