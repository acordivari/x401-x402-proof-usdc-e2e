/**
 * The demo wallet: what a Digital Credentials API credential manager does with
 * an `openid4vp-v1-signed` request, as one function the in-page wallet, the
 * emulated hosted (Cloud) wallet page and the tests all share.
 *
 *   previewDcApiRequest  authenticate the verifier and decode what it asks for
 *                        — scope disclosures and Sign Transactions terms —
 *                        for the consent screen
 *   answerDcApiRequest   after consent: present exactly those disclosures, sign
 *                        the terms into the KB-JWT, optionally detach the
 *                        signatures (x402-billed verifier), and return the
 *                        `{ protocol, data: { vp_token } }` credential result
 *
 * Browser-safe.
 */
import type { CredentialResult } from "@proof.com/x401-node";
import type { Jwk } from "./crypto.ts";
import type { ClientIdMetadataDocument } from "./client-metadata.ts";
import { verifyDcApiRequest, type DcApiRequestClaims } from "./dc-api-request.ts";
import { scopeDefinition, type ClaimPath, type ScopeDefinition } from "./proof-credential-v1.ts";
import { decodeTxData, type TransactionDataV1 } from "./templates.ts";
import { encodeVpToken, presentCredentialV1, type DetachedSignatures } from "./wallet-v1.ts";

export interface DcApiPreview {
  claims: DcApiRequestClaims;
  clientName?: string;
  scope: ScopeDefinition;
  disclose: ClaimPath[];
  terms: TransactionDataV1[];
}

export interface DcApiWalletInput {
  request: string;
  metadata: ClientIdMetadataDocument;
  /** Invoking web origin; omit when fulfilling a relayed (handoff) request. */
  origin?: string;
  /** This wallet's audience (the presentation endpoint requests are addressed to). */
  audience: string;
  resolveTrustList?: (url: string) => Promise<string[]>;
}

export async function previewDcApiRequest(input: DcApiWalletInput): Promise<DcApiPreview> {
  const v = await verifyDcApiRequest({
    request: input.request,
    metadata: input.metadata,
    audience: input.audience,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.resolveTrustList ? { resolveTrustList: input.resolveTrustList } : {}),
  });
  const scope = scopeDefinition(v.claims.scope ?? "");
  return {
    claims: v.claims,
    ...(v.clientName !== undefined ? { clientName: v.clientName } : {}),
    scope,
    disclose: scope.disclosures,
    terms: (v.claims.transaction_data ?? []).map(decodeTxData),
  };
}

export async function answerDcApiRequest(
  input: DcApiWalletInput & {
    credential: string;
    holderPrivateJwk: Jwk;
    /** Detach the signatures and hand them to `deposit` (the wallet provider keeps them). */
    detach?: (id: string, signatures: DetachedSignatures) => Promise<void>;
  },
): Promise<{ result: CredentialResult; preview: DcApiPreview; kbPayload: Record<string, unknown>; detachedId?: string }> {
  const preview = await previewDcApiRequest(input);
  const detachedId = input.detach ? crypto.randomUUID() : undefined;
  const out = await presentCredentialV1({
    credential: input.credential,
    holderPrivateJwk: input.holderPrivateJwk,
    disclose: preview.disclose,
    nonce: preview.claims.nonce,
    audience: preview.claims.client_id,
    transactionData: preview.terms,
    ...(detachedId ? { detachedSignatureId: detachedId } : {}),
  });
  let presentation = out.presentation;
  if (input.detach && out.detached) {
    await input.detach(out.detached.id, out.detached.signatures);
    presentation = out.detached.presentation;
  }
  return {
    result: {
      protocol: "openid4vp-v1-signed",
      data: { vp_token: encodeVpToken({ [preview.scope.credentialQueryId]: [presentation] }) },
    },
    preview,
    kbPayload: out.kbPayload,
    ...(detachedId ? { detachedId } : {}),
  };
}
