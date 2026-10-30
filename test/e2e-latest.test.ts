/**
 * The LATEST variant over real HTTP, fully offline: the merchant as x401
 * verifier (CIMD identity, signed DC API request with an itemized basket),
 * the agent's 401 → token exchange → 402 → 200, presentations whose
 * detached signatures the merchant buys back over x402 from the emulated
 * Proof, the handoff relay with its return channel, route policy, replay,
 * and Delegate Authority with budget, scope and revocation.
 *
 * The browser's wallet step runs the same `answerDcApiRequest` the UI runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  answerDcApiRequest,
  generateEs256Keys,
  mintDelegation,
  type ClientIdMetadataDocument,
  type Jwk,
} from "@agentic-payments/credentials";

process.env.PROOF_MODE = "local";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
process.env.PUBLIC_ORIGIN = "http://localhost:4040";
process.env.LATEST_SIGNATURE_BILLING = "x402";

const PAGE_ORIGIN = "http://localhost:4040";

let base: string;
let server: Server;
let closeDemo: () => Promise<void>;

beforeAll(async () => {
  const { createDemoApp } = await import("../apps/wallet-demo/server/index.ts");
  const demo = await createDemoApp();
  closeDemo = demo.close;
  server = await new Promise<Server>((resolve) => {
    const s = demo.app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDemo();
});

type Client = (path: string, body?: unknown) => Promise<{ status: number; body: any }>;
function makeClient(): Client {
  let cookie = "";
  return async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0]!;
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
}

/** One browser: a holder key, a credential issued to it, and the demo wallet. */
async function browser(persona = "Andrew Smith") {
  const api = makeClient();
  const keys = await generateEs256Keys();
  const issued = await api("/api/latest/wallet/issue", { holderPublicJwk: keys.publicJwk, persona });
  expect(issued.status).toBe(200);
  const me = (await api("/api/latest/me")).body;
  const metadata = (await (await fetch(`${base}/.well-known/proof-client.json`)).json()) as ClientIdMetadataDocument;
  const answer = (request: string, opts: { origin?: string; detach?: boolean } = {}) =>
    answerDcApiRequest({
      request,
      metadata,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      audience: me.verifier.walletAudience,
      credential: issued.body.credential.compact,
      holderPrivateJwk: keys.privateJwk as Jwk,
      ...(opts.detach
        ? {
            detach: async (id, sigs) => {
              const r = await fetch(`${base}/emulator/proof/wallet/signatures`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id, ...sigs }),
              });
              expect(r.status).toBe(201);
            },
          }
        : {}),
    });
  return { api, keys, me, metadata, credential: issued.body.credential.compact as string, answer };
}

const requestOf = (purchase: any): string => purchase.credentialRequirements.digital.requests[0].data.request;

describe("latest variant: identity", () => {
  it("publishes the verifier's CIMD at its client_id", async () => {
    const { me, metadata } = await browser();
    expect(me.mode).toBe("local");
    expect(metadata.client_id).toBe(`${PAGE_ORIGIN}/.well-known/proof-client.json`);
    expect(metadata.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(metadata.redirect_uris).toContain(PAGE_ORIGIN);
    expect(metadata.jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("latest variant: one purchase, human in the loop", () => {
  it("401 → wallet → token exchange → 402 → 200, signatures bought over x402", async () => {
    const b = await browser();
    const start = await b.api("/api/latest/purchase/start", { sku: "vitamin-d3-2000", wallet: "demo" });
    expect(start.status).toBe(200);
    const p = start.body.purchase;
    expect(p.exchanges[0].status).toBe(401);
    expect(p.request.claims).toMatchObject({ response_mode: "dc_api", client_id: b.metadata.client_id });
    const types = p.request.transactionData.map((t: any) => t.type);
    expect(types).toEqual([
      "urn:proof:params:vc:transaction-data:payment-itemized:v1",
      "urn:proof:params:vc:transaction-data:session-data",
    ]);
    expect(p.request.transactionData[0].payload.items[0]).toMatchObject({ unit_cost: 2.25, quantity: 1 });

    const { result } = await b.answer(requestOf(p), { origin: PAGE_ORIGIN, detach: true });
    const done = await b.api("/api/latest/purchase/complete", { credentialResult: result });
    expect(done.status).toBe(200);
    const out = done.body.purchase;
    expect(out.status).toBe("settled");
    expect(out.outcome.settled.state).toBe("SETTLED");
    const auth = out.outcome.receipt.authorization;
    expect(auth.kind).toBe("presentation");
    expect(auth.via).toBe("verification-token");
    expect(auth.principal.claims).toEqual({ given_name: "Andrew", family_name: "Smith", age_equal_or_over: { "18": true } });
    expect(auth.agentId).toMatch(/^did:pkh:eip155:84532:0x/);
    expect(auth.terms.every((t: any) => t.matches)).toBe(true);
    // The merchant could not verify until it paid Proof (emulated) for the signatures.
    expect(auth.detachedSignatures).toBe(true);
    expect(auth.signaturePayments).toHaveLength(1);
    // The HTTP story, as it happened: 401, token exchange, 402, paid 200.
    const statuses = out.exchanges.map((e: any) => `${e.method} ${e.path} ${e.status}`);
    expect(statuses).toEqual([
      "GET /x401/buy/vitamin-d3-2000 401",
      "POST /x401/token 200",
      "GET /x401/buy/vitamin-d3-2000 402",
      "GET /x401/buy/vitamin-d3-2000 200",
    ]);
    expect(out.exchanges[2].decoded.paymentRequired.accepts[0].amount).toBe("2250000");
    expect(out.exchanges[3].decoded.proofResponse.kind).toBe("x401 Token Object");
  });

  it("refuses an age-restricted product when the holder is under 18", async () => {
    const b = await browser("Sam Rivera");
    const p = (await b.api("/api/latest/purchase/start", { sku: "ibuprofen-200", wallet: "demo" })).body.purchase;
    const { result } = await b.answer(requestOf(p), { origin: PAGE_ORIGIN });
    const out = (await b.api("/api/latest/purchase/complete", { credentialResult: result })).body.purchase;
    expect(out.status).toBe("refused");
    expect(out.outcome.refusal).toMatch(/age-restricted/);
  });

  it("a presentation for one request cannot satisfy another (nonce is single-use, route-bound)", async () => {
    const b = await browser();
    const p1 = (await b.api("/api/latest/purchase/start", { sku: "toothpaste-mint", wallet: "demo" })).body.purchase;
    const { result } = await b.answer(requestOf(p1), { origin: PAGE_ORIGIN });
    expect((await b.api("/api/latest/purchase/complete", { credentialResult: result })).body.purchase.status).toBe("settled");
    // Same presentation, fresh purchase: the merchant never issued that nonce for this request.
    await b.api("/api/latest/purchase/start", { sku: "toothpaste-mint", wallet: "demo" });
    const replay = (await b.api("/api/latest/purchase/complete", { credentialResult: result })).body.purchase;
    expect(replay.status).toBe("refused");
    expect(replay.outcome.refusal).toMatch(/nonce/);
  });

  it("the wallet refuses a request invoked from an origin the verifier did not list", async () => {
    const b = await browser();
    const p = (await b.api("/api/latest/purchase/start", { sku: "toothpaste-mint", wallet: "demo" })).body.purchase;
    await expect(b.answer(requestOf(p), { origin: "https://evil.example" })).rejects.toThrow(/expected_origins/);
  });
});

describe("latest variant: Proof Cloud Wallet handoff (emulated)", () => {
  it("relays the request with a return channel and completes on the hosted wallet's POST", async () => {
    const b = await browser();
    const start = await b.api("/api/latest/purchase/start", { sku: "bandages-assorted", wallet: "handoff" });
    expect(start.status).toBe(200);
    const p = start.body.purchase;
    expect(p.requestUri).toMatch(/\/emulator\/proof\/wallet\//);
    const id = p.requestUri.split("/").pop();
    const handoff = (await (await fetch(`${base}/emulator/proof/handoff/${id}`)).json()) as { request: string; return_uri: string };
    // Relayed fulfillment: no invoking origin to check, everything else still verified.
    const { result } = await b.answer(handoff.request);
    const back = await fetch(`${base}${new URL(handoff.return_uri).pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
    expect(back.status).toBe(202);
    let purchase: any;
    for (let i = 0; i < 50; i++) {
      purchase = (await b.api("/api/latest/me")).body.session.purchase;
      if (purchase.status !== "awaiting-wallet" && purchase.status !== "completing") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(purchase.status).toBe("settled");
    // The return channel is single-use.
    const again = await fetch(`${base}${new URL(handoff.return_uri).pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
    expect(again.status).toBe(404);
  });
});

describe("latest variant: Delegate Authority", () => {
  it("one holder-signed mandate; the agent buys alone; budget, scope and revocation hold at the merchant", async () => {
    const b = await browser();
    const req = await b.api("/api/latest/mandate/request", {
      budgetUsd: 3.5, perPurchaseUsd: 2.5, categories: ["vitamins", "personal-care", "otc-medicine"], validityHours: 24,
    });
    expect(req.status).toBe(200);
    const minted = await mintDelegation({
      credential: b.credential,
      holderPrivateJwk: b.keys.privateJwk as Jwk,
      disclose: [["given_name"], ["family_name"], ["age_equal_or_over", "18"]],
      request: req.body.request,
    });
    const acc = await b.api("/api/latest/mandate/accept", { delegation: minted.delegation });
    expect(acc.status).toBe(200);
    expect(acc.body.delegation.terms.amount).toBe(3.5);

    const run = await b.api("/api/latest/agent/run", { skus: ["vitamin-d3-2000", "toothpaste-mint", "bandages-assorted", "allergy-relief-24"] });
    const [vit, tooth, band, allergy] = run.body.run.purchases;
    expect(vit).toMatchObject({ ok: true, settled: true });          // 2.25 of 3.50
    expect(tooth).toMatchObject({ ok: true, settled: true });        // 3.25 of 3.50
    expect(band.ok).toBe(false);                                      // first-aid not delegated
    expect(band.refusal).toMatch(/categories not authorized/);
    expect(allergy.ok).toBe(false);                                   // 1.50 would exceed the budget
    expect(allergy.refusal).toMatch(/budget/);
    expect(vit.exchanges.map((e: any) => e.status)).toEqual([401, 200, 402, 200]);

    expect((await b.api("/api/latest/mandate/revoke", {})).body.revoked).toBe(true);
    const after = await b.api("/api/latest/agent/run", { skus: ["ibuprofen-200"] });
    expect(after.body.run.purchases[0].ok).toBe(false);
    expect(after.body.run.purchases[0].refusal).toMatch(/revoked/);
  });

  it("a mandate whose terms differ from what the agent asked for is not accepted", async () => {
    const b = await browser();
    const req = (await b.api("/api/latest/mandate/request", { budgetUsd: 2 })).body.request;
    const minted = await mintDelegation({
      credential: b.credential, holderPrivateJwk: b.keys.privateJwk as Jwk, disclose: [["given_name"]],
      request: {
        ...req,
        terms: { ...req.terms, amount: 200, prompt_summary: "anything" },
        constraints: req.constraints.map((c: any) => (c.type === "mandate.payment.budget" ? { ...c, max: 200 } : c)),
      },
    });
    const acc = await b.api("/api/latest/mandate/accept", { delegation: minted.delegation });
    expect(acc.status).toBe(400);
    expect(acc.body.error).toMatch(/terms differ/);
  });

  it("July routes are untouched alongside", async () => {
    const api = makeClient();
    const me = await api("/api/me");
    expect(me.body.flows).toEqual(["self-issued", "proof-hosted", "delegated"]);
  });
});
