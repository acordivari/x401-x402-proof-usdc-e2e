/**
 * A current x401 verifier, framework-agnostic: what a protected route does on
 * both legs of the exchange.
 *
 *   challenge()       mint a single-use nonce, sign a DC API request carrying
 *                     the route's Sign Transactions terms, and build the
 *                     PROOF-REQUEST payload (with token-exchange metadata and
 *                     the informational x402 payment hint)
 *   verifyArtifact()  validate a Result Artifact against the request composed
 *                     for THIS route: credential (via the swappable presentation
 *                     verifier), nonce we issued, route binding, scope
 *                     disclosures, route policy predicates, and terms match —
 *                     or, for an agent acting under Delegate Authority, the
 *                     whole delegation chain
 *
 * Spec mapping (x401 0.2.0, "Proof Validation"): recover route context from
 * the nonce (1), cryptographic protection (2), binding to us as relying party
 * via the signed request + `aud` (3), nonce issued + single-use (4), DCQL
 * satisfaction (5), issuer trust + policy (6), optional agent binding (7).
 */
import type { ValidationResult } from "@agentic-payments/shared";
import {
  ACCESS_TOKEN_TYPE,
  DC_API_PROTOCOL,
  HEADER,
  verifier as x401,
  type PaymentObject,
  type ResultArtifact,
  type X401Payload,
  type X401TokenObject,
} from "@proof.com/x401-node";

/** x401 header names (`PROOF-REQUEST`, `PROOF-RESPONSE`, `PROOF-RESULT`) and the token type it issues. */
export { HEADER as X401_HEADER, ACCESS_TOKEN_TYPE as X401_ACCESS_TOKEN_TYPE };
import type { DcApiRequestSigner } from "./dc-api-request.ts";
import {
  DELEGATED_AUTHORITY_QUERY_ID,
  verifyDelegation,
  type DelegationMandate,
  type L1Verifier,
} from "./delegation.ts";
import type { SignaturePayment } from "./detached-signatures.ts";
import type { NonceStore } from "./nonce-store.ts";
import { PROOF_SCOPES, readClaim, scopeDefinition, claimPathLabel, type ClaimPath } from "./proof-credential-v1.ts";
import {
  assertTxDataAllowed,
  canonicalJson,
  checkTerms,
  TX_TEMPLATES,
  type PaymentItemizedPayloadV1,
  type PaymentMandatePayloadV1,
  type TermsCheck,
  type TransactionDataV1,
} from "./templates.ts";
import type { PresentationVerifierV1 } from "./verifier-v1.ts";
import { decodeVpToken, encodeVpToken, normalizeVpToken } from "./wallet-v1.ts";
import { decodeJwsPart } from "./jws.ts";

/** A route policy predicate over the disclosed claims (e.g. age_equal_or_over.18 = true). */
export interface ClaimPredicate {
  path: ClaimPath;
  equals: unknown;
  /** Shown when it fails. */
  reason: string;
}

/** x401 error codes this verifier emits in PROOF-RESULT (verifier-defined, per the spec). */
export type X401ErrorCode =
  | "invalid_response"
  | "invalid_result"
  | "invalid_nonce"
  | "policy_not_satisfied"
  | "terms_mismatch"
  | "mandate_revoked"
  | "invalid_token";

interface PendingRequest {
  nonce: string;
  resource: string;
  sku: string;
  /** did:pkh the requesting agent declared; the presentation's nonce binds the person to it. */
  agentId: string;
  scope: string;
  transactionData: TransactionDataV1[];
  expiresAt: number;
}

export interface VerifiedProofV1 {
  result: ValidationResult;
  code?: X401ErrorCode;
  kind: "presentation" | "delegation";
  nonce?: string;
  resource?: string;
  sku?: string;
  principal?: { issuer: string; vct: string; claims: Record<string, unknown>; trustAnchor: string; credentialType?: string };
  /** One entry per template we sent; all must match. */
  terms?: TermsCheck[];
  /** did:pkh the payment must come from: the agent that requested the proof (and, delegated, the one the mandate names). */
  agentId?: string;
  mandate?: {
    id: string;
    expiresAt: number;
    budget: { max: number; currency: string };
    terms: PaymentMandatePayloadV1;
    constraints: DelegationMandate["constraints"];
  };
  signaturePayments: SignaturePayment[];
  detachedSignatures: boolean;
}

export interface CatalogLookup {
  (sku: string): { name: string; category: string; priceUsd: string } | undefined;
}

export interface X401VerifierV1Options {
  requestSigner: DcApiRequestSigner;
  presentationVerifier: PresentationVerifierV1;
  nonceStore: NonceStore;
  expectedOrigins: [string, ...string[]];
  scope?: string;
  /** Enables Delegate Authority presentations (agents acting under a holder-signed mandate). */
  l1Verifier?: L1Verifier;
  /** Our payee id (merchant payTo). */
  payeeId: string;
  catalog: CatalogLookup;
  /** Route policy over disclosed claims, per sku (e.g. age-restricted categories). */
  predicates?: (sku: string) => ClaimPredicate[];
  revocation?: { isRevoked(id: string): boolean | Promise<boolean> };
  /** How long a PROOF-REQUEST stays answerable. Default 10 min (relay latency + human approval). */
  requestTtlSeconds?: number;
  /** Permit http credential_result_uri (local dev only). */
  allowInsecureUri?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export const X401_REQUEST_ID = "agentic-payments-buy-v1";
/** Reusable-requirement hint: any proof that a verified human authorized this purchase. */
export const HUMAN_AUTHORIZED_PURCHASE = "urn:agentic-payments:requirement:human-authorized-purchase:v1";

export class X401VerifierV1 {
  private readonly pending = new Map<string, PendingRequest>();
  readonly scope: string;

  constructor(private readonly opts: X401VerifierV1Options) {
    this.scope = opts.scope ?? PROOF_SCOPES.basic;
    scopeDefinition(this.scope); // fail fast on an unknown scope
  }

  get clientId(): string {
    return this.opts.requestSigner.clientId;
  }

  private nowS(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Build the 401's PROOF-REQUEST for one route. */
  async challenge(input: {
    resource: string;
    sku: string;
    /** The requesting agent's did:pkh. The person's presentation signs this request's nonce, binding them to it. */
    agentId: string;
    /**
     * Who should approve (an email). Proof's handoff identifies the End-User by
     * the request object's `login_hint` when no user token accompanies it.
     */
    loginHint?: string;
    terms: TransactionDataV1[];
    tokenEndpoint?: string;
    resourceUrl?: string;
    payment?: PaymentObject;
  }): Promise<{ header: string; payload: X401Payload; nonce: string; request: string }> {
    const terms = input.terms.slice(0, this.opts.requestSigner.maxTransactionData);
    assertTxDataAllowed(this.scope, terms);
    this.sweep();
    const nonce = await this.opts.nonceStore.mint();
    const request = await this.opts.requestSigner.signedDcApiRequest({
      scope: this.scope,
      nonce,
      expectedOrigins: this.opts.expectedOrigins,
      transactionData: terms,
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
    });
    this.pending.set(nonce, {
      nonce,
      resource: input.resource,
      sku: input.sku,
      agentId: input.agentId,
      scope: this.scope,
      transactionData: terms,
      expiresAt: this.nowS() + (this.opts.requestTtlSeconds ?? 600),
    });
    const payload = x401.buildPayload({
      credentialRequirements: { digital: { requests: [{ protocol: DC_API_PROTOCOL.SIGNED, data: { request } }] } },
      ...(input.tokenEndpoint
        ? { oauth: { token_endpoint: input.tokenEndpoint, ...(input.resourceUrl ? { resource: input.resourceUrl } : {}) } }
        : {}),
      requestId: X401_REQUEST_ID,
      satisfiedRequirements: [HUMAN_AUTHORIZED_PURCHASE],
      ...(input.payment ? { payment: input.payment } : {}),
    });
    return { header: x401.encodePayload(payload), payload, nonce, request };
  }

  /** PROOF-RESULT header value for a failed attempt. */
  errorHeader(code: X401ErrorCode, description: string): string {
    return x401.encodeErrorObject(x401.buildErrorObject({ error: code, error_description: description, request_id: X401_REQUEST_ID }));
  }

  decodeArtifact(header: string): ResultArtifact {
    return x401.decodeResultArtifact(header, { allowInsecureUri: this.opts.allowInsecureUri === true });
  }

  /** A PROOF-RESPONSE carrying a Verification Token rather than a Result Artifact, or undefined. */
  tryDecodeTokenObject(header: string): X401TokenObject | undefined {
    try {
      return x401.decodeTokenObject(header);
    } catch {
      return undefined;
    }
  }

  /** RFC 8693 token-exchange form → the Result Artifact + requested resource. */
  parseTokenExchange(form: Record<string, string | undefined>): { artifact: ResultArtifact; resource?: string } {
    const parsed = x401.parseTokenExchange(form);
    return {
      artifact: this.decodeArtifact(parsed.subject_token),
      ...(parsed.resource !== undefined ? { resource: parsed.resource } : {}),
    };
  }

  /**
   * Validate a Result Artifact for `resource`. With `consume: false` the nonce
   * is checked as issued-and-outstanding but left live, so a direct retry can
   * be re-presented on its paid follow-up; call `consume(nonce)` once the
   * route actually completes. Token exchange verifies with `consume: true`.
   */
  async verifyArtifact(artifact: ResultArtifact, opts: { resource: string; consume: boolean }): Promise<VerifiedProofV1> {
    const base = { signaturePayments: [] as SignaturePayment[], detachedSignatures: false };
    let result: { protocol: string; data: unknown } | undefined = artifact.credential_result;
    if (!result && artifact.credential_result_uri) {
      // A by-reference result is fetched before anything is authenticated, so
      // bound it: no redirects, a 5 s timeout, 256 KB. (x401-node already
      // insists on https unless insecure URIs were allowed for local dev.)
      try {
        const r = await (this.opts.fetch ?? fetch)(artifact.credential_result_uri, {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (text.length > 262_144) throw new Error("credential result too large");
        result = JSON.parse(text) as { protocol: string; data: unknown };
      } catch (err) {
        return { ...base, kind: "presentation", code: "invalid_response", result: bad(`credential_result_uri: ${(err as Error).message}`) };
      }
    }
    if (!result) return { ...base, kind: "presentation", code: "invalid_response", result: bad("artifact carries no credential result") };
    if (result.protocol !== DC_API_PROTOCOL.SIGNED) {
      return { ...base, kind: "presentation", code: "invalid_response", result: bad(`unsupported protocol ${result.protocol}`) };
    }
    let encoded: string;
    let keys: string[];
    try {
      encoded = normalizeVpToken((result.data as { vp_token?: unknown } | null)?.vp_token);
      keys = Object.keys(decodeVpToken(encoded));
    } catch (err) {
      return { ...base, kind: "presentation", code: "invalid_response", result: bad((err as Error).message) };
    }
    if (keys.includes(DELEGATED_AUTHORITY_QUERY_ID)) {
      return this.verifyDelegated(encoded, artifact, opts);
    }
    return this.verifyPresentation(encoded, artifact, opts);
  }

  /**
   * Re-check what can change after a proof was verified — a mandate's expiry and
   * revocation — at the moment it is about to be spent (a Verification Token is
   * redeemed minutes after the exchange that issued it). Fails closed.
   */
  async recheck(proof: VerifiedProofV1): Promise<{ result: ValidationResult; code?: X401ErrorCode }> {
    if (!proof.mandate) return { result: { ok: true } };
    if (proof.mandate.expiresAt <= this.nowS()) return { result: bad("the mandate has expired"), code: "policy_not_satisfied" };
    try {
      if (this.opts.revocation && (await this.opts.revocation.isRevoked(proof.mandate.id))) {
        return { result: bad("this mandate has been revoked by the person who granted it"), code: "mandate_revoked" };
      }
    } catch {
      return { result: bad("mandate status could not be confirmed"), code: "mandate_revoked" };
    }
    return { result: { ok: true } };
  }

  /** Burn a nonce after the route completes (direct-retry path). */
  async consume(nonce: string): Promise<boolean> {
    this.pending.delete(nonce);
    return this.opts.nonceStore.verify(nonce);
  }

  private routeContext(nonce: string, resource: string): PendingRequest | string {
    const p = this.pending.get(nonce);
    if (!p) return "nonce was not issued by this verifier, or was already used";
    if (p.expiresAt <= this.nowS()) return "the proof request has expired";
    if (p.resource !== resource) return `proof was requested for ${p.resource}, not ${resource}`;
    return p;
  }

  private async finishNonce(p: PendingRequest, consume: boolean): Promise<boolean> {
    if (!consume) return true;
    this.pending.delete(p.nonce);
    return this.opts.nonceStore.verify(p.nonce);
  }

  private async verifyPresentation(
    encoded: string,
    artifact: ResultArtifact,
    opts: { resource: string; consume: boolean },
  ): Promise<VerifiedProofV1> {
    const kind = "presentation" as const;
    const none = { signaturePayments: [] as SignaturePayment[], detachedSignatures: false };
    const def = scopeDefinition(this.scope);
    // Route context FIRST, from the (unverified) KB-JWT nonce: a presentation for
    // a nonce we never issued, or for another route, is refused before the
    // verifier pays to fetch any detached signatures. Only the scope's own
    // credential is verified; anything else in the vp_token is ignored.
    const entry = decodeVpToken(encoded)[def.credentialQueryId]?.[0];
    if (!entry) return { ...none, kind, code: "invalid_result", result: bad(`no ${def.credentialQueryId} presentation for scope ${def.label}`) };
    let peeked: string | undefined;
    try {
      const kb = entry.slice(entry.lastIndexOf("~") + 1);
      const n = decodeJwsPart(kb.split(".")[1] ?? "").nonce;
      peeked = typeof n === "string" ? n : undefined;
    } catch { /* fall through */ }
    if (!peeked) return { ...none, kind, code: "invalid_result", result: bad("presentation carries no key-binding nonce") };
    const ctx = this.routeContext(peeked, opts.resource);
    if (typeof ctx === "string") return { ...none, kind, code: "invalid_nonce", result: bad(ctx) };
    // Agent binding: the person signed THIS request's nonce, and this request was
    // made by the agent it names. A relay that swaps in its own agent_id fails here.
    if (artifact.agent_id !== ctx.agentId) {
      return { ...none, kind, nonce: ctx.nonce, code: "invalid_result", result: bad("the artifact's agent_id is not the agent that requested this proof") };
    }

    const vpt = await this.opts.presentationVerifier.verifyVpToken({
      encodedVpToken: encodeVpToken({ [def.credentialQueryId]: [entry] }),
      aud: this.clientId,
    });
    const common = { signaturePayments: vpt.signaturePayments, detachedSignatures: vpt.presentations.some((p) => p.detachedSignatures) };
    if (!vpt.result.ok) return { ...common, kind, code: "invalid_result", result: vpt.result };
    const p = vpt.presentations.find((x) => x.credentialQueryId === def.credentialQueryId);
    if (!p || p.nonce !== ctx.nonce) return { ...common, kind, code: "invalid_result", result: bad("verified presentation does not answer this request") };
    const principal = { issuer: p.issuer, vct: p.vct, claims: p.claims, trustAnchor: p.trustAnchor, credentialType: p.credentialType };

    const v: string[] = [];
    for (const path of def.disclosures) {
      if (readClaim(p.claims, path) === undefined) v.push(`scope requires ${claimPathLabel(path)}, which was not disclosed`);
    }
    if (v.length) return { ...common, kind, principal, nonce: p.nonce, code: "invalid_result", result: bad(...v) };

    const terms = checkTerms(p.kbPayload, ctx.transactionData);
    const mismatched = terms.filter((t) => !t.matches);
    if (mismatched.length) {
      return {
        ...common, kind, principal, terms, nonce: p.nonce, code: "terms_mismatch",
        result: bad(...mismatched.map((t) => `${t.claim} ${t.present ? "differs from the terms requested" : "was not signed"}`)),
      };
    }
    for (const pred of this.opts.predicates?.(ctx.sku) ?? []) {
      if (readClaim(p.claims, pred.path) !== pred.equals) v.push(pred.reason);
    }
    if (v.length) return { ...common, kind, principal, terms, nonce: p.nonce, code: "policy_not_satisfied", result: bad(...v) };

    if (!(await this.finishNonce(ctx, opts.consume))) {
      return { ...common, kind, principal, terms, nonce: p.nonce, code: "invalid_nonce", result: bad("nonce was already used") };
    }
    return {
      ...common, kind, principal, terms, nonce: p.nonce, resource: ctx.resource, sku: ctx.sku,
      agentId: ctx.agentId,
      result: { ok: true },
    };
  }

  private async verifyDelegated(
    encoded: string,
    artifact: ResultArtifact,
    opts: { resource: string; consume: boolean },
  ): Promise<VerifiedProofV1> {
    const kind = "delegation" as const;
    const base = { signaturePayments: [] as SignaturePayment[], detachedSignatures: false };
    if (!this.opts.l1Verifier) return { ...base, kind, code: "invalid_result", result: bad("this verifier does not accept delegated authority") };
    const [presentation] = decodeVpToken(encoded)[DELEGATED_AUTHORITY_QUERY_ID] ?? [];
    if (!presentation) return { ...base, kind, code: "invalid_response", result: bad("empty delegated_authority entry") };

    // Peek the agent proof's nonce so the route context (and therefore OUR
    // catalog's categories) is known before the constraints are evaluated.
    let nonce: string | undefined;
    try {
      const l3 = presentation.slice(presentation.lastIndexOf("~") + 1);
      const n = decodeJwsPart(l3.split(".")[1]!).nonce;
      nonce = typeof n === "string" ? n : undefined;
    } catch { /* fall through to the chain's own error */ }
    const ctx = nonce ? this.routeContext(nonce, opts.resource) : "agent proof carries no nonce";
    if (typeof ctx === "string") return { ...base, kind, code: "invalid_nonce", result: bad(ctx) };
    const product = this.opts.catalog(ctx.sku);
    if (!product) return { ...base, kind, code: "invalid_result", result: bad(`unknown sku ${ctx.sku}`) };

    const d = await verifyDelegation({
      presentation,
      verifyL1: this.opts.l1Verifier,
      audience: this.clientId,
      payeeId: this.opts.payeeId,
      itemCategories: [product.category],
      ...(this.opts.now ? { now: this.opts.now } : {}),
    });
    const principal = d.principal ? { ...d.principal } : undefined;
    const mandate = d.mandateId && d.mandate && d.terms && d.expiresAt
      ? {
          id: d.mandateId, expiresAt: d.expiresAt, terms: d.terms, constraints: d.mandate.constraints,
          budget: d.budget ?? { max: 0, currency: d.terms.currency },
        }
      : undefined;
    const common = { ...base, kind, ...(principal ? { principal } : {}), ...(mandate ? { mandate } : {}), ...(d.mandate ? { agentId: d.mandate.agent_id } : {}) };
    if (!d.result.ok) {
      const code = d.result.violations.some((x) => /^(mandate|holder credential|agent proof):/.test(x)) ? "invalid_result" : "policy_not_satisfied";
      return { ...common, nonce: ctx.nonce, code, result: d.result };
    }
    if (d.mandate && (d.mandate.agent_id !== ctx.agentId || (artifact.agent_id !== undefined && artifact.agent_id !== ctx.agentId))) {
      return { ...common, nonce: ctx.nonce, code: "invalid_result", result: bad("the requesting agent is not the agent the mandate names") };
    }
    if (mandate) {
      const status = await this.recheck({ ...common, mandate, result: { ok: true } } as VerifiedProofV1);
      if (!status.result.ok) return { ...common, nonce: ctx.nonce, code: status.code ?? "mandate_revoked", result: status.result };
    }
    // The agent's checkout must be the basket THIS route asked to be signed for — at our price.
    const asked = ctx.transactionData.find((t) => t.type === TX_TEMPLATES.paymentItemized)?.payload as PaymentItemizedPayloadV1 | undefined;
    const got = d.checkout!;
    const want = asked && { currency: asked.currency, items: asked.items };
    const have = { currency: got.currency, items: got.items.map((i) => ({ quantity: i.quantity, unit_cost: i.unit_cost, label: i.label })) };
    if (!want || canonicalJson(want) !== canonicalJson(have) || got.items.some((i) => i.sku !== ctx.sku)) {
      return { ...common, nonce: ctx.nonce, code: "terms_mismatch", result: bad("the agent's checkout is not the basket this route requested") };
    }
    // Route policy applies to the delegating person's disclosed claims, exactly as
    // it would to a live presentation: a mandate cannot launder a missing predicate.
    const failed = (this.opts.predicates?.(ctx.sku) ?? []).filter((pred) => readClaim(principal?.claims ?? {}, pred.path) !== pred.equals);
    if (failed.length) return { ...common, nonce: ctx.nonce, code: "policy_not_satisfied", result: bad(...failed.map((f) => f.reason)) };
    if (!(await this.finishNonce(ctx, opts.consume))) {
      return { ...common, nonce: ctx.nonce, code: "invalid_nonce", result: bad("nonce was already used") };
    }
    return { ...common, nonce: ctx.nonce, resource: ctx.resource, sku: ctx.sku, result: { ok: true } };
  }

  private sweep(): void {
    const t = this.nowS();
    for (const [n, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(n);
  }
}

function bad(...violations: string[]): ValidationResult {
  return { ok: false, violations };
}
