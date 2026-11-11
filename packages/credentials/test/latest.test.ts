/**
 * The latest (Oct 2026) credential layer end to end, offline: a signed DC API
 * request the wallet authenticates, a ProofCredentialV1-shaped presentation
 * whose KB-JWT carries the Sign Transactions terms, detached signatures, and a
 * Delegate Authority chain — plus the tampering each check exists to catch.
 */
import { describe, expect, it } from "vitest";
import { generateEs256Keys } from "../src/crypto.ts";
import { buildClientIdMetadataDocument, clientIdFor } from "../src/client-metadata.ts";
import { decodeDcApiRequest, localRequestSigner, publicPart, verifyDcApiRequest } from "../src/dc-api-request.ts";
import { LocalCredentialV1Issuer } from "../src/issuer-v1.ts";
import { InMemoryNonceStore } from "../src/nonce-store.ts";
import {
  LOCAL_CREDENTIAL_V1_VCT,
  PROOF_SCOPES,
  ageThresholds,
  demoHoldersV1,
  presentationFrameFor,
  scopeDefinition,
} from "../src/proof-credential-v1.ts";
import { checkTerms, decodeTxData, paymentItemized, sessionData, assertTxDataAllowed } from "../src/templates.ts";
import { localL1Verifier, localPresentationVerifierV1 } from "../src/verifier-v1.ts";
import {
  attachSignatures,
  decodeVpToken,
  detachedSignatureId,
  encodeVpToken,
  presentCredentialV1,
} from "../src/wallet-v1.ts";
import { inspectDelegation, mandateKey, mintDelegation, presentDelegation, verifyDelegation, verifyDelegationGrant } from "../src/delegation.ts";
import type { DetachedSignatureResolver } from "../src/detached-signatures.ts";

const ORIGIN = "https://demo.example";
const CLIENT_ID = clientIdFor(ORIGIN);
const ISSUER = "https://issuer.sandbox.local";
const WALLET_AUD = "https://wallet.sandbox.local";

async function setup() {
  const issuerKeys = await generateEs256Keys();
  const verifierKeys = await generateEs256Keys();
  const holderKeys = await generateEs256Keys();
  const issuer = new LocalCredentialV1Issuer({ issuerId: ISSUER, privateJwk: issuerKeys.privateJwk });
  const credential = await issuer.issue(demoHoldersV1()["Andrew Smith"]!, holderKeys.publicJwk);
  const metadata = await buildClientIdMetadataDocument({
    clientId: CLIENT_ID,
    clientName: "Mock VeryGood-RX",
    jwks: [publicPart(verifierKeys.publicJwk)],
    redirectUris: [ORIGIN],
  });
  const signer = localRequestSigner({ clientId: CLIENT_ID, audience: WALLET_AUD, privateJwk: verifierKeys.privateJwk });
  return { issuerKeys, verifierKeys, holderKeys, credential, metadata, signer };
}

const basket = paymentItemized({
  title: "Mock VeryGood-RX order",
  currency: "USD",
  items: [{ quantity: 1, unit_cost: 1.25, label: "Allergy Relief 24hr" }],
});

describe("ProofCredentialV1 model", () => {
  it("derives age thresholds from the birthdate", () => {
    expect(ageThresholds("2009-09-30", new Date("2026-10-24T00:00:00Z"))).toEqual({ "18": false, "21": false, "65": false });
    expect(ageThresholds("1957-02-03", new Date("2026-10-24T00:00:00Z"))).toEqual({ "18": true, "21": true, "65": true });
  });

  it("refuses transaction_data with the nationality scope, as Proof does", () => {
    expect(() => assertTxDataAllowed(PROOF_SCOPES.nationalityUs, [basket])).toThrow(/only accepted with/);
    expect(() => assertTxDataAllowed(PROOF_SCOPES.basic, [basket])).not.toThrow();
  });
});

describe("signed DC API request", () => {
  it("the wallet authenticates the verifier from its own metadata", async () => {
    const { signer, metadata } = await setup();
    const request = await signer.signedDcApiRequest({
      scope: PROOF_SCOPES.basic, nonce: crypto.randomUUID(), expectedOrigins: [ORIGIN], transactionData: [basket],
    });
    const { header, claims } = decodeDcApiRequest(request);
    expect(header).toMatchObject({ typ: "oauth-authz-req+jwt", alg: "ES256" });
    expect(claims).toMatchObject({ iss: CLIENT_ID, client_id: CLIENT_ID, aud: WALLET_AUD, response_mode: "dc_api" });
    expect(decodeTxData(claims.transaction_data![0]!)).toEqual(basket);
    const ok = await verifyDcApiRequest({ request, metadata, origin: ORIGIN, audience: WALLET_AUD });
    expect(ok.clientName).toBe("Mock VeryGood-RX");
  });

  it("refuses an origin the verifier did not pre-authorize", async () => {
    const { signer, metadata } = await setup();
    const request = await signer.signedDcApiRequest({ scope: PROOF_SCOPES.basic, nonce: crypto.randomUUID(), expectedOrigins: [ORIGIN] });
    await expect(verifyDcApiRequest({ request, metadata, origin: "https://evil.example", audience: WALLET_AUD })).rejects.toThrow(/expected_origins/);
  });

  it("refuses a request signed by a key the metadata does not publish", async () => {
    const { metadata } = await setup();
    const rogue = localRequestSigner({ clientId: CLIENT_ID, audience: WALLET_AUD, privateJwk: (await generateEs256Keys()).privateJwk });
    const request = await rogue.signedDcApiRequest({ scope: PROOF_SCOPES.basic, nonce: crypto.randomUUID(), expectedOrigins: [ORIGIN] });
    await expect(verifyDcApiRequest({ request, metadata, origin: ORIGIN, audience: WALLET_AUD })).rejects.toThrow(/does not publish/);
  });

  it("follows an agents trust list listed in place of an origin", async () => {
    const { verifierKeys } = await setup();
    const list = "https://api.fairfax.proof.com/.well-known/agents-trust-list";
    const metadata = await buildClientIdMetadataDocument({ clientId: CLIENT_ID, jwks: [publicPart(verifierKeys.publicJwk)], redirectUris: [list] });
    const signer = localRequestSigner({ clientId: CLIENT_ID, audience: WALLET_AUD, privateJwk: verifierKeys.privateJwk });
    const request = await signer.signedDcApiRequest({ scope: PROOF_SCOPES.basic, nonce: crypto.randomUUID(), expectedOrigins: [list] });
    const resolveTrustList = async () => ["https://claude.ai"];
    await expect(verifyDcApiRequest({ request, metadata, origin: "https://claude.ai", audience: WALLET_AUD, resolveTrustList })).resolves.toBeTruthy();
    await expect(verifyDcApiRequest({ request, metadata, origin: ORIGIN, audience: WALLET_AUD, resolveTrustList })).rejects.toThrow();
  });
});

describe("presentation + Sign Transactions", () => {
  it("discloses exactly the scope, carries the terms in the KB-JWT, and verifies", async () => {
    const { credential, holderKeys, issuerKeys } = await setup();
    const nonce = crypto.randomUUID();
    const session = sessionData({ ip_address: "203.0.113.42" });
    const def = scopeDefinition(PROOF_SCOPES.basic);
    const { presentation } = await presentCredentialV1({
      credential, holderPrivateJwk: holderKeys.privateJwk, disclose: def.disclosures,
      nonce, audience: CLIENT_ID, transactionData: [basket, session],
    });
    const verifier = localPresentationVerifierV1({ issuerId: ISSUER, issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT });
    const res = await verifier.verifyVpToken({ encodedVpToken: encodeVpToken({ [def.credentialQueryId]: [presentation] }), aud: CLIENT_ID });
    expect(res.result).toEqual({ ok: true });
    const [p] = res.presentations;
    expect(p!.nonce).toBe(nonce);
    expect(p!.claims).toEqual({ given_name: "Andrew", family_name: "Smith", age_equal_or_over: { "18": true } });
    expect(checkTerms(p!.kbPayload, [basket, session]).every((t) => t.matches)).toBe(true);
    // A term the holder never signed does not match.
    const altered = paymentItemized({ ...basket.payload, items: [{ quantity: 1, unit_cost: 0.01, label: "Allergy Relief 24hr" }] });
    expect(checkTerms(p!.kbPayload, [altered])[0]!.matches).toBe(false);
  });

  it("rejects a presentation addressed to another verifier", async () => {
    const { credential, holderKeys, issuerKeys } = await setup();
    const { presentation } = await presentCredentialV1({
      credential, holderPrivateJwk: holderKeys.privateJwk, disclose: [["given_name"]], nonce: crypto.randomUUID(), audience: "https://other.example/x",
    });
    const verifier = localPresentationVerifierV1({ issuerId: ISSUER, issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT });
    const res = await verifier.verifyVpToken({ encodedVpToken: encodeVpToken({ proof_id_default: [presentation] }), aud: CLIENT_ID });
    expect(res.result.ok ? "" : res.result.violations.join()).toMatch(/audience/);
  });

  it("rejects a credential from an untrusted issuer", async () => {
    const { holderKeys } = await setup();
    const rogueKeys = await generateEs256Keys();
    const rogue = new LocalCredentialV1Issuer({ issuerId: ISSUER, privateJwk: rogueKeys.privateJwk });
    const credential = await rogue.issue(demoHoldersV1()["Andrew Smith"]!, holderKeys.publicJwk);
    const { presentation } = await presentCredentialV1({ credential, holderPrivateJwk: holderKeys.privateJwk, disclose: [["given_name"]], nonce: crypto.randomUUID(), audience: CLIENT_ID });
    const verifier = localPresentationVerifierV1({ issuerId: ISSUER, issuerPublicJwk: (await generateEs256Keys()).publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT });
    const res = await verifier.verifyVpToken({ encodedVpToken: encodeVpToken({ proof_id_default: [presentation] }), aud: CLIENT_ID });
    expect(res.result.ok ? "" : res.result.violations.join()).toMatch(/Signature/);
  });

  it("detached signatures: unverifiable until bought back, then verify", async () => {
    const { credential, holderKeys, issuerKeys } = await setup();
    const out = await presentCredentialV1({
      credential, holderPrivateJwk: holderKeys.privateJwk, disclose: [["given_name"]], nonce: crypto.randomUUID(),
      audience: CLIENT_ID, detachedSignatureId: "rec-1",
    });
    const stripped = out.detached!.presentation;
    expect(detachedSignatureId(stripped)).toBe("rec-1");
    expect(detachedSignatureId(attachSignatures(stripped, out.detached!.signatures))).toBeUndefined();
    const encodedVpToken = encodeVpToken({ proof_id_default: [stripped] });
    const base = { issuerId: ISSUER, issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT };
    expect((await localPresentationVerifierV1(base).verifyVpToken({ encodedVpToken, aud: CLIENT_ID })).result.ok).toBe(false);
    const resolver: DetachedSignatureResolver = {
      resolve: async (id) => ({ signatures: out.detached!.signatures, payment: { recordId: id, transaction: "0xmock" } }),
    };
    const res = await localPresentationVerifierV1({ ...base, signatures: resolver }).verifyVpToken({ encodedVpToken, aud: CLIENT_ID });
    expect(res.result).toEqual({ ok: true });
    expect(res.presentations[0]!.detachedSignatures).toBe(true);
    expect(res.signaturePayments).toEqual([{ recordId: "rec-1", transaction: "0xmock" }]);
  });

  it("vp_token envelope round-trips", () => {
    expect(decodeVpToken(encodeVpToken({ proof_id_default: ["a~b~"] }))).toEqual({ proof_id_default: ["a~b~"] });
  });

  it("nonces are single-use", async () => {
    const store = new InMemoryNonceStore();
    const n = await store.mint();
    expect(n.length).toBeGreaterThanOrEqual(16);
    expect(await store.verify(n)).toBe(true);
    expect(await store.verify(n)).toBe(false);
    expect(await store.verify("never-minted-nonce")).toBe(false);
  });

  it("the nested presentation frame reveals a member without its siblings", () => {
    expect(presentationFrameFor([["given_name"], ["age_equal_or_over", "18"]])).toEqual({ given_name: true, age_equal_or_over: { "18": true } });
  });
});

describe("Delegate Authority chain", () => {
  const PAYEE = "0xc0ffee0000000000000000000000000000000000";
  const AGENT_DID = "did:pkh:eip155:84532:0x1111111111111111111111111111111111111111";

  async function delegated(constraintsMax = 5) {
    const s = await setup();
    const agentKeys = await generateEs256Keys();
    const kid = "agent-key-1";
    const minted = await mintDelegation({
      credential: s.credential, holderPrivateJwk: s.holderKeys.privateJwk, disclose: [["given_name"], ["family_name"]],
      request: {
        agent: { id: AGENT_DID, jwk: { ...agentKeys.publicJwk, kid }, kid },
        terms: {
          prompt_summary: `Spend up to $${constraintsMax.toFixed(2)} at Mock VeryGood-RX`,
          payment_instrument: { type: "crypto", id: `usdc:eip155:84532:${AGENT_DID.split(":").pop()}` },
          payee: { id: PAYEE, name: "Mock VeryGood-RX" },
          amount: constraintsMax,
          currency: "USD",
        },
        constraints: [
          { type: "mandate.payment.budget", max: constraintsMax, currency: "USD" },
          { type: "mandate.payment.amount_range", max: 3, currency: "USD" },
          { type: "mandate.payment.allowed_payees", payees: [{ id: PAYEE, name: "Mock VeryGood-RX" }] },
          { type: "x-agentic-payments.allowed_categories", categories: ["allergy", "vitamins"] },
        ],
        validitySeconds: 86_400,
      },
    });
    const l1 = localL1Verifier({ issuerId: ISSUER, issuerPublicJwk: s.issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT });
    return { ...s, agentKeys, minted, l1 };
  }

  const checkout = (total = 1.25) => ({
    merchant: { id: PAYEE, name: "Mock VeryGood-RX" },
    items: [{ sku: "allergy-relief-24", label: "Allergy Relief 24hr", category: "allergy", quantity: 1, unit_cost: total }],
    currency: "USD",
    total,
  });

  it("verifies a purchase within scope and hands the budget to the caller", async () => {
    const { agentKeys, minted, l1 } = await delegated();
    const nonce = crypto.randomUUID();
    const presentation = await presentDelegation({ delegation: minted.delegation, agentPrivateJwk: agentKeys.privateJwk, audience: CLIENT_ID, nonce, checkout: checkout() });
    const v = await verifyDelegation({ presentation, verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"] });
    expect(v.result).toEqual({ ok: true });
    expect(v.nonce).toBe(nonce);
    expect(v.mandateId).toBe(minted.mandateId);
    // Tracked under the holder's key thumbprint + jti, never the holder-chosen jti alone.
    expect(minted.mandateId).toBe(await mandateKey(minted.delegation));
    expect(minted.mandateId.endsWith(`.${minted.jti}`)).toBe(true);
    expect(minted.mandateId).not.toBe(minted.jti);
    expect(v.budget).toEqual({ max: 5, currency: "USD" });
    expect(v.principal?.claims).toEqual({ given_name: "Andrew", family_name: "Smith" });
    expect(v.terms?.amount).toBe(5);
  });

  it("refuses to mint when the readable terms and the constraints disagree", async () => {
    const s = await setup();
    const agentKeys = await generateEs256Keys();
    await expect(mintDelegation({
      credential: s.credential, holderPrivateJwk: s.holderKeys.privateJwk, disclose: [["given_name"]],
      request: {
        agent: { id: AGENT_DID, jwk: agentKeys.publicJwk, kid: "k" },
        terms: { prompt_summary: "Spend up to $5", payment_instrument: { type: "crypto", id: "x" }, payee: { id: PAYEE, name: "M" }, amount: 5, currency: "USD" },
        constraints: [{ type: "mandate.payment.budget", max: 500, currency: "USD" }],
        validitySeconds: 60,
      },
    })).rejects.toThrow(/differs/);
  });

  it("a grant verifies on its own (L1 + L2) before any purchase", async () => {
    const { minted, l1 } = await delegated();
    const g = await verifyDelegationGrant({ delegation: minted.delegation, verifyL1: l1 });
    expect(g.result).toEqual({ ok: true });
    expect(g.mandateId).toBe(minted.mandateId);
    const tampered = minted.delegation.slice(0, -4) + (minted.delegation.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await verifyDelegationGrant({ delegation: tampered, verifyL1: l1 })).result.ok).toBe(false);
  });

  it("refuses out-of-scope purchases on its own", async () => {
    const { agentKeys, minted, l1 } = await delegated();
    const p = (c: ReturnType<typeof checkout>) =>
      presentDelegation({ delegation: minted.delegation, agentPrivateJwk: agentKeys.privateJwk, audience: CLIENT_ID, nonce: crypto.randomUUID(), checkout: c });
    const over = await verifyDelegation({ presentation: await p(checkout(4)), verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"] });
    expect(over.result.ok ? [] : over.result.violations.join()).toMatch(/per-purchase limit/);
    const cat = await verifyDelegation({ presentation: await p(checkout()), verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["pain-relief"] });
    expect(cat.result.ok ? [] : cat.result.violations.join()).toMatch(/categories not authorized/);
    const elsewhere = await verifyDelegation({ presentation: await p(checkout()), verifyL1: l1, audience: CLIENT_ID, payeeId: "0x2222222222222222222222222222222222222222", itemCategories: ["allergy"] });
    expect(elsewhere.result.ok).toBe(false);
  });

  it("an agent key the mandate does not name cannot spend it", async () => {
    const { minted, l1 } = await delegated();
    const thief = await generateEs256Keys();
    const presentation = await presentDelegation({ delegation: minted.delegation, agentPrivateJwk: thief.privateJwk, audience: CLIENT_ID, nonce: crypto.randomUUID(), checkout: checkout() });
    const v = await verifyDelegation({ presentation, verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"] });
    expect(v.result.ok ? "" : v.result.violations.join()).toMatch(/agent proof/);
  });

  it("an agent proof for one merchant is useless at another", async () => {
    const { agentKeys, minted, l1 } = await delegated();
    const presentation = await presentDelegation({ delegation: minted.delegation, agentPrivateJwk: agentKeys.privateJwk, audience: "https://other.example/.well-known/proof-client.json", nonce: crypto.randomUUID(), checkout: checkout() });
    const v = await verifyDelegation({ presentation, verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"] });
    expect(v.result.ok ? "" : v.result.violations.join()).toMatch(/aud/);
  });

  it("a mandate the holder did not sign is rejected", async () => {
    const { agentKeys, minted, l1, credential, holderKeys } = await delegated();
    // Re-mint the same credential with a DIFFERENT holder key: the L2 signature no longer matches cnf.
    const forged = await mintDelegation({
      credential, holderPrivateJwk: (await generateEs256Keys()).privateJwk, disclose: [["given_name"]],
      request: {
        agent: { id: minted.mandate.agent_id, jwk: minted.mandate.cnf.jwk, kid: minted.mandate.cnf.kid },
        terms: inspectDelegation(minted.delegation).terms,
        constraints: minted.mandate.constraints,
        validitySeconds: 60,
      },
    });
    void holderKeys;
    const presentation = await presentDelegation({ delegation: forged.delegation, agentPrivateJwk: agentKeys.privateJwk, audience: CLIENT_ID, nonce: crypto.randomUUID(), checkout: checkout() });
    const v = await verifyDelegation({ presentation, verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"] });
    expect(v.result.ok ? "" : v.result.violations.join()).toMatch(/mandate/);
  });

  it("an expired mandate is refused", async () => {
    const { agentKeys, minted, l1 } = await delegated();
    const presentation = await presentDelegation({ delegation: minted.delegation, agentPrivateJwk: agentKeys.privateJwk, audience: CLIENT_ID, nonce: crypto.randomUUID(), checkout: checkout(), now: () => minted.expiresAt + 10 });
    const v = await verifyDelegation({ presentation, verifyL1: l1, audience: CLIENT_ID, payeeId: PAYEE, itemCategories: ["allergy"], now: () => minted.expiresAt + 10 });
    expect(v.result.ok ? "" : v.result.violations.join()).toMatch(/expired/);
  });
});
