/**
 * Signed OID4VP requests for the W3C Digital Credentials API — what a current
 * x401 PROOF-REQUEST carries.
 *
 * The July build put a bare `{ nonce, scope }` object into
 * `credential_requirements.digital.requests[0].data` and drove Proof through a
 * redirect URL. A current verifier instead SIGNS an OID4VP request object (a
 * JAR, `typ: oauth-authz-req+jwt`, ES256) with the key published in its Client
 * ID Metadata Document, and puts that compact JWS at `data.request` under
 * `protocol: "openid4vp-v1-signed"`. The same bytes work three ways: passed
 * straight to `navigator.credentials.get()` (a browser wallet), relayed to a
 * remote handler (Proof's handoff endpoint), or fulfilled by our in-page demo
 * wallet — which is exactly the property the x401 spec asks for.
 *
 * Browser-safe: jose only, no Node built-ins. The wallet half
 * (`verifyDcApiRequest`) runs in the demo wallet in the page.
 */
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { encodeTxData, type TransactionDataV1 } from "./templates.ts";
import type { ClientIdMetadataDocument } from "./client-metadata.ts";

export const REQUEST_OBJECT_TYP = "oauth-authz-req+jwt";
export const REQUEST_OBJECT_ALG = "ES256";
export const DEFAULT_REQUEST_LIFETIME_SECONDS = 300;

/** What the verifier asks for. Mirrors the SDK's `DCAPIAuthorizationRequestParams`. */
export interface DcApiRequestParams {
  scope: string;
  nonce: string;
  /** Web origins allowed to invoke the request; must be in the CIMD's redirect_uris. */
  expectedOrigins: [string, ...string[]];
  transactionData?: TransactionDataV1[];
  loginHint?: string;
  state?: string;
}

/** The claims of a signed DC API request object. */
export interface DcApiRequestClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  client_id: string;
  response_type: "vp_token";
  response_mode: "dc_api";
  nonce: string;
  expected_origins: string[];
  scope?: string;
  state?: string;
  login_hint?: string;
  /** base64url-encoded `transaction_data` objects, one per template. */
  transaction_data?: string[];
}

/** The swappable request-signing seam: local key vs the Proof SDK client. */
export interface DcApiRequestSigner {
  /** The verifier's client_id — its CIMD URL. */
  readonly clientId: string;
  /** The audience the request object is addressed to (the wallet/presentation issuer). */
  readonly audience: string;
  /** How many `transaction_data` values one request may carry. */
  readonly maxTransactionData: number;
  signedDcApiRequest(params: DcApiRequestParams): Promise<string>;
}

export interface LocalRequestSignerOptions {
  clientId: string;
  /** For Proof this is `<base>/verifiable-credentials/v1/presentation`; locally, the demo wallet id. */
  audience: string;
  privateJwk: JWK;
  lifetimeSeconds?: number;
  now?: () => number;
}

/**
 * Sign request objects with a local ES256 key, claim-for-claim what the SDK's
 * `signedDcApiRequest` produces — except that it carries every
 * `transaction_data` value it is given (the SDK helper takes one).
 */
export function localRequestSigner(opts: LocalRequestSignerOptions): DcApiRequestSigner {
  const lifetime = opts.lifetimeSeconds ?? DEFAULT_REQUEST_LIFETIME_SECONDS;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let kid: string | undefined;
  return {
    clientId: opts.clientId,
    audience: opts.audience,
    maxTransactionData: Number.POSITIVE_INFINITY,
    async signedDcApiRequest(p) {
      if (!Array.isArray(p.expectedOrigins) || p.expectedOrigins.length === 0) {
        throw new Error("expectedOrigins must be a non-empty array of origins");
      }
      if (!p.nonce || p.nonce.length < 16) throw new Error("nonce must be at least 16 characters");
      kid ??= await calculateJwkThumbprint(publicPart(opts.privateJwk));
      const key = await importJWK(opts.privateJwk, REQUEST_OBJECT_ALG);
      const iat = now();
      const claims = {
        client_id: opts.clientId,
        response_type: "vp_token",
        response_mode: "dc_api",
        nonce: p.nonce,
        expected_origins: p.expectedOrigins,
        scope: p.scope,
        ...(p.state !== undefined ? { state: p.state } : {}),
        ...(p.loginHint !== undefined ? { login_hint: p.loginHint } : {}),
        ...(p.transactionData?.length ? { transaction_data: p.transactionData.map(encodeTxData) } : {}),
      };
      return new SignJWT(claims)
        .setProtectedHeader({ typ: REQUEST_OBJECT_TYP, alg: REQUEST_OBJECT_ALG, kid })
        .setIssuer(opts.clientId)
        .setAudience(opts.audience)
        .setIssuedAt(iat)
        .setExpirationTime(iat + lifetime)
        .setJti(crypto.randomUUID())
        .sign(key);
    },
  };
}

/**
 * The public half of an EC (or OKP) JWK: only the public members survive. A
 * WebCrypto-exported private key also carries `key_ops: ["sign"]` and `ext`,
 * which would make the "public" copy unimportable for verification.
 */
export function publicPart(jwk: JWK): JWK {
  const pub: JWK = {};
  for (const k of ["kty", "crv", "x", "y", "kid", "alg", "use"] as const) {
    if (jwk[k] !== undefined) (pub as Record<string, unknown>)[k] = jwk[k];
  }
  return pub;
}

/** Read a request object's claims WITHOUT verifying it (display only). */
export function decodeDcApiRequest(request: string): { header: Record<string, unknown>; claims: DcApiRequestClaims } {
  const [h, p] = request.split(".");
  if (!h || !p) throw new Error("request object is not a compact JWS");
  const dec = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  return { header: dec(h), claims: dec(p) as DcApiRequestClaims };
}

export interface VerifyDcApiRequestInput {
  request: string;
  /** The verifier's metadata, fetched from its client_id URL. */
  metadata: ClientIdMetadataDocument;
  /**
   * The web origin invoking the request (the DC API passes this to the wallet).
   * Omit for relayed fulfillment, where — per the x401 spec — there is no
   * invoking origin and `expected_origins` is not enforced; the signature,
   * `client_id`, audience and expiry still are.
   */
  origin?: string;
  /** This wallet's identifier; the request must be addressed to it. */
  audience: string;
  /**
   * Resolve an agents trust list (`<base>/.well-known/agents-trust-list`, one
   * origin per line). Proof's CIMDs list the trust list URL itself in
   * `redirect_uris` / `expected_origins` to mean "any agent on this list".
   */
  resolveTrustList?: (url: string) => Promise<string[]>;
  now?: () => number;
}

export const isAgentsTrustListUrl = (u: string): boolean => /\/\.well-known\/agents-trust-list$/.test(u);

/** Parse the trust list body: one origin per line, blanks ignored. */
export function parseAgentsTrustList(body: string): string[] {
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

async function originAllowed(
  origin: string,
  list: readonly string[],
  resolve: VerifyDcApiRequestInput["resolveTrustList"],
): Promise<boolean> {
  if (list.includes(origin)) return true;
  if (!resolve) return false;
  for (const url of list.filter(isAgentsTrustListUrl)) {
    if ((await resolve(url)).includes(origin)) return true;
  }
  return false;
}

export interface VerifiedDcApiRequest {
  claims: DcApiRequestClaims;
  /** The verifier's display name from its metadata. */
  clientName?: string;
}

/**
 * The wallet's side: authenticate the verifier and the invocation before
 * showing a consent screen. A signed request is only as good as these checks —
 * key from the verifier's OWN metadata document, client_id equal to that
 * document's URL, our audience, unexpired, and the calling origin listed in
 * both the request's `expected_origins` and the metadata's `redirect_uris`.
 */
export async function verifyDcApiRequest(input: VerifyDcApiRequestInput): Promise<VerifiedDcApiRequest> {
  const header = decodeProtectedHeader(input.request);
  if (header.typ !== REQUEST_OBJECT_TYP) throw new Error(`request typ ${String(header.typ)} is not ${REQUEST_OBJECT_TYP}`);
  if (header.alg !== REQUEST_OBJECT_ALG) throw new Error(`request alg ${String(header.alg)} is not ${REQUEST_OBJECT_ALG}`);
  const jwk = input.metadata.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("request is signed by a key the verifier's metadata does not publish");
  const key = await importJWK(jwk, REQUEST_OBJECT_ALG);
  const nowS = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
  const { payload } = await jwtVerify(input.request, key, {
    issuer: input.metadata.client_id,
    audience: input.audience,
    typ: REQUEST_OBJECT_TYP,
    currentDate: new Date(nowS * 1000),
  });
  const claims = payload as unknown as DcApiRequestClaims;
  if (claims.client_id !== input.metadata.client_id) throw new Error("request client_id does not match the verifier metadata");
  if (claims.response_mode !== "dc_api") throw new Error(`unsupported response_mode ${claims.response_mode}`);
  if (claims.response_type !== "vp_token") throw new Error(`unsupported response_type ${claims.response_type}`);
  if (input.origin !== undefined) {
    if (!Array.isArray(claims.expected_origins) ||
        !(await originAllowed(input.origin, claims.expected_origins, input.resolveTrustList))) {
      throw new Error(`origin ${input.origin} is not in the request's expected_origins`);
    }
    if (!(await originAllowed(input.origin, input.metadata.redirect_uris, input.resolveTrustList))) {
      throw new Error(`origin ${input.origin} is not registered in the verifier's metadata`);
    }
  }
  if (typeof claims.nonce !== "string" || claims.nonce.length < 16) throw new Error("request nonce is missing or too short");
  return { claims, ...(input.metadata.client_name !== undefined ? { clientName: input.metadata.client_name } : {}) };
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
