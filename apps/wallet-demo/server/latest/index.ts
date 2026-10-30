/**
 * The orchestrator's half of the LATEST variant. The July routes in
 * server/index.ts are untouched; this module adds its own, under /api/latest,
 * plus three public endpoints a current x401 deployment needs:
 *
 *   GET  /.well-known/proof-client.json   the merchant-verifier's CIMD (its client_id)
 *   POST /x401/return/:rid                the intermediary return channel a hosted
 *                                         wallet (Proof's, or the emulator's) POSTs to
 *   /emulator/proof/*                     (local mode) the emulated Proof wallet provider
 *
 * Roles, which differ from July's on purpose: the MERCHANT is the x401
 * verifier (it signs the request, verifies the presentation, enforces the
 * mandate); this orchestrator is only the user agent — it fetches, relays the
 * PROOF-REQUEST to the person's wallet, and retries. Nothing here signs an
 * authorization on anyone's behalf.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { Router, type Express, type Response } from "express";
import { calculateJwkThumbprint, type JWK } from "jose";
import {
  CIMD_PATH,
  LOCAL_CREDENTIAL_V1_VCT,
  PROOF_SCOPE_CATALOG,
  TX_TEMPLATE_CLAIM,
  LocalCredentialV1Issuer,
  InMemoryNonceStore,
  X401VerifierV1,
  buildClientIdMetadataDocument,
  canonicalJson,
  clientIdFor,
  decodeDcApiRequest,
  decodeTxData,
  demoHoldersV1,
  describeProofRequest,
  generateEs256Keys,
  httpSignatureResolver,
  inspectDelegation,
  verifyDelegationGrant,
  localL1Verifier,
  localPresentationVerifierV1,
  localRequestSigner,
  proofAgentsTrustList,
  proofApiBase,
  proofPresentationAudience,
  proofPresentationVerifierV1,
  proofRequestSigner,
  publicPart,
  sha256Base64url,
  verifyDcApiRequest,
  type ClientIdMetadataDocument,
  type CredentialResult,
  type DelegationRequest,
  type Jwk,
  type MandateConstraint,
  type X401Payload,
} from "@agentic-payments/credentials";
import { buildAgentDid, type PaymentSigner } from "@agentic-payments/shared";
import { CATALOG, findProduct, X401_BUY_PREFIX } from "@agentic-payments/merchant";
import {
  completePurchase,
  createLocalSigner,
  createPayingFetch,
  delegatedResult,
  pollOrder,
  requestProof,
  tracingFetch,
  type HttpExchange,
} from "@agentic-payments/agent";
import { RevocationRegistry } from "@agentic-payments/identity";
import {
  EMULATED_SIGNATURE_PRICE_USD,
  HANDOFF_PATH,
  PROOF_SANDBOX_SIGNATURES_PAY_TO,
  ProofEmulator,
} from "./proof-emulator.ts";
import { describeExchange } from "./describe.ts";

export type WalletPath = "demo" | "handoff" | "dc-api";
export const WALLET_PATHS: readonly WalletPath[] = ["demo", "handoff", "dc-api"];

export interface LatestConfig {
  /** live = Proof (signed requests verified by Proof's wallet, Proof SDK verifier); local = fully offline. */
  mode: "local" | "live";
  /** The origin browsers load the demo from; the CIMD is hosted here. */
  publicOrigin: string;
  /** Origins allowed to invoke the merchant's requests (the page itself, and dev servers locally). */
  expectedOrigins: [string, ...string[]];
  allowInsecureUri: boolean;
  network: `eip155:${number}`;
  merchantName: string;
  merchantPayTo: `0x${string}`;
  localIssuerId: string;
  /** How the merchant pays Proof for presentations: x402 (detached signatures) or its account. */
  signatureBilling: "x402" | "account";
  /** Catalog categories whose purchase needs `age_equal_or_over.18`. */
  ageRestrictedCategories: string[];
  /** Bind `session_data` next to the basket (local signer only; the SDK signs one template). */
  sessionData: boolean;
  proof: {
    environment: "sandbox" | "production";
    /** The verifier's ES256 key — its public half is in the CIMD. Required for live. */
    verifierPrivateJwk?: JWK;
    loginHint?: string;
    /** A funded Base Sepolia key that pays Proof for detached signatures over x402. */
    verifierEvmKey?: `0x${string}`;
  };
}

interface PurchaseState {
  id: string;
  sku: string;
  url: string;
  wallet: WalletPath;
  payload: X401Payload;
  exchanges: HttpExchange[];
  returnId?: string;
  requestUri?: string;
  status: "awaiting-wallet" | "completing" | "settled" | "refused" | "error";
  outcome?: Record<string, unknown>;
  startedAt: number;
}

interface AgentRun {
  at: number;
  purchases: Record<string, unknown>[];
}

export interface LatestSession {
  purchase?: PurchaseState;
  mandateRequest?: DelegationRequest;
  delegation?: { delegation: string; mandateId: string; acceptedAt: number };
  runs?: AgentRun[];
}

export interface LatestSessionHost {
  latest?: LatestSession;
}

export interface LatestStack {
  /** Pass to createMerchantApp({ x401 }) — the merchant is the verifier. */
  merchantX401: { verifier: X401VerifierV1; merchantName: string; sessionData: boolean };
  cimd: ClientIdMetadataDocument;
  mode: "local" | "live";
  /** Mount the routes. Call after the merchant is listening. */
  mount(app: Express, ctx: MountContext): void;
  close(): void;
}

export interface MountContext {
  merchantUrl: string;
  /** The SPA's index.html, served for the emulated hosted wallet page. */
  indexHtmlPath: string;
  sessionOf(res: Response): LatestSessionHost;
  sidOf(res: Response): string;
  loadSession(sid: string): Promise<LatestSessionHost | undefined>;
  saveSession(sid: string, s: LatestSessionHost): Promise<void>;
}

const ensure = (host: LatestSessionHost): LatestSession => (host.latest ??= {});

export async function createLatestStack(cfg: LatestConfig, deps: { agentSigner: PaymentSigner }): Promise<LatestStack> {
  const live = cfg.mode === "live";
  if (live && !cfg.proof.verifierPrivateJwk) throw new Error("latest live mode needs the verifier key (PROOF_VERIFIER_KEY)");

  // --- the merchant-verifier's identity: an ES256 key published in its CIMD ---
  const verifierPrivateJwk = (cfg.proof.verifierPrivateJwk ?? (await generateEs256Keys()).privateJwk) as JWK;
  const verifierKid = await calculateJwkThumbprint(publicPart(verifierPrivateJwk));
  const clientId = clientIdFor(cfg.publicOrigin);
  const cimd = await buildClientIdMetadataDocument({
    clientId,
    clientName: cfg.merchantName,
    jwks: [{ ...publicPart(verifierPrivateJwk), kid: verifierKid }],
    // Live CIMDs also admit Proof's trusted agents (MCP, assistants) via the trust list.
    redirectUris: [...cfg.expectedOrigins, ...(live ? [proofAgentsTrustList(cfg.proof.environment)] : [])],
  });
  const walletAudience = live
    ? proofPresentationAudience(cfg.proof.environment)
    : `${cfg.publicOrigin}/emulator/proof/verifiable-credentials/v1/presentation`;
  const requestSigner = live
    ? proofRequestSigner({ environment: cfg.proof.environment, clientId, privateJwk: verifierPrivateJwk })
    : localRequestSigner({ clientId, audience: walletAudience, privateJwk: verifierPrivateJwk });

  // --- local issuer for ProofCredentialV1-shaped credentials (offline only) ---
  const issuerKeys = await generateEs256Keys();
  const issuer = new LocalCredentialV1Issuer({ issuerId: cfg.localIssuerId, privateJwk: issuerKeys.privateJwk });
  const issuerKid = (await sha256Base64url(JSON.stringify(issuerKeys.publicJwk))).slice(0, 16);

  // --- the emulated Proof (local mode): signatures paywall + handoff relay ---
  let emulator: ProofEmulator | undefined;
  let emulatorServer: Server | undefined;
  let emulatorUrl = "";
  if (!live) {
    emulator = new ProofEmulator({
      resolveClientMetadata: async (id) => (id === clientId ? cimd : undefined),
      presentationAudience: walletAudience,
      hostedWalletBase: `${cfg.publicOrigin}/emulator/proof/wallet`,
      network: cfg.network,
      allowInsecureUri: cfg.allowInsecureUri,
    });
    // Loopback only: only this process (as agent and as merchant-verifier) calls it.
    emulatorServer = await new Promise<Server>((resolve) => {
      const s = emulator!.serverApp().listen(0, "127.0.0.1", () => resolve(s));
    });
    emulatorUrl = `http://127.0.0.1:${(emulatorServer.address() as AddressInfo).port}`;
  }

  // --- what the merchant uses to pay Proof for detached signatures ---
  const verifierPayer = live
    ? cfg.proof.verifierEvmKey ? createLocalSigner(cfg.proof.verifierEvmKey) : undefined
    : createLocalSigner();
  const verifierFetch = verifierPayer ? await createPayingFetch(verifierPayer, { network: cfg.network }) : fetch;

  const presentationVerifier = live
    ? proofPresentationVerifierV1({ environment: cfg.proof.environment, clientId, privateJwk: verifierPrivateJwk, fetch: verifierFetch })
    : localPresentationVerifierV1({
        issuerId: cfg.localIssuerId,
        issuerPublicJwk: issuerKeys.publicJwk,
        vct: LOCAL_CREDENTIAL_V1_VCT,
        signatures: httpSignatureResolver({ baseUrl: emulatorUrl, clientId, privateJwk: verifierPrivateJwk, fetch: verifierFetch }),
      });

  // Delegate Authority is early access at Proof: the holder key lives in Proof's
  // Cloud Wallet, so only the local wallet can sign an L2 today.
  const l1Verifier = live
    ? undefined
    : localL1Verifier({ issuerId: cfg.localIssuerId, issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT });
  const revocations = new RevocationRegistry();
  const restricted = new Set(cfg.ageRestrictedCategories);
  const verifier = new X401VerifierV1({
    requestSigner,
    presentationVerifier,
    nonceStore: new InMemoryNonceStore(),
    expectedOrigins: cfg.expectedOrigins,
    ...(l1Verifier ? { l1Verifier } : {}),
    payeeId: cfg.merchantPayTo,
    catalog: findProduct,
    predicates: (sku) =>
      restricted.has(findProduct(sku)?.category ?? "")
        ? [{ path: ["age_equal_or_over", "18"], equals: true, reason: "this product is age-restricted: age_equal_or_over.18 must be disclosed and true" }]
        : [],
    revocation: revocations,
    allowInsecureUri: cfg.allowInsecureUri,
  });

  // --- the agent: an EVM wallet that pays + an ES256 key a mandate can name ---
  const agentKeys = await generateEs256Keys();
  const agentKid = await calculateJwkThumbprint(agentKeys.publicJwk as JWK);
  const agentJwk: Jwk = { ...agentKeys.publicJwk, kid: agentKid };
  const agentId = buildAgentDid(cfg.network, deps.agentSigner.address);
  const categories = [...new Set(CATALOG.map((p) => p.category))];

  const info = () => ({
    mode: cfg.mode,
    emulated: !live,
    publicOrigin: cfg.publicOrigin,
    verifier: {
      clientId,
      clientName: cfg.merchantName,
      cimd,
      expectedOrigins: cfg.expectedOrigins,
      walletAudience,
      trustAnchor: presentationVerifier.trustAnchor,
      // Whether a default login_hint is configured (never the value itself).
      loginHintConfigured: Boolean(live && cfg.proof.loginHint),
      signatureBilling: cfg.signatureBilling,
      signaturePrice: live ? undefined : { usd: EMULATED_SIGNATURE_PRICE_USD, payTo: PROOF_SANDBOX_SIGNATURES_PAY_TO, emulated: true },
      maxTransactionData: Number.isFinite(requestSigner.maxTransactionData) ? requestSigner.maxTransactionData : null,
      delegatedAuthority: Boolean(l1Verifier),
      ageRestrictedCategories: cfg.ageRestrictedCategories,
    },
    issuer: live ? undefined : { id: cfg.localIssuerId, vct: LOCAL_CREDENTIAL_V1_VCT, kid: issuerKid },
    agent: { id: agentId, wallet: deps.agentSigner.address, jwk: agentJwk, kid: agentKid },
    merchant: { payTo: cfg.merchantPayTo, name: cfg.merchantName },
    scopes: Object.values(PROOF_SCOPE_CATALOG).map((s) => ({ ...s, disclosures: s.disclosures.map((p) => p.join(".")) })),
    templates: Object.entries(TX_TEMPLATE_CLAIM).map(([type, claim]) => ({ type, claim })),
    personas: Object.keys(demoHoldersV1()),
    categories,
    walletPaths: live ? (["handoff", "dc-api"] as WalletPath[]) : (["demo", "handoff", "dc-api"] as WalletPath[]),
  });

  function mount(app: Express, ctx: MountContext): void {
    const merchantRoute = (sku: string) => `${ctx.merchantUrl}${X401_BUY_PREFIX}/${sku}`;
    /** rid → session id for the return channel (Proof's POST carries no cookie). */
    const returns = new Map<string, { sid: string; purchaseId: string; createdAt: number }>();

    app.get(CIMD_PATH, (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(cimd);
    });

    if (emulator) {
      app.use("/emulator/proof", emulator.browserRouter());
      const html = () => readFileSync(ctx.indexHtmlPath, "utf8");
      app.get("/emulator/proof/wallet/:id", (_req, res) => {
        try {
          res.type("html").send(html());
        } catch {
          res.status(503).send("web UI not built — run `npm run build:web`");
        }
      });
    }

    async function completeFor(p: PurchaseState, credentialResult: CredentialResult): Promise<void> {
      p.status = "completing";
      try {
        const traced = tracingFetch(p.exchanges);
        const payingFetch = await createPayingFetch(deps.agentSigner, { network: cfg.network, baseFetch: traced });
        const out = await completePurchase({
          url: p.url,
          requirement: describeProofRequest(p.payload),
          credentialResult,
          agentId,
          payingFetch,
          fetch: traced,
          headers: { "Idempotency-Key": p.id },
        });
        const receipt = out.body.receipt as { paymentNonce?: string } | undefined;
        const settled = out.ok && receipt?.paymentNonce
          ? await pollOrder(ctx.merchantUrl, receipt.paymentNonce, { delayMs: 50 })
          : undefined;
        p.outcome = {
          ok: out.ok,
          status: out.status,
          ...(receipt ? { receipt } : {}),
          ...(settled ? { settled } : {}),
          ...(out.token ? { token: { ok: out.token.ok, status: out.token.status, expiresIn: out.token.expiresIn, x401: out.token.body.x401, error: out.token.body.error_description } } : {}),
          ...(out.proofResult ? { proofResult: out.proofResult } : {}),
          ...(!out.ok ? { refusal: (out.body.error_description ?? out.body.error ?? out.token?.body.error_description) as string | undefined } : {}),
        };
        p.status = out.ok ? "settled" : "refused";
      } catch (err) {
        p.outcome = { ok: false, error: String(err) };
        p.status = "error";
      }
    }

    // --- the intermediary return channel (spec: "Relayed Delivery to a Remote Handler") ---
    app.post("/x401/return/:rid", express.json({ limit: "256kb" }), (req, res) => {
      void (async () => {
        const entry = returns.get(req.params.rid);
        if (!entry) return res.status(404).json({ error: "unknown or used return channel" });
        returns.delete(req.params.rid); // single-use
        const host = await ctx.loadSession(entry.sid);
        const p = host?.latest?.purchase;
        if (!host || !p || p.id !== entry.purchaseId || p.status !== "awaiting-wallet") {
          return res.status(409).json({ error: "the purchase this result was for is no longer waiting" });
        }
        const body = req.body as CredentialResult;
        if (!body || typeof body.protocol !== "string" || body.data === undefined) {
          return res.status(400).json({ error: "expected a { protocol, data } credential result" });
        }
        res.status(202).json({ accepted: true });
        await completeFor(p, body);
        await ctx.saveSession(entry.sid, host);
      })().catch((err) => {
        // Never let a store failure on this unauthenticated route take the process down.
        console.error("[demo] x401 return channel:", err);
        if (!res.headersSent) res.status(500).json({ error: "return channel failed" });
      });
    });

    const r = Router();
    r.get("/me", (_req, res) => {
      const s = ensure(ctx.sessionOf(res));
      res.json({ ...info(), session: viewSession(s) });
    });

    r.post("/wallet/issue", async (req, res) => {
      if (live) return res.status(400).json({ error: "live mode uses your Proof credential, not a local one" });
      const { holderPublicJwk, persona } = req.body ?? {};
      const claims = demoHoldersV1()[String(persona)];
      if (!holderPublicJwk || typeof holderPublicJwk !== "object" || !claims) {
        return res.status(400).json({ error: `holderPublicJwk + persona (one of ${Object.keys(demoHoldersV1()).join(", ")}) required` });
      }
      try {
        const compact = await issuer.issue(claims, holderPublicJwk as Jwk);
        res.json({ credential: { compact, persona, claims, issuerKid, vct: LOCAL_CREDENTIAL_V1_VCT, issuer: cfg.localIssuerId } });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    r.post("/purchase/start", async (req, res) => {
      const s = ensure(ctx.sessionOf(res));
      const sku = String(req.body?.sku ?? "");
      const wallet = req.body?.wallet as WalletPath;
      // Live only: whom Proof should ask. The visitor's own entry wins, else the
      // operator's PROOF_LOGIN_HINT. Offline there is no one to look up.
      const typed = typeof req.body?.loginHint === "string" ? req.body.loginHint.trim() : "";
      if (typed && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(typed)) {
        return res.status(400).json({ error: "loginHint must be an email address" });
      }
      const loginHint = live ? typed || cfg.proof.loginHint : undefined;
      if (!findProduct(sku)) return res.status(400).json({ error: "unknown sku" });
      if (!info().walletPaths.includes(wallet)) return res.status(400).json({ error: `wallet must be one of ${info().walletPaths.join(", ")}` });
      const exchanges: HttpExchange[] = [];
      const url = merchantRoute(sku);
      try {
        const pr = await requestProof(url, {
          agentId,
          ...(loginHint ? { loginHint } : {}),
          fetch: tracingFetch(exchanges),
          allowInsecureUri: cfg.allowInsecureUri,
        });
        if (!pr.requirement) return res.status(502).json({ error: `merchant answered ${pr.status} without a PROOF-REQUEST` });
        const p: PurchaseState = {
          id: randomUUID(), sku, url, wallet, payload: pr.requirement.payload, exchanges,
          status: "awaiting-wallet", startedAt: Date.now(),
        };
        if (wallet === "handoff") {
          // The orchestrator is the relaying intermediary: it adds the return
          // channel and hands the request, unchanged, to the wallet provider.
          const rid = randomBytes(24).toString("base64url");
          const returnUri = `${cfg.publicOrigin}/x401/return/${rid}`;
          const handoffBase = live ? proofApiBase(cfg.proof.environment) : emulatorUrl;
          const hr = await tracingFetch(exchanges)(`${handoffBase}${HANDOFF_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...pr.requirement.payload, return_uri: returnUri }),
          });
          const hb = (await hr.json().catch(() => ({}))) as { request_uri?: string; errors?: unknown };
          if (!hr.ok || !hb.request_uri) return res.status(502).json({ error: `handoff refused (${hr.status}): ${JSON.stringify(hb.errors ?? hb)}` });
          returns.set(rid, { sid: ctx.sidOf(res), purchaseId: p.id, createdAt: Date.now() });
          p.returnId = rid;
          p.requestUri = hb.request_uri;
        }
        s.purchase = p;
        res.json({ purchase: viewPurchase(p) });
      } catch (err) {
        res.status(502).json({ error: String(err) });
      }
    });

    r.post("/purchase/complete", async (req, res) => {
      const s = ensure(ctx.sessionOf(res));
      const p = s.purchase;
      if (!p || p.status !== "awaiting-wallet") return res.status(400).json({ error: "no purchase is waiting for a credential result" });
      const result = req.body?.credentialResult as CredentialResult | undefined;
      if (!result || typeof result.protocol !== "string") return res.status(400).json({ error: "credentialResult { protocol, data } required" });
      await completeFor(p, result);
      res.json({ purchase: viewPurchase(p) });
    });

    r.post("/mandate/request", (req, res) => {
      if (!l1Verifier) return res.status(400).json({ error: "Delegate Authority is early access at Proof; this deployment runs it only in local mode" });
      const s = ensure(ctx.sessionOf(res));
      const budget = Number(req.body?.budgetUsd ?? 5);
      const perPurchase = Number(req.body?.perPurchaseUsd ?? budget);
      const hours = Number(req.body?.validityHours ?? 24);
      const cats: string[] = Array.isArray(req.body?.categories) ? req.body.categories.filter((c: unknown) => typeof c === "string" && categories.includes(c)) : categories;
      if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return res.status(400).json({ error: "budgetUsd must be a positive amount up to 1000" });
      if (!Number.isFinite(perPurchase) || perPurchase <= 0 || perPurchase > budget) return res.status(400).json({ error: "perPurchaseUsd must be positive and at most the budget" });
      // Verifiable Intent's autonomous mode spans 24 hours to 30 days.
      if (!Number.isFinite(hours) || hours < 1 || hours > 720) return res.status(400).json({ error: "validityHours must be 1–720" });
      if (cats.length === 0) return res.status(400).json({ error: `categories must include at least one of ${categories.join(", ")}` });
      const amount = Math.round(budget * 100) / 100;
      const until = new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const payee = { id: cfg.merchantPayTo, name: cfg.merchantName, website: "https://verygood-rx.example" };
      const constraints: MandateConstraint[] = [
        { type: "mandate.payment.budget", max: amount, currency: "USD" },
        { type: "mandate.payment.amount_range", max: Math.round(perPurchase * 100) / 100, currency: "USD" },
        { type: "mandate.payment.allowed_payees", payees: [payee] },
        { type: "x-agentic-payments.allowed_categories", categories: cats },
      ];
      const request: DelegationRequest = {
        agent: { id: agentId, jwk: agentJwk, kid: agentKid },
        terms: {
          prompt_summary: `Let my agent spend up to $${amount.toFixed(2)} at ${cfg.merchantName} on ${cats.join(", ")}, at most $${perPurchase.toFixed(2)} per purchase, until ${until}.`,
          payment_instrument: { type: "crypto", id: `usdc:${cfg.network}:${deps.agentSigner.address}`, description: "Agent USDC wallet (Base Sepolia)" },
          payee,
          amount,
          currency: "USD",
        },
        constraints,
        validitySeconds: Math.round(hours * 3600),
      };
      s.mandateRequest = request;
      res.json({ request });
    });

    r.post("/mandate/accept", async (req, res) => {
      const s = ensure(ctx.sessionOf(res));
      const pending = s.mandateRequest;
      if (!pending || !l1Verifier) return res.status(400).json({ error: "no mandate request to accept" });
      const delegation = String(req.body?.delegation ?? "");
      try {
        // Verify the grant before carrying it: the holder credential chains to
        // the issuer and the mandate is signed by that credential's key.
        const grant = await verifyDelegationGrant({ delegation, verifyL1: l1Verifier });
        if (!grant.result.ok) throw new Error(grant.result.violations.join("; "));
        const got = inspectDelegation(delegation);
        // What came back must be exactly what the agent asked for: the agent's
        // key, the terms, the constraints. A wallet that signed something else
        // produced a mandate this agent will not carry.
        if (got.mandate.cnf.kid !== agentKid || got.mandate.agent_id !== agentId) throw new Error("mandate names a different agent");
        if (canonicalJson(got.terms) !== canonicalJson(pending.terms)) throw new Error("mandate terms differ from the request");
        if (canonicalJson(got.mandate.constraints) !== canonicalJson(pending.constraints)) throw new Error("mandate constraints differ from the request");
        s.delegation = { delegation, mandateId: grant.mandateId!, acceptedAt: Date.now() };
        s.mandateRequest = undefined;
        s.runs = [];
        res.json({ delegation: viewDelegation(s) });
      } catch (err) {
        res.status(400).json({ error: `not accepted: ${(err as Error).message}` });
      }
    });

    r.post("/agent/run", async (req, res) => {
      const s = ensure(ctx.sessionOf(res));
      if (!s.delegation) return res.status(400).json({ error: "no standing mandate — grant one first" });
      const raw = req.body?.skus;
      if (raw !== undefined && (!Array.isArray(raw) || raw.length === 0 || raw.length > 10 || !raw.every((x) => typeof x === "string"))) {
        return res.status(400).json({ error: "skus must be a non-empty array of up to 10 strings" });
      }
      const skus: string[] = raw ?? ["allergy-relief-24", "vitamin-d3-2000", "ibuprofen-200", "toothpaste-mint"];
      const purchases: Record<string, unknown>[] = [];
      for (const sku of skus) {
        const product = findProduct(sku);
        if (!product) { purchases.push({ sku, ok: false, refusal: "unknown sku" }); continue; }
        const exchanges: HttpExchange[] = [];
        const traced = tracingFetch(exchanges);
        try {
          const pr = await requestProof(merchantRoute(sku), { agentId, fetch: traced, allowInsecureUri: cfg.allowInsecureUri });
          if (!pr.requirement) throw new Error(`merchant answered ${pr.status} without a PROOF-REQUEST`);
          // Before signing anything for this merchant, authenticate its request
          // (relayed fulfillment: no invoking origin, but signature, client_id,
          // audience and expiry still hold).
          await verifyDcApiRequest({ request: pr.requirement.request, metadata: cimd, audience: walletAudience });
          const credentialResult = await delegatedResult({
            requirement: pr.requirement,
            delegation: s.delegation.delegation,
            agentPrivateJwk: agentKeys.privateJwk,
            merchant: { id: cfg.merchantPayTo, name: cfg.merchantName },
            sku,
            category: product.category,
          });
          const payingFetch = await createPayingFetch(deps.agentSigner, { network: cfg.network, baseFetch: traced });
          const out = await completePurchase({
            url: merchantRoute(sku), requirement: pr.requirement, credentialResult, agentId, payingFetch, fetch: traced,
            headers: { "Idempotency-Key": randomUUID() },
          });
          const receipt = out.body.receipt as { paymentNonce?: string } | undefined;
          const settled = out.ok && receipt?.paymentNonce ? await pollOrder(ctx.merchantUrl, receipt.paymentNonce, { delayMs: 50 }) as { state?: string } | undefined : undefined;
          purchases.push({
            sku, name: product.name, priceUsd: product.priceUsd, category: product.category,
            ok: out.ok, status: out.status, settled: settled?.state === "SETTLED",
            ...(!out.ok ? { refusal: out.body.error_description ?? out.token?.body.error_description ?? out.body.error } : {}),
            ...(out.proofResult ? { proofResult: out.proofResult } : {}),
            exchanges: exchanges.map(describeExchange),
          });
        } catch (err) {
          purchases.push({ sku, name: product.name, priceUsd: product.priceUsd, ok: false, refusal: String(err), exchanges: exchanges.map(describeExchange) });
        }
      }
      const run = { at: Date.now(), purchases };
      // Keep only the latest run: each carries decoded exchanges, and session
      // state on an ungated demo must stay small.
      s.runs = [run];
      res.json({ run, delegation: viewDelegation(s) });
    });

    r.post("/mandate/revoke", (req, res) => {
      const s = ensure(ctx.sessionOf(res));
      if (!s.delegation) return res.status(400).json({ error: "no mandate to revoke" });
      const rec = revocations.revoke(s.delegation.mandateId, String(req.body?.reason ?? "revoked by the person who granted it"));
      res.json({ revoked: true, id: rec.intentId, revokedAt: rec.revokedAt });
    });

    r.post("/reset", (_req, res) => {
      const host = ctx.sessionOf(res);
      if (host.latest?.purchase?.returnId) returns.delete(host.latest.purchase.returnId);
      host.latest = {};
      res.json({ ok: true });
    });

    app.use("/api/latest", r);

    // Bound the return-channel map; entries are useless after the handoff lifetime.
    const sweep = setInterval(() => {
      const cutoff = Date.now() - 3_600_000;
      for (const [k, v] of returns) if (v.createdAt < cutoff) returns.delete(k);
    }, 600_000);
    sweep.unref();
  }

  function viewPurchase(p: PurchaseState) {
    let request: Record<string, unknown> | undefined;
    try {
      const d = describeProofRequest(p.payload);
      request = { claims: d.claims, transactionData: d.transactionData, raw: d.request };
    } catch { /* display only */ }
    return {
      id: p.id, sku: p.sku, wallet: p.wallet, status: p.status, startedAt: p.startedAt,
      url: p.url.replace(/^https?:\/\/[^/]+/, ""),
      // What the browser hands to navigator.credentials.get() / the demo wallet, unchanged.
      credentialRequirements: p.payload.credential_requirements,
      payload: { ...p.payload, credential_requirements: "[see request]" },
      request,
      ...(p.requestUri ? { requestUri: p.requestUri } : {}),
      exchanges: p.exchanges.map(describeExchange),
      ...(p.outcome ? { outcome: p.outcome } : {}),
    };
  }

  function viewDelegation(s: LatestSession) {
    if (!s.delegation) return undefined;
    const d = inspectDelegation(s.delegation.delegation);
    const id = s.delegation.mandateId; // holder-scoped key, as the merchant tracks it
    return {
      mandateId: id, terms: d.terms, constraints: d.mandate.constraints, agentId: d.mandate.agent_id,
      issuedAt: d.issuedAt, expiresAt: d.expiresAt, revoked: revocations.isRevoked(id),
      size: s.delegation.delegation.length,
      layers: ["L1 holder credential (issuer-signed, selectively disclosed)", "L2 mandate (signed by the holder's credential key)"],
    };
  }

  function viewSession(s: LatestSession) {
    return {
      ...(s.purchase ? { purchase: viewPurchase(s.purchase) } : {}),
      ...(s.mandateRequest ? { mandateRequest: s.mandateRequest } : {}),
      ...(s.delegation ? { delegation: viewDelegation(s) } : {}),
      runs: s.runs ?? [],
    };
  }

  return {
    merchantX401: { verifier, merchantName: cfg.merchantName, sessionData: cfg.sessionData },
    cimd,
    mode: cfg.mode,
    mount,
    close: () => { emulatorServer?.close(); },
  };
}
