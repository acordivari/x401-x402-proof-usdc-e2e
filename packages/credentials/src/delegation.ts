/**
 * Delegate Authority — a verified person authorizes an agent, within a scope,
 * by signing with the key bound to their OWN credential. This replaces the
 * July design, where our Authorization Service signed the standing mandate:
 * here no server vouches for the delegation at all. A merchant walks the chain
 * agent → holder credential → issuer and needs nothing from us.
 *
 * Proof's Delegate Authority is in early access and has no public wire format,
 * so the shape follows Verifiable Intent's autonomous mode, which Proof cites
 * as an example scope format:
 *
 *   L1  the holder's credential presentation      issuer JWT ~ disclosures ~
 *   L2  the mandate, signed by L1's cnf key        typ kb-sd-jwt+kb, sd_hash(L1),
 *                                                  mandate.cnf = the AGENT's key
 *   L3  one purchase, signed by the agent key      typ kb-sd-jwt, kid = mandate.cnf.kid,
 *                                                  aud + nonce from the merchant's
 *                                                  PROOF-REQUEST, sd_hash(L1~L2~)
 *
 *   serialized:  <L1 issuer-jwt>~<disclosures>~<L2>~<L3>
 *
 * The holder's consent is expressed in Proof's own Sign Transactions template:
 * L2 carries a `payment_mandate_v1` claim — the same payload (`prompt_summary`,
 * `amount` = the cap, `payee`, `payment_instrument`) Proof's Cloud Wallet
 * shows and signs for a standing authorization today — next to the
 * structured constraints a merchant can enforce mechanically.
 *
 * Simplifications vs Verifiable Intent v0.1, stated so they are not mistaken
 * for the spec: mandates travel in clear in L2 (no nested selective
 * disclosure), and there is a single L3 for the merchant (no separate
 * payment-network L3a). Browser-safe: minting runs in the holder's wallet.
 */
import type { ValidationResult } from "@agentic-payments/shared";
import { calculateJwkThumbprint, type JWK } from "jose";
import { sha256Base64url, type Jwk } from "./crypto.ts";
import { createSdJwtVc } from "./crypto.ts";
import { decodeJwsPart, parseCompactJws, signCompactJws, verifyCompactJws } from "./jws.ts";
import { presentationFrameFor, type ClaimPath } from "./proof-credential-v1.ts";
import { canonicalJson, type PaymentMandatePayloadV1 } from "./templates.ts";

/** vp_token key for a delegated-authority presentation. */
export const DELEGATED_AUTHORITY_QUERY_ID = "delegated_authority";
export const L2_TYP = "kb-sd-jwt+kb";
export const L3_TYP = "kb-sd-jwt";
export const OPEN_PAYMENT_MANDATE_VCT = "mandate.payment.open.1";
export const PAYMENT_MANDATE_VCT = "mandate.payment.1";

export type MandateConstraint =
  /** Cumulative cap across every purchase under the mandate (stateful: the merchant's ledger enforces it). */
  | { type: "mandate.payment.budget"; max: number; currency: string }
  /** Per-purchase ceiling. */
  | { type: "mandate.payment.amount_range"; max: number; currency: string }
  | { type: "mandate.payment.allowed_payees"; payees: { id: string; name: string; website?: string }[] }
  /** Private (`x-`) constraint: merchant catalog categories the agent may buy from. */
  | { type: "x-agentic-payments.allowed_categories"; categories: string[] };

export interface DelegationMandate {
  vct: typeof OPEN_PAYMENT_MANDATE_VCT;
  /** The agent's key. L3 must be signed by it. */
  cnf: { jwk: Jwk; kid: string };
  /** Wallet-native agent identifier (did:pkh) — the x402 payer must be this account. */
  agent_id: string;
  prompt_summary: string;
  payment_instrument: { type: string; id: string; description?: string };
  constraints: MandateConstraint[];
}

/** What the agent asks the holder to approve. */
export interface DelegationRequest {
  agent: { id: string; jwk: Jwk; kid: string };
  /** The standing authorization in Proof's `payment-mandate:v1` shape — what the holder reads and signs. */
  terms: PaymentMandatePayloadV1;
  constraints: MandateConstraint[];
  validitySeconds: number;
}

export interface MintDelegationInput {
  /** The held credential (issuer JWT + all disclosures). */
  credential: string;
  holderPrivateJwk: Jwk;
  /** Identity claims that travel with the delegation to every merchant. */
  disclose: ClaimPath[];
  request: DelegationRequest;
  /** unix seconds */
  now?: () => number;
}

export interface MintedDelegation {
  /** `<L1>~<L2>` — what the agent holds and extends with an L3 per purchase. */
  delegation: string;
  /** Holder-scoped key the merchant tracks the mandate under (see `mandateKeyFor`). */
  mandateId: string;
  /** The L2 `jti`. */
  jti: string;
  mandate: DelegationMandate;
  issuedAt: number;
  expiresAt: number;
}

export async function mintDelegation(input: MintDelegationInput): Promise<MintedDelegation> {
  const inst = await createSdJwtVc({});
  const l1 = await inst.present(input.credential, presentationFrameFor(input.disclose) as never);
  const iat = input.now?.() ?? Math.floor(Date.now() / 1000);
  const exp = iat + input.request.validitySeconds;
  const mandateId = crypto.randomUUID();
  const mandate: DelegationMandate = {
    vct: OPEN_PAYMENT_MANDATE_VCT,
    cnf: { jwk: input.request.agent.jwk, kid: input.request.agent.kid },
    agent_id: input.request.agent.id,
    prompt_summary: input.request.terms.prompt_summary,
    payment_instrument: input.request.terms.payment_instrument,
    constraints: input.request.constraints,
  };
  assertTermsMatchConstraints(input.request.terms, mandate.constraints);
  const l2 = await signCompactJws(
    { typ: L2_TYP },
    {
      jti: mandateId,
      aud: input.request.agent.id,
      nonce: crypto.randomUUID(),
      iat,
      exp,
      sd_hash: await sha256Base64url(l1),
      payment_mandate_v1: input.request.terms,
      mandates: [mandate],
    },
    input.holderPrivateJwk,
  );
  return {
    delegation: `${l1}${l2}`,
    mandateId: await mandateKeyFor(input.holderPrivateJwk, mandateId),
    jti: mandateId,
    mandate,
    issuedAt: iat,
    expiresAt: exp,
  };
}

/** One purchase, as the agent proves it at the merchant. */
export interface DelegatedCheckout {
  merchant: { id: string; name: string };
  items: { sku: string; label: string; category: string; quantity: number; unit_cost: number }[];
  currency: string;
  total: number;
}

export async function checkoutHash(checkout: DelegatedCheckout): Promise<string> {
  return sha256Base64url(canonicalJson(checkout));
}

export interface PresentDelegationInput {
  delegation: string;
  agentPrivateJwk: Jwk;
  /** The merchant's client_id (from its signed request). */
  audience: string;
  /** The merchant's single-use nonce. */
  nonce: string;
  checkout: DelegatedCheckout;
  now?: () => number;
}

/** The agent's L3: binds this checkout to the merchant's nonce under the mandate's key. */
export async function presentDelegation(input: PresentDelegationInput): Promise<string> {
  const l2 = input.delegation.slice(input.delegation.lastIndexOf("~") + 1);
  const mandate = readMandate(l2);
  const hash = await checkoutHash(input.checkout);
  const l3 = await signCompactJws(
    { typ: L3_TYP, kid: mandate.cnf.kid },
    {
      aud: input.audience,
      nonce: input.nonce,
      iat: input.now?.() ?? Math.floor(Date.now() / 1000),
      sd_hash: await sha256Base64url(`${input.delegation}~`),
      transaction: {
        vct: PAYMENT_MANDATE_VCT,
        payee: input.checkout.merchant,
        payment_amount: { amount: input.checkout.total, currency: input.checkout.currency },
        transaction_id: hash,
      },
      checkout: input.checkout,
      checkout_hash: hash,
    },
    input.agentPrivateJwk,
  );
  return `${input.delegation}~${l3}`;
}

/**
 * The human-readable terms and the machine constraints must say the same
 * thing: a budget other than the amount the holder read, or a payee they were
 * not shown, would make the signature cover something they did not see.
 */
function assertTermsMatchConstraints(terms: PaymentMandatePayloadV1, constraints: MandateConstraint[]): void {
  const budget = constraints.find((c) => c.type === "mandate.payment.budget");
  if (!budget || budget.type !== "mandate.payment.budget") throw new Error("a standing mandate needs a budget constraint");
  if (budget.max !== terms.amount || budget.currency !== terms.currency) {
    throw new Error("budget constraint differs from the payment_mandate_v1 amount the holder approves");
  }
  const payees = constraints.find((c) => c.type === "mandate.payment.allowed_payees");
  if (payees && payees.type === "mandate.payment.allowed_payees" && terms.payee.id !== undefined &&
      !payees.payees.some((p) => p.id.toLowerCase() === terms.payee.id!.toLowerCase())) {
    throw new Error("the payee shown to the holder is not an allowed payee");
  }
}

function readMandate(l2: string): DelegationMandate {
  const mandate = (parseCompactJws(l2).payload.mandates as DelegationMandate[] | undefined)?.[0];
  if (!mandate) throw new Error("delegation carries no mandate");
  return mandate;
}

/** Decode a held delegation for display (no verification). */
export function inspectDelegation(delegation: string): {
  /** The L2 `jti` (holder-chosen; use `mandateKey()` for the tracking key). */
  jti: string;
  mandate: DelegationMandate;
  terms: PaymentMandatePayloadV1;
  issuedAt: number;
  expiresAt: number;
} {
  const l2 = parseCompactJws(delegation.slice(delegation.lastIndexOf("~") + 1)).payload;
  return {
    jti: String(l2.jti),
    mandate: (l2.mandates as DelegationMandate[])[0]!,
    terms: l2.payment_mandate_v1 as PaymentMandatePayloadV1,
    issuedAt: Number(l2.iat),
    expiresAt: Number(l2.exp),
  };
}

/**
 * The key a mandate is tracked under — spend ledger and revocation alike. The
 * L2 `jti` alone is chosen by the holder, so two holders could pick the same
 * one and exhaust or revoke each other's mandates; scoping it to the holder's
 * key thumbprint makes it collision-free without trusting anyone's choice.
 */
export async function mandateKeyFor(holderJwk: Jwk, jti: string): Promise<string> {
  return `${await calculateJwkThumbprint(holderJwk as JWK)}.${jti}`;
}

/** The mandate key of a held delegation (reads, does not verify, the holder key in L1). */
export async function mandateKey(delegation: string): Promise<string> {
  const l1Payload = decodeJwsPart<{ cnf?: { jwk?: Jwk } }>(delegation.split("~")[0]!.split(".")[1]!);
  const jwk = l1Payload.cnf?.jwk;
  if (!jwk) throw new Error("delegation's holder credential has no cnf key");
  return mandateKeyFor(jwk, inspectDelegation(delegation).jti);
}

/** How the verifier checks L1 — a pinned local issuer, or the Proof SDK's `verify`. */
export type L1Verifier = (l1: string) => Promise<{
  issuer: string;
  vct: string;
  claims: Record<string, unknown>;
  holderJwk: Jwk;
  trustAnchor: string;
}>;

export interface VerifyDelegationInput {
  presentation: string;
  verifyL1: L1Verifier;
  /** Our client_id. */
  audience: string;
  /** Our payee id (the address the purchase must pay). */
  payeeId: string;
  /** Catalog categories of the items being bought — from OUR catalog, not the agent's claim. */
  itemCategories: string[];
  maxAgeSeconds?: number;
  now?: () => number;
}

export interface VerifiedDelegation {
  result: ValidationResult;
  mandateId?: string;
  mandate?: DelegationMandate;
  expiresAt?: number;
  /** Disclosed identity of the delegating person. */
  principal?: { issuer: string; vct: string; claims: Record<string, unknown>; trustAnchor: string };
  /** The merchant nonce the agent's L3 answered. */
  nonce?: string;
  checkout?: DelegatedCheckout;
  /** Cumulative cap the caller's ledger must enforce. */
  budget?: { max: number; currency: string };
  /** The `payment_mandate_v1` terms the holder signed. */
  terms?: PaymentMandatePayloadV1;
}

/**
 * Walk the chain and evaluate every STATELESS constraint. The two stateful
 * ones stay with the caller, deliberately: consuming the nonce (single-use
 * store) and the cumulative budget (spend ledger), plus revocation.
 */
type GrantParts =
  | { ok: false; violation: string; principal?: VerifiedDelegation["principal"] }
  | {
      ok: true;
      principal: NonNullable<VerifiedDelegation["principal"]>;
      holderJwk: Jwk;
      mandate: DelegationMandate;
      /** Holder-scoped mandate key (see `mandateKeyFor`). */
      mandateId: string;
      expiresAt: number;
      terms: PaymentMandatePayloadV1;
    };

/** L1 (holder credential) + L2 (the mandate it signed). Shared by grant acceptance and per-purchase verification. */
async function verifyGrantParts(l1: string, l2: string, verifyL1: L1Verifier, nowS: number): Promise<GrantParts> {
  let principal: NonNullable<VerifiedDelegation["principal"]>;
  let holderJwk: Jwk;
  try {
    const r = await verifyL1(l1);
    principal = { issuer: r.issuer, vct: r.vct, claims: r.claims, trustAnchor: r.trustAnchor };
    holderJwk = r.holderJwk;
  } catch (err) {
    return { ok: false, violation: `holder credential: ${(err as Error).message}` };
  }
  // L2 — signed by the key bound into the holder's credential.
  try {
    const { header, payload } = await verifyCompactJws(l2, holderJwk);
    const terms = payload.payment_mandate_v1 as PaymentMandatePayloadV1;
    if (!terms || typeof terms.prompt_summary !== "string") throw new Error("mandate carries no payment_mandate_v1 terms");
    if (header.typ !== L2_TYP) throw new Error(`typ ${String(header.typ)} is not ${L2_TYP}`);
    if (payload.sd_hash !== (await sha256Base64url(l1))) throw new Error("sd_hash does not cover the holder credential");
    const mandate = readMandate(l2);
    const jti = String(payload.jti ?? "");
    const expiresAt = Number(payload.exp);
    if (!jti) throw new Error("mandate has no id (jti)");
    if (mandate.vct !== OPEN_PAYMENT_MANDATE_VCT) throw new Error(`mandate vct ${mandate.vct} is not ${OPEN_PAYMENT_MANDATE_VCT}`);
    if (!mandate.cnf?.jwk || !mandate.cnf.kid) throw new Error("mandate does not name an agent key (cnf)");
    if (!/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/.test(mandate.agent_id)) throw new Error("mandate agent_id is not a did:pkh");
    if (!(Number(payload.iat) <= nowS + 300)) throw new Error("mandate is not yet valid");
    if (!(expiresAt > nowS)) throw new Error("mandate has expired");
    assertTermsMatchConstraints(terms, mandate.constraints);
    return { ok: true, principal, holderJwk, mandate, mandateId: await mandateKeyFor(holderJwk, jti), expiresAt, terms };
  } catch (err) {
    return { ok: false, violation: `mandate: ${(err as Error).message}`, principal };
  }
}

/**
 * Verify a delegation as GRANTED (L1 + L2, no purchase yet) — what an agent
 * should check before it agrees to carry one.
 */
export async function verifyDelegationGrant(input: {
  delegation: string;
  verifyL1: L1Verifier;
  now?: () => number;
}): Promise<{ result: ValidationResult; mandateId?: string; mandate?: DelegationMandate; expiresAt?: number; terms?: PaymentMandatePayloadV1 }> {
  const cut = input.delegation.lastIndexOf("~");
  if (cut < 0) return { result: fail(["delegation is not <L1>~<L2>"]) };
  const g = await verifyGrantParts(
    input.delegation.slice(0, cut + 1),
    input.delegation.slice(cut + 1),
    input.verifyL1,
    input.now?.() ?? Math.floor(Date.now() / 1000),
  );
  return g.ok
    ? { result: { ok: true }, mandateId: g.mandateId, mandate: g.mandate, expiresAt: g.expiresAt, terms: g.terms }
    : { result: fail([g.violation]) };
}

export async function verifyDelegation(input: VerifyDelegationInput): Promise<VerifiedDelegation> {
  const v: string[] = [];
  const nowS = input.now?.() ?? Math.floor(Date.now() / 1000);
  const maxAge = input.maxAgeSeconds ?? 300;
  const parts = input.presentation.split("~");
  if (parts.length < 4) return { result: fail(["delegated presentation is not <L1>~<L2>~<L3>"]) };
  const l3 = parts[parts.length - 1]!;
  const l2 = parts[parts.length - 2]!;
  const l1 = `${parts.slice(0, -2).join("~")}~`;

  const grant = await verifyGrantParts(l1, l2, input.verifyL1, nowS);
  if (!grant.ok) return { result: fail([grant.violation]), ...(grant.principal ? { principal: grant.principal } : {}) };
  const { principal, mandate, mandateId, expiresAt, terms } = grant;

  // L3 — signed by the agent key the mandate names; never a key the L3 asserts itself.
  let nonce: string;
  let checkout: DelegatedCheckout;
  try {
    const peek = parseCompactJws(l3);
    if (peek.header.typ !== L3_TYP) throw new Error(`typ ${String(peek.header.typ)} is not ${L3_TYP}`);
    if (peek.header.jwk !== undefined) throw new Error("self-asserted key in header (rejected)");
    if (peek.header.kid !== mandate.cnf.kid) throw new Error("kid does not match the mandate's agent key");
    const { payload } = await verifyCompactJws(l3, mandate.cnf.jwk);
    if (payload.cnf !== undefined) throw new Error("agent proof must not delegate further (cnf)");
    if (payload.aud !== input.audience) throw new Error(`aud ${String(payload.aud)} is not this merchant`);
    if (payload.sd_hash !== (await sha256Base64url(`${l1}${l2}~`))) throw new Error("sd_hash does not cover the mandate");
    const iat = Number(payload.iat);
    if (!(iat <= nowS + 300 && nowS - iat <= maxAge)) throw new Error("agent proof is stale or from the future");
    if (typeof payload.nonce !== "string" || !payload.nonce) throw new Error("no nonce");
    nonce = payload.nonce;
    checkout = payload.checkout as DelegatedCheckout;
    const hash = await checkoutHash(checkout);
    const tx = payload.transaction as { transaction_id?: string; payee?: { id?: string }; payment_amount?: { amount?: number } };
    if (payload.checkout_hash !== hash || tx?.transaction_id !== hash) throw new Error("transaction is not bound to the checkout");
    if (tx.payee?.id !== checkout.merchant?.id) throw new Error("transaction payee differs from the checkout merchant");
    if (tx.payment_amount?.amount !== checkout.total) throw new Error("transaction amount differs from the checkout total");
    const sum = Math.round(checkout.items.reduce((s, i) => s + i.quantity * i.unit_cost, 0) * 100) / 100;
    if (sum !== checkout.total) throw new Error("checkout total does not equal its items");
  } catch (err) {
    return { result: fail([`agent proof: ${(err as Error).message}`]), mandateId, mandate, expiresAt, ...(principal ? { principal } : {}) };
  }

  // Stateless constraints.
  let budget: VerifiedDelegation["budget"];
  for (const c of mandate.constraints) {
    switch (c.type) {
      case "mandate.payment.budget":
        budget = { max: c.max, currency: c.currency };
        if (checkout.currency !== c.currency) v.push(`currency ${checkout.currency} is not the mandate's ${c.currency}`);
        break;
      case "mandate.payment.amount_range":
        if (checkout.total > c.max) v.push(`purchase ${checkout.total} exceeds the per-purchase limit ${c.max}`);
        break;
      case "mandate.payment.allowed_payees":
        if (!c.payees.some((p) => p.id.toLowerCase() === input.payeeId.toLowerCase())) v.push("this merchant is not an allowed payee");
        break;
      case "x-agentic-payments.allowed_categories": {
        const bad = input.itemCategories.filter((cat) => !c.categories.includes(cat));
        if (bad.length) v.push(`categories not authorized: ${[...new Set(bad)].join(", ")}`);
        break;
      }
      default:
        // An unknown constraint narrows authority we cannot evaluate: fail closed.
        v.push(`unsupported mandate constraint ${(c as { type: string }).type}`);
    }
  }
  if (checkout.merchant.id.toLowerCase() !== input.payeeId.toLowerCase()) v.push("checkout is for a different merchant");

  return {
    result: fail(v),
    mandateId,
    mandate,
    expiresAt,
    ...(principal ? { principal } : {}),
    nonce,
    checkout,
    terms,
    ...(budget ? { budget } : {}),
  };
}

function fail(violations: string[]): ValidationResult {
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
