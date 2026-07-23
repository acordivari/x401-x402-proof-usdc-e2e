/**
 * Mandate signing, verification, and issuance — the cryptographic heart of the
 * Human Authorization Mandate (HAM). The Authorization Service verifies the
 * human's OIDC ID token and issues a *signed* Intent mandate binding that
 * verified Principal to an agent wallet and a spending scope. The merchant
 * later verifies the signature + the Payment ⊆ Cart ⊆ Intent scope chain
 * (scope logic lives in @agentic-payments/shared).
 */
import { randomUUID } from "node:crypto";
import { CompactSign, compactVerify, type KeyLike } from "jose";
import {
  X402_NETWORK,
  buildAgentDid,
  buildWalletControlMessage,
  cartItemsTotal,
  collect,
  nowSeconds,
  validateCartAgainstIntent,
  validatePaymentAgainstCart,
  type CartItem,
  type CartMandate,
  type IntentMandate,
  type PaymentMandate,
  type Principal,
  type ValidationResult,
} from "@agentic-payments/shared";
import {
  PROOF_CREDENTIAL_ID,
  type VerifiedAuthorization,
} from "@agentic-payments/credentials";
import type { SigningKeyPair } from "./keys.ts";
import type { IdentityVerifier } from "./oidc.ts";
import type { RevocationRecord, RevocationRegistry } from "./revocation.ts";
import type { AccountControlVerifier, WalletControlProof } from "./account-control.ts";

type Signable = IntentMandate | CartMandate | PaymentMandate;

/** Deterministic JSON: object keys sorted recursively, `proof` excluded. */
export function canonicalize(mandate: Signable): string {
  const { proof: _omit, ...rest } = mandate as Signable & { proof?: unknown };
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Signs mandates with a single EdDSA key (e.g. the Authorization Service). */
export class MandateSigner {
  constructor(private readonly key: SigningKeyPair) {}

  async sign<T extends Signable>(mandate: T): Promise<T> {
    const jws = await new CompactSign(
      new TextEncoder().encode(canonicalize(mandate)),
    )
      .setProtectedHeader({ alg: this.key.alg, kid: this.key.kid })
      .sign(this.key.privateKey);
    return { ...mandate, proof: { alg: this.key.alg, kid: this.key.kid, signature: jws } };
  }
}

/** A trust anchor: just the public half of a signing key. */
export type TrustedKey = Pick<SigningKeyPair, "kid" | "publicKey">;

/** Verifies mandate proofs against a set of trusted public keys (by kid). */
export class MandateVerifier {
  private readonly keys = new Map<string, KeyLike>();

  constructor(trusted: TrustedKey[]) {
    for (const k of trusted) this.keys.set(k.kid, k.publicKey);
  }

  /** True iff the mandate carries a valid signature over its canonical form. */
  async verifyProof(mandate: Signable): Promise<boolean> {
    const proof = (mandate as { proof?: { signature: string; kid: string } }).proof;
    if (!proof) return false;
    const key = this.keys.get(proof.kid);
    if (!key) return false;
    try {
      const { payload } = await compactVerify(proof.signature, key);
      return new TextDecoder().decode(payload) === canonicalize(mandate);
    } catch {
      return false;
    }
  }
}

export interface IntentScope {
  maxAmount: string; // atomic USDC cap for the whole intent
  merchantAllowlist: `0x${string}`[];
  allowedCategories: string[];
}

export interface IssueIntentRequest {
  idToken: string;
  agentWallet: `0x${string}`;
  scope: IntentScope;
  ttlSeconds?: number;
  /** CAIP-2 chain the wallet-native agentId binds to. Default: the sandbox network. */
  network?: `eip155:${number}`;
  /** Required when the service has an AccountControlVerifier configured. */
  walletProof?: WalletControlProof;
}

/**
 * Issues signed Intent mandates after verifying the human's OIDC identity. This
 * is the trust anchor: the merchant only needs the Authorization Service's
 * public key to verify that a real, known human authorized the agent + scope.
 */
export class AuthorizationService {
  constructor(
    private readonly identity: IdentityVerifier,
    private readonly signer: MandateSigner,
    private readonly now: () => number = nowSeconds,
    /** Revocation authority. When set, issued Intents can be revoked before expiry. */
    private readonly revocations?: RevocationRegistry,
    /**
     * Account-control seam: when set, issuance REQUIRES a valid
     * wallet-control proof — the agent must have signed for the wallet being
     * bound (EIP-191 for EOAs, ERC-1271 for smart accounts). Fail-closed.
     */
    private readonly accountControl?: AccountControlVerifier,
  ) {}

  /**
   * Revoke a previously-issued Intent by id. The merchant (which shares this
   * registry, or reads it over the wire) then refuses any further spend against
   * it — even though the Intent remains cryptographically valid and unexpired.
   */
  revokeIntent(intentId: string, reason?: string): RevocationRecord {
    if (!this.revocations) throw new Error("revocation is not configured on this AuthorizationService");
    return this.revocations.revoke(intentId, reason);
  }

  async issueIntent(req: IssueIntentRequest): Promise<IntentMandate> {
    const principal = await this.identity.verify(req.idToken);
    return this.signIntentFor(principal, req);
  }

  /**
   * Issue a signed Intent from a *verified x401 VC presentation* — the live
   * (Proof) identity path. The merchant later verifies this Intent exactly as it
   * does an OIDC-derived one; the difference is the principal is now backed by a
   * selectively-disclosed verifiable credential (and, via transaction_data, an
   * authorization bound to the payment). The caller (orchestrator) performs the
   * x401 + VC verification with `credentials.verifyAuthorization` and passes the
   * result here, so the trust check happens once at the seam.
   */
  async issueIntentFromPresentation(req: IssueIntentFromPresentationRequest): Promise<IntentMandate> {
    if (!req.authorization.result.ok) {
      throw new Error(
        `cannot issue intent: presentation not authorized — ${req.authorization.result.violations.join("; ")}`,
      );
    }
    const principal = principalFromAuthorization(req.authorization, req.presentationDigest);
    // Wallet control must be proven against the SAME single-use challenge the
    // human's presentation was bound to — one request context covers all three
    // proofs (presentation, payment, agent wallet).
    return this.signIntentFor(principal, req, req.authorization.challenge || undefined);
  }

  private async signIntentFor(
    principal: Principal,
    req: {
      agentWallet: `0x${string}`;
      scope: IntentScope;
      ttlSeconds?: number;
      network?: `eip155:${number}`;
      walletProof?: WalletControlProof;
    },
    expectedChallenge?: string,
  ): Promise<IntentMandate> {
    // Wallet-native did:pkh binding: same agent, but with the
    // chain id folded into the identity the merchant matches the payer against.
    const agentId = buildAgentDid(req.network ?? X402_NETWORK, req.agentWallet);
    await this.requireWalletControl(agentId, req.agentWallet, req.walletProof, expectedChallenge);

    const issuedAt = this.now();
    const ttl = req.ttlSeconds ?? 3600;
    const intent: IntentMandate = {
      type: "IntentMandate",
      id: randomUUID(),
      principal,
      agentWallet: req.agentWallet,
      agentId,
      scope: {
        maxAmount: req.scope.maxAmount,
        currency: "USDC",
        merchantAllowlist: req.scope.merchantAllowlist,
        allowedCategories: req.scope.allowedCategories,
      },
      issuedAt,
      expiresAt: issuedAt + ttl,
      nonce: randomUUID(),
    };
    return this.signer.sign(intent);
  }

  /**
   * Account control, enforced only when the seam is configured:
   * the proof must exist, be bound to the expected challenge (when one is
   * known), and its signature must prove control of the wallet being bound.
   */
  private async requireWalletControl(
    agentId: string,
    agentWallet: `0x${string}`,
    proof: WalletControlProof | undefined,
    expectedChallenge: string | undefined,
  ): Promise<void> {
    if (!this.accountControl) return;
    if (!proof) {
      throw new Error("cannot issue intent: wallet-control proof required (account control is configured)");
    }
    if (expectedChallenge !== undefined && proof.challenge !== expectedChallenge) {
      throw new Error("cannot issue intent: wallet-control proof is not bound to this authorization's challenge");
    }
    const result = await this.accountControl.verifyControl({
      address: agentWallet,
      message: buildWalletControlMessage({ agentId, challenge: proof.challenge }),
      signature: proof.signature,
    });
    if (!result.ok) {
      throw new Error(`cannot issue intent: ${result.violations.join("; ")}`);
    }
  }
}

export interface IssueIntentFromPresentationRequest {
  authorization: VerifiedAuthorization;
  agentWallet: `0x${string}`;
  scope: IntentScope;
  ttlSeconds?: number;
  /** Optional sha256(vp_token) for the audit trail. */
  presentationDigest?: string;
  /** CAIP-2 chain the wallet-native agentId binds to. Default: the sandbox network. */
  network?: `eip155:${number}`;
  /**
   * Required when the service has an AccountControlVerifier configured; must be
   * bound to the same challenge as the presentation (`authorization.challenge`).
   */
  walletProof?: WalletControlProof;
}

/** Map a verified VC presentation to a HAM Principal. */
function principalFromAuthorization(
  auth: VerifiedAuthorization,
  presentationDigest?: string,
): Principal {
  const proof = auth.proof;
  const subject = (proof?.subject ?? {}) as { email?: string };
  const issuer = proof?.issuer ?? "urn:proof:unknown-issuer";
  // A stable subject: the disclosed email when present, else an issuer-scoped id
  // derived from what was disclosed (the human can withhold email and still get
  // a consistent principal within an issuer).
  const sub = subject.email ?? `proof:${issuer}:${proof?.claimsDisclosed?.join("+") ?? "anon"}`;
  return {
    sub,
    idp: issuer,
    ...(subject.email !== undefined ? { email: subject.email, emailVerified: true } : {}),
    verifiedVia: "x401-vp",
    credential: {
      id: PROOF_CREDENTIAL_ID,
      issuer,
      ...(presentationDigest !== undefined ? { presentationDigest } : {}),
      ...(proof?.claimsDisclosed ? { claimsDisclosed: proof.claimsDisclosed } : {}),
    },
  };
}

/** Build a Cart mandate from line items (total computed from items). */
export function buildCartMandate(input: {
  intentId: string;
  merchant: `0x${string}`;
  items: CartItem[];
  nowSeconds: number;
  ttlSeconds?: number;
}): CartMandate {
  const total = cartItemsTotal(input.items);
  return {
    type: "CartMandate",
    id: randomUUID(),
    intentId: input.intentId,
    merchant: input.merchant,
    items: input.items,
    total: total.toString(),
    currency: "USDC",
    issuedAt: input.nowSeconds,
    expiresAt: input.nowSeconds + (input.ttlSeconds ?? 600),
    nonce: randomUUID(),
  };
}

/** Build a Payment mandate from a settled/authorized x402 payment. */
export function buildPaymentMandate(input: {
  cartId: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  amount: string;
  network: PaymentMandate["network"];
  nonce: string;
}): PaymentMandate {
  return {
    type: "PaymentMandate",
    id: randomUUID(),
    cartId: input.cartId,
    payTo: input.payTo,
    asset: input.asset,
    amount: input.amount,
    network: input.network,
    nonce: input.nonce,
  };
}

export interface ChainVerifyInput {
  intent: IntentMandate;
  cart: CartMandate;
  payment: PaymentMandate;
  nowSeconds: number;
}

/**
 * Full authorization check: the Intent signature is valid AND
 * Payment ⊆ Cart ⊆ Intent (scope, cap, merchant, categories, expiry).
 * Cumulative-cap enforcement across multiple purchases is the caller's job
 * (see the merchant's intent spend ledger).
 */
export async function verifyMandateChain(
  verifier: MandateVerifier,
  input: ChainVerifyInput,
): Promise<ValidationResult> {
  const intentSigOk = await verifier.verifyProof(input.intent);
  const cart = validateCartAgainstIntent(input.cart, input.intent, input.nowSeconds);
  const payment = validatePaymentAgainstCart(input.payment, input.cart);

  return collect([
    intentSigOk ? null : "intent mandate signature is invalid or untrusted",
    ...(cart.ok ? [] : cart.violations),
    ...(payment.ok ? [] : payment.violations),
  ]);
}
