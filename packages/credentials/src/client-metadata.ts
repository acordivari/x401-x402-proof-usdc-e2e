/**
 * OAuth Client ID Metadata Document (CIMD) — how a current x401 verifier is
 * identified. There is no client secret any more: the verifier's `client_id`
 * IS the https URL of this JSON document, which publishes the ES256 public
 * key(s) its request objects and client assertions are signed with, plus the
 * origins (or agents trust list) allowed to invoke its requests.
 *
 * `buildClientIdMetadataDocument` emits exactly the shape the SDK's
 * `createClientIdMetadataDocument` returns (keys get a thumbprint `kid` when
 * they lack one), so a document served in local mode is the document Proof
 * would fetch in live mode. Browser-safe.
 */
import { calculateJwkThumbprint, type JWK } from "jose";

export const CIMD_PATH = "/.well-known/proof-client.json";

export interface ClientIdMetadataDocument {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "private_key_jwt";
  jwks: { keys: JWK[] };
}

export interface BuildCimdInput {
  clientId: string;
  /** Public JWKs only. */
  jwks: JWK[];
  /** Origins — or an agents trust list URL — allowed to invoke requests. */
  redirectUris: string[];
  /** Shown to the person on the consent screen. */
  clientName?: string;
}

export async function buildClientIdMetadataDocument(input: BuildCimdInput): Promise<ClientIdMetadataDocument> {
  const url = new URL(input.clientId); // throws on a non-URL client_id
  const localhost = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localhost) throw new Error("client_id must be an https URL");
  if (url.pathname === "/") throw new Error("client_id must have a path component");
  if (url.hash) throw new Error("client_id must not contain a fragment");
  if (input.redirectUris.length === 0) throw new Error("redirectUris must be non-empty");
  if (input.jwks.length === 0) throw new Error("jwks must be non-empty");
  const keys = await Promise.all(
    input.jwks.map(async (k) => {
      if ("d" in k) throw new Error("jwks must contain public keys only");
      return k.kid === undefined ? { ...k, kid: await calculateJwkThumbprint(k) } : k;
    }),
  );
  return {
    client_id: input.clientId,
    ...(input.clientName !== undefined ? { client_name: input.clientName } : {}),
    redirect_uris: [...input.redirectUris],
    token_endpoint_auth_method: "private_key_jwt",
    jwks: { keys },
  };
}

/** The CIMD URL for a verifier hosted at `origin`. */
export const clientIdFor = (origin: string): string => new URL(CIMD_PATH, origin).toString();
