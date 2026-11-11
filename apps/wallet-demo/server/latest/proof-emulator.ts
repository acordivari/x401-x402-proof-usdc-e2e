/**
 * An offline stand-in for the two Proof endpoints the latest flow talks to,
 * speaking their wire formats so the code that calls them is the code that
 * would call Proof:
 *
 *   POST /verifiable-credentials/v1/x401-signatures
 *        private_key_jwt client assertion (key from the verifier's CIMD) →
 *        402 behind a REAL x402 paywall (mock facilitator, nothing settles
 *        on-chain) → 200 { issuer_signature, kb_signature }. Paid once per
 *        presentation; 404 for an unknown record; 409 never (no async issuance).
 *   POST /verifiable-credentials/v1/x401-handoff
 *        an x401 payload with a signed `openid4vp-v1-signed` request plus a
 *        `return_uri` (the intermediary return channel) → 201 { request_uri },
 *        a link to the emulated hosted wallet page.
 *
 * Plus the wallet-provider side Proof keeps internally: where the in-page
 * wallet deposits detached signatures, and where the hosted wallet page reads
 * the handed-off request. Everything here is EMULATED and says so in the UI;
 * the live path calls Proof (see server/latest/index.ts).
 */
import { randomUUID } from "node:crypto";
import express, { Router, type Express } from "express";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import { MockFacilitator } from "@agentic-payments/merchant";
import {
  CLIENT_ASSERTION_TYPE,
  SIGNATURES_PATH,
  decodeDcApiRequest,
  type ClientIdMetadataDocument,
  type DetachedSignatures,
} from "@agentic-payments/credentials";

export const HANDOFF_PATH = "/verifiable-credentials/v1/x401-handoff";
/** Proof's PUBLISHED sandbox payTo for x401 signatures. Offline, nothing is ever sent to it. */
export const PROOF_SANDBOX_SIGNATURES_PAY_TO = "0x3b0b371ae3cb08f272b87319684f6518b3b313a0" as const;
/** Proof does not publish a per-presentation price; this one is the emulator's. */
export const EMULATED_SIGNATURE_PRICE_USD = "0.01";

export interface ProofEmulatorOptions {
  /** In-process CIMD resolution (Proof would GET the client_id URL). */
  resolveClientMetadata: (clientId: string) => Promise<ClientIdMetadataDocument | undefined>;
  /** The `aud` request objects must carry: the emulated presentation endpoint. */
  presentationAudience: string;
  /** Absolute URL prefix of the hosted wallet page (on the public origin). */
  hostedWalletBase: string;
  network: `eip155:${number}`;
  allowInsecureUri: boolean;
}

interface SignatureRecord extends DetachedSignatures {
  createdAt: number;
  paid: boolean;
}

export interface HandoffRecord {
  id: string;
  payload: Record<string, unknown>;
  request: string;
  returnUri: string;
  createdAt: number;
  delivered: boolean;
}

const SIGNATURE_TTL_MS = 3_600_000; // Proof keeps signatures for 1 hour
const HANDOFF_TTL_MS = 3_600_000;
/** Bound on outstanding records: deposits are unauthenticated in this emulator. */
const MAX_RECORDS = 5_000;

export class ProofEmulator {
  readonly signatures = new Map<string, SignatureRecord>();
  readonly handoffs = new Map<string, HandoffRecord>();
  /** Request-object jti → exp (unix s): accepted once, forgotten after expiry. */
  private readonly seenJti = new Map<string, number>();

  constructor(private readonly opts: ProofEmulatorOptions) {}

  private sweep(): void {
    const t = Date.now();
    for (const [k, r] of this.signatures) if (t - r.createdAt > SIGNATURE_TTL_MS) this.signatures.delete(k);
    for (const [k, r] of this.handoffs) if (t - r.createdAt > HANDOFF_TTL_MS) this.handoffs.delete(k);
    const nowS = Math.floor(t / 1000);
    for (const [k, exp] of this.seenJti) if (exp <= nowS) this.seenJti.delete(k);
  }

  /** Server-to-server API (what a verifier or an agent calls). Listen it on a loopback port. */
  serverApp(): Express {
    const app = express();
    app.use(express.json({ limit: "256kb" }));

    // Authenticate the verifier BEFORE the paywall, as Proof does (401 precedes 402),
    // and skip the paywall for a record that is already paid for.
    app.post(SIGNATURES_PATH, (req, res, next) => {
      void (async () => {
        this.sweep();
        const { id, client_assertion_type, client_assertion } = req.body ?? {};
        if (client_assertion_type !== CLIENT_ASSERTION_TYPE || typeof client_assertion !== "string") {
          return res.status(401).json({ error: "invalid_client", error_description: "private_key_jwt client assertion required" });
        }
        try {
          const unverified = JSON.parse(Buffer.from(client_assertion.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: string };
          const meta = unverified.iss ? await this.opts.resolveClientMetadata(unverified.iss) : undefined;
          const kid = decodeProtectedHeader(client_assertion).kid;
          const jwk = meta?.jwks.keys.find((k) => k.kid === kid);
          if (!meta || !jwk) throw new Error("unknown client or key");
          await jwtVerify(client_assertion, await importJWK(jwk, "ES256"), {
            issuer: meta.client_id,
            subject: meta.client_id,
            audience: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
          });
        } catch (err) {
          return res.status(401).json({ error: "invalid_client", error_description: (err as Error).message });
        }
        const rec = typeof id === "string" ? this.signatures.get(id) : undefined;
        if (!rec) return res.status(404).json({ error: "not_found", error_description: "unknown or expired signature record" });
        if (rec.paid) return res.json({ issuer_signature: rec.issuer_signature, kb_signature: rec.kb_signature });
        res.locals.record = rec;
        next();
      })().catch(next);
    });

    const server = new x402ResourceServer(new MockFacilitator());
    registerExactEvmScheme(server, { networks: [this.opts.network] });
    const routes = {
      [`POST ${SIGNATURES_PATH}`]: {
        accepts: {
          scheme: "exact",
          payTo: PROOF_SANDBOX_SIGNATURES_PAY_TO,
          price: `$${EMULATED_SIGNATURE_PRICE_USD}`,
          network: this.opts.network,
          maxTimeoutSeconds: 120,
        },
        description: "x401 presentation signatures (emulated)",
        mimeType: "application/json",
      },
    } as unknown as RoutesConfig;
    app.use(paymentMiddleware(routes, server));
    app.post(SIGNATURES_PATH, (_req, res) => {
      const rec = res.locals.record as SignatureRecord;
      rec.paid = true;
      res.json({ issuer_signature: rec.issuer_signature, kb_signature: rec.kb_signature });
    });

    app.post(HANDOFF_PATH, (req, res) => {
      void (async () => {
        this.sweep();
        try {
          const rec = await this.acceptHandoff(req.body);
          res.status(201).json({ request_uri: `${this.opts.hostedWalletBase}/${rec.id}` });
        } catch (err) {
          res.status(400).json({ errors: { request: [(err as Error).message] } });
        }
      })();
    });
    return app;
  }

  /** Validate a handoff the way Proof's endpoint documents it. */
  async acceptHandoff(body: unknown): Promise<HandoffRecord> {
    const payload = body as { credential_requirements?: { digital?: { requests?: { protocol?: string; data?: { request?: unknown } }[] } }; return_uri?: unknown };
    const requests = payload?.credential_requirements?.digital?.requests;
    if (!Array.isArray(requests) || requests.length !== 1) throw new Error("payload must carry exactly one Digital Credentials API request");
    const [entry] = requests;
    if (entry?.protocol !== "openid4vp-v1-signed") throw new Error("only openid4vp-v1-signed is supported");
    const request = entry.data?.request;
    if (typeof request !== "string") throw new Error("data.request must be a signed request object");
    const { header, claims } = decodeDcApiRequest(request);
    if (header.typ !== "oauth-authz-req+jwt" || header.alg !== "ES256") throw new Error("request object must be an ES256 oauth-authz-req+jwt");
    const meta = await this.opts.resolveClientMetadata(claims.client_id);
    const jwk = meta?.jwks.keys.find((k) => k.kid === header.kid);
    if (!meta || !jwk) throw new Error("request object is not signed by a registered key");
    await jwtVerify(request, await importJWK(jwk, "ES256"), { issuer: claims.client_id, audience: this.opts.presentationAudience });
    if (claims.response_mode !== "dc_api") throw new Error("response_mode must be dc_api");
    if (claims.exp - Math.floor(Date.now() / 1000) > 3600) throw new Error("exp must be at most one hour ahead");
    if (this.seenJti.has(claims.jti)) throw new Error("request object already used (jti)");
    this.sweep();
    if (this.handoffs.size >= MAX_RECORDS) throw new Error("handoff store full, retry later");
    if (typeof payload.return_uri !== "string") throw new Error("the emulator supports the return channel only (return_uri required)");
    const returnUrl = new URL(payload.return_uri);
    if (returnUrl.protocol !== "https:" && !this.opts.allowInsecureUri) throw new Error("return_uri must be https");
    if (!claims.expected_origins.includes(returnUrl.origin)) throw new Error("return_uri origin must be listed in expected_origins");
    this.seenJti.set(claims.jti, claims.exp);
    const rec: HandoffRecord = { id: randomUUID(), payload: payload as Record<string, unknown>, request, returnUri: payload.return_uri, createdAt: Date.now(), delivered: false };
    this.handoffs.set(rec.id, rec);
    return rec;
  }

  /** Browser-facing routes for the emulated wallet provider. Mount at e.g. /emulator/proof. */
  browserRouter(): Router {
    const r = Router();
    r.use(express.json({ limit: "64kb" }));
    // The in-page wallet deposits the signatures it detached (Proof does this internally).
    r.post("/wallet/signatures", (req, res) => {
      const { id, issuer_signature, kb_signature } = req.body ?? {};
      if (typeof id !== "string" || typeof issuer_signature !== "string" || typeof kb_signature !== "string") {
        return res.status(400).json({ error: "id, issuer_signature, kb_signature required" });
      }
      if (id.length > 128 || issuer_signature.length > 512 || kb_signature.length > 512) {
        return res.status(400).json({ error: "record too large" });
      }
      this.sweep();
      if (this.signatures.size >= MAX_RECORDS) return res.status(503).json({ error: "signature store full, retry later" });
      if (this.signatures.has(id)) return res.status(409).json({ error: "record exists" });
      this.signatures.set(id, { issuer_signature, kb_signature, createdAt: Date.now(), paid: false });
      res.status(201).json({ id });
    });
    // The hosted wallet page reads what was handed off to it.
    r.get("/handoff/:id", (req, res) => {
      const rec = this.handoffs.get(req.params.id);
      if (!rec) return res.status(404).json({ error: "unknown or expired handoff" });
      res.json({ id: rec.id, request: rec.request, return_uri: rec.returnUri, delivered: rec.delivered });
    });
    r.post("/handoff/:id/delivered", (req, res) => {
      const rec = this.handoffs.get(req.params.id);
      if (!rec) return res.status(404).json({ error: "unknown or expired handoff" });
      rec.delivered = true;
      res.json({ ok: true });
    });
    return r;
  }
}
