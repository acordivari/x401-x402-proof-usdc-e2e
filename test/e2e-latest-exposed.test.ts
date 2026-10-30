/**
 * The latest variant in the EXPOSED, deliberately-open posture the public demo
 * runs in (NODE_ENV=production + DEMO_OPEN_ACCESS, https PUBLIC_ORIGIN): no
 * insecure-URI allowances, no localhost dev origins. Same flows must still work.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { answerDcApiRequest, generateEs256Keys, type ClientIdMetadataDocument, type Jwk } from "@agentic-payments/credentials";

process.env.PROOF_MODE = "local";
process.env.NODE_ENV = "production";
process.env.DEMO_OPEN_ACCESS = "true";
process.env.DEMO_AUTH_TOKEN = "";
process.env.DEMO_PUBLIC_TOKEN = "";
process.env.DEMO_SESSION_SECRET = "exposed-test-session-secret";
process.env.X401_ENCRYPTOR_KEY = "exposed-test-encryptor-key-strong";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
process.env.PROOF_ENVIRONMENT = "sandbox";
process.env.PROOF_TRUST_ROOT = "development";
process.env.PUBLIC_ORIGIN = "https://demo.example";

const ORIGIN = "https://demo.example";
let base: string;
let server: Server;
let closeDemo: () => Promise<void>;

beforeAll(async () => {
  const { createDemoApp } = await import("../apps/wallet-demo/server/index.ts");
  const demo = await createDemoApp();
  closeDemo = demo.close;
  server = await new Promise<Server>((resolve) => { const s = demo.app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDemo();
  delete process.env.NODE_ENV;
  delete process.env.DEMO_OPEN_ACCESS;
});

function client() {
  let cookie = "";
  return async (path: string, body?: unknown) => {
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

describe("latest variant, exposed + open posture", () => {
  it("admits only the public origin and still completes both wallet paths", async () => {
    const api = client();
    const keys = await generateEs256Keys();
    const issued = await api("/api/latest/wallet/issue", { holderPublicJwk: keys.publicJwk, persona: "Andrew Smith" });
    expect(issued.status).toBe(200);
    const me = (await api("/api/latest/me")).body;
    expect(me.verifier.expectedOrigins).toEqual([ORIGIN]);
    const metadata = (await (await fetch(`${base}/.well-known/proof-client.json`)).json()) as ClientIdMetadataDocument;
    expect(metadata.client_id).toBe(`${ORIGIN}/.well-known/proof-client.json`);
    const answer = (request: string, origin?: string) => answerDcApiRequest({
      request, metadata, ...(origin ? { origin } : {}), audience: me.verifier.walletAudience,
      credential: issued.body.credential.compact, holderPrivateJwk: keys.privateJwk as Jwk,
      detach: async (id, sigs) => { await fetch(`${base}/emulator/proof/wallet/signatures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...sigs }) }); },
    });

    // In-page wallet, invoked from the public origin.
    const p1 = (await api("/api/latest/purchase/start", { sku: "toothpaste-mint", wallet: "demo" })).body.purchase;
    const r1 = await answer(p1.credentialRequirements.digital.requests[0].data.request, ORIGIN);
    const done = (await api("/api/latest/purchase/complete", { credentialResult: r1.result })).body.purchase;
    expect(done.status).toBe("settled");
    expect(done.outcome.receipt.authorization.signaturePayments).toHaveLength(1);
    // A localhost page is not an admitted origin once exposed.
    const p2 = (await api("/api/latest/purchase/start", { sku: "toothpaste-mint", wallet: "demo" })).body.purchase;
    await expect(answer(p2.credentialRequirements.digital.requests[0].data.request, "http://localhost:5173")).rejects.toThrow(/expected_origins/);

    // Handoff: an https return channel on the public origin.
    const p3 = (await api("/api/latest/purchase/start", { sku: "bandages-assorted", wallet: "handoff" }));
    expect(p3.status).toBe(200);
    const id = p3.body.purchase.requestUri.split("/").pop();
    expect(p3.body.purchase.requestUri.startsWith(`${ORIGIN}/emulator/proof/wallet/`)).toBe(true);
    const h = (await (await fetch(`${base}/emulator/proof/handoff/${id}`)).json()) as { request: string; return_uri: string };
    expect(h.return_uri.startsWith(`${ORIGIN}/x401/return/`)).toBe(true);
    const r3 = await answer(h.request);
    expect((await fetch(`${base}${new URL(h.return_uri).pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r3.result) })).status).toBe(202);
    let status = "";
    for (let i = 0; i < 50 && status !== "settled"; i++) {
      status = (await api("/api/latest/me")).body.session.purchase.status;
      if (status !== "settled") await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("settled");
  });
});
