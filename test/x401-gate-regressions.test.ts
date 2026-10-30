/**
 * Regressions for the latest x401 gate, driven straight at the merchant (no
 * orchestrator in between), each reproducing a bypass found in review:
 *
 *   - a non-canonical path (`/sku/`, `%2D`) skipping the gate — x401 and July `/buy`
 *   - a decoy or malformed payment header blinding the gate while x402 still pays
 *   - a Verification Token redeemed after its mandate was revoked
 *   - one token spent by concurrent paid retries
 *   - a relay swapping its own agent_id in, or a stranger's wallet paying
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { calculateJwkThumbprint } from "jose";
import {
  InMemoryNonceStore,
  LOCAL_CREDENTIAL_V1_VCT,
  LocalCredentialV1Issuer,
  X401VerifierV1,
  answerDcApiRequest,
  buildClientIdMetadataDocument,
  clientIdFor,
  demoHoldersV1,
  exchangeForToken,
  generateEs256Keys,
  localL1Verifier,
  localPresentationVerifierV1,
  localRequestSigner,
  mintDelegation,
  publicPart,
  resultArtifact,
  tokenObjectHeader,
  type ClientIdMetadataDocument,
  type Jwk,
} from "@agentic-payments/credentials";
import { buildAgentDid } from "@agentic-payments/shared";
import { createMerchantApp } from "@agentic-payments/merchant";
import { createSigningKeyPair, MandateVerifier, RevocationRegistry } from "@agentic-payments/identity";
import { createLocalSigner, createPayingFetch, delegatedResult, requestProof } from "@agentic-payments/agent";

const PAY_TO = "0xc0ffee0000000000000000000000000000000000" as const;
const ORIGIN = "https://shop.example";
const WALLET_AUD = `${ORIGIN}/emulator/proof/verifiable-credentials/v1/presentation`;
const NETWORK = "eip155:84532" as const;

let server: Server;
let base: string;
let metadata: ClientIdMetadataDocument;
let credential: string;
let holder: { publicJwk: Jwk; privateJwk: Jwk };
let issuerKeys: { publicJwk: Jwk; privateJwk: Jwk };
const revocations = new RevocationRegistry();
const agentSigner = createLocalSigner();
const agentId = buildAgentDid(NETWORK, agentSigner.address);

beforeAll(async () => {
  issuerKeys = await generateEs256Keys();
  const verifierKeys = await generateEs256Keys();
  holder = await generateEs256Keys();
  const clientId = clientIdFor(ORIGIN);
  metadata = await buildClientIdMetadataDocument({ clientId, clientName: "Mock VeryGood-RX", jwks: [publicPart(verifierKeys.publicJwk)], redirectUris: [ORIGIN] });
  credential = await new LocalCredentialV1Issuer({ issuerId: "https://issuer.sandbox.local", privateJwk: issuerKeys.privateJwk })
    .issue(demoHoldersV1()["Andrew Smith"]!, holder.publicJwk);
  const verifier = new X401VerifierV1({
    requestSigner: localRequestSigner({ clientId, audience: WALLET_AUD, privateJwk: verifierKeys.privateJwk }),
    presentationVerifier: localPresentationVerifierV1({ issuerId: "https://issuer.sandbox.local", issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT }),
    nonceStore: new InMemoryNonceStore(),
    expectedOrigins: [ORIGIN],
    l1Verifier: localL1Verifier({ issuerId: "https://issuer.sandbox.local", issuerPublicJwk: issuerKeys.publicJwk, vct: LOCAL_CREDENTIAL_V1_VCT }),
    payeeId: PAY_TO,
    catalog: (sku) => ({ "vitamin-d3-2000": { name: "Vitamin D3 2000 IU (90ct)", category: "vitamins", priceUsd: "2.25" }, "toothpaste-mint": { name: "Mint Toothpaste (4oz)", category: "personal-care", priceUsd: "1.00" } } as Record<string, { name: string; category: string; priceUsd: string }>)[sku],
    revocation: revocations,
    allowInsecureUri: true,
  });
  const asKey = await createSigningKeyPair("as-test");
  const { app } = createMerchantApp(
    { facilitatorMode: "mock", payTo: PAY_TO },
    { mandateVerifier: new MandateVerifier([{ kid: asKey.kid, publicKey: asKey.publicKey }]), x401: { verifier, sessionData: false } },
  );
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The person's wallet answering one merchant request, relayed (no invoking origin). */
async function humanResult(request: string) {
  return (await answerDcApiRequest({ request, metadata, audience: WALLET_AUD, credential, holderPrivateJwk: holder.privateJwk })).result;
}

async function tokenFor(sku: string, as = agentId) {
  const pr = await requestProof(`${base}/x401/buy/${sku}`, { agentId: as, allowInsecureUri: true });
  const result = await humanResult(pr.requirement!.request);
  const { artifact } = resultArtifact({ credentialResult: result, agentId: as });
  const tok = await exchangeForToken({ payload: pr.requirement!.payload, artifact });
  return { pr, result, tok };
}

describe("x401 gate regressions", () => {
  it("non-canonical paths are 404 — never waved through to the paywall (x401 and July /buy)", async () => {
    for (const p of ["/x401/buy/toothpaste-mint/", "/x401/buy/toothpaste%2Dmint", "/x401/buy/TOOTHPASTE-MINT", "/buy/toothpaste-mint/", "/buy/toothpaste%2Dmint"]) {
      const r = await fetch(`${base}${p}`, { headers: { "X401-Agent-Id": agentId } });
      expect([p, r.status]).toEqual([p, 404]);
    }
  });

  it("a malformed or ambiguous payment header is refused, not treated as unpaid", async () => {
    expect((await fetch(`${base}/x401/buy/toothpaste-mint`, { headers: { "X-Payment": "e30=", "X401-Agent-Id": agentId } })).status).toBe(400);
    expect((await fetch(`${base}/x401/buy/toothpaste-mint`, { headers: { "X-Payment": "e30=", "PAYMENT-SIGNATURE": "e31=", "X401-Agent-Id": agentId } })).status).toBe(400);
  });

  it("the requesting agent must identify itself", async () => {
    const r = await fetch(`${base}/x401/buy/toothpaste-mint`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("agent_id_required");
  });

  it("the agent's login hint lands in the signed request; a malformed one is refused", async () => {
    const pr = await requestProof(`${base}/x401/buy/toothpaste-mint`, { agentId, loginHint: "andrew@thisisandrew.me", allowInsecureUri: true });
    expect(pr.requirement!.claims.login_hint).toBe("andrew@thisisandrew.me");
    const none = await requestProof(`${base}/x401/buy/toothpaste-mint`, { agentId, allowInsecureUri: true });
    expect(none.requirement!.claims.login_hint).toBeUndefined();
    const bad = await fetch(`${base}/x401/buy/toothpaste-mint`, { headers: { "X401-Agent-Id": agentId, "X401-Login-Hint": "not an email" } });
    expect(bad.status).toBe(400);
  });

  it("the basket the person signs names the paying wallet", async () => {
    const pr = await requestProof(`${base}/x401/buy/toothpaste-mint`, { agentId, allowInsecureUri: true });
    expect((pr.requirement!.transactionData[0]!.payload as { description: string }).description).toContain(agentSigner.address);
  });

  it("a relay cannot swap in its own agent_id", async () => {
    const pr = await requestProof(`${base}/x401/buy/toothpaste-mint`, { agentId, allowInsecureUri: true });
    const result = await humanResult(pr.requirement!.request);
    const thief = buildAgentDid(NETWORK, createLocalSigner().address);
    const { artifact } = resultArtifact({ credentialResult: result, agentId: thief });
    const tok = await exchangeForToken({ payload: pr.requirement!.payload, artifact });
    expect(tok.ok).toBe(false);
    expect(String(tok.body.error_description)).toMatch(/agent_id/);
  });

  it("a stranger's wallet cannot pay with the agent's token", async () => {
    const { tok } = await tokenFor("toothpaste-mint");
    expect(tok.ok).toBe(true);
    const stranger = await createPayingFetch(createLocalSigner());
    const r = await stranger(`${base}/x401/buy/toothpaste-mint`, { headers: { "PROOF-RESPONSE": tokenObjectHeader(tok.accessToken!) } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("payer_agent_mismatch");
  });

  it("one token, concurrent paid retries: exactly one purchase", async () => {
    const { tok } = await tokenFor("toothpaste-mint");
    const pay = await createPayingFetch(agentSigner);
    const headers = { "PROOF-RESPONSE": tokenObjectHeader(tok.accessToken!) };
    const statuses = (await Promise.all([0, 1, 2].map(() => pay(`${base}/x401/buy/toothpaste-mint`, { headers })))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });

  it("a Verification Token is useless once its mandate is revoked", async () => {
    const agentKeys = await generateEs256Keys();
    const kid = await calculateJwkThumbprint(agentKeys.publicJwk as never);
    const minted = await mintDelegation({
      credential, holderPrivateJwk: holder.privateJwk, disclose: [["given_name"]],
      request: {
        agent: { id: agentId, jwk: { ...agentKeys.publicJwk, kid }, kid },
        terms: { prompt_summary: "up to $5", payment_instrument: { type: "crypto", id: agentId }, payee: { id: PAY_TO, name: "Mock VeryGood-RX" }, amount: 5, currency: "USD" },
        constraints: [
          { type: "mandate.payment.budget", max: 5, currency: "USD" },
          { type: "mandate.payment.allowed_payees", payees: [{ id: PAY_TO, name: "Mock VeryGood-RX" }] },
        ],
        validitySeconds: 3600,
      },
    });
    const pr = await requestProof(`${base}/x401/buy/vitamin-d3-2000`, { agentId, allowInsecureUri: true });
    const result = await delegatedResult({ requirement: pr.requirement!, delegation: minted.delegation, agentPrivateJwk: agentKeys.privateJwk, merchant: { id: PAY_TO, name: "Mock VeryGood-RX" }, sku: "vitamin-d3-2000", category: "vitamins" });
    const { artifact } = resultArtifact({ credentialResult: result, agentId });
    const tok = await exchangeForToken({ payload: pr.requirement!.payload, artifact });
    expect(tok.ok).toBe(true);
    revocations.revoke(minted.mandateId, "test");
    const pay = await createPayingFetch(agentSigner);
    const r = await pay(`${base}/x401/buy/vitamin-d3-2000`, { headers: { "PROOF-RESPONSE": tokenObjectHeader(tok.accessToken!) } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("mandate_revoked");
  });
});
