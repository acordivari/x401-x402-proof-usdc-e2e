/**
 * F1(A) — the orchestrator access gate. With DEMO_AUTH_TOKEN set, every
 * state/spend endpoint requires an authenticated session: unauthenticated and
 * wrong-token requests are 401; /api/login with the right token unlocks the
 * session. Also covers the fail-closed boot guard (refuse to start exposed with
 * no token). Fully offline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TOKEN = "s3cret-demo-token";

// Configure BEFORE importing the module (per-file env, like fail-closed-encryptor).
process.env.PROOF_MODE = "local";
process.env.WALLET_FLOW = "delegated";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
process.env.DEMO_AUTH_TOKEN = TOKEN;
process.env.DEMO_SESSION_SECRET = "test-session-secret";

let base: string;
let demoServer: Server;
let closeDemo: () => Promise<void>;
let createDemoApp: typeof import("../apps/wallet-demo/server/index.ts").createDemoApp;

beforeAll(async () => {
  ({ createDemoApp } = await import("../apps/wallet-demo/server/index.ts"));
  const demo = await createDemoApp();
  closeDemo = demo.close;
  demoServer = await new Promise<Server>((resolve) => {
    const s = demo.app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => demoServer.close(() => r()));
  await closeDemo();
});

function makeClient() {
  let cookie = "";
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
}

describe("orchestrator access gate (F1)", () => {
  it("/api/me reports authRequired and withholds state before login", async () => {
    const api = makeClient();
    const me = await api("/api/me");
    expect(me.body.authRequired).toBe(true);
    expect(me.body.authed).toBe(false);
    expect(me.body.intent).toBeUndefined();
    expect(me.body.flow).toBeUndefined(); // no state leak pre-auth
  });

  it("rejects a protected endpoint without authentication (401)", async () => {
    const api = makeClient();
    const r = await api("/api/agent/run", {});
    expect(r.status).toBe(401);
    expect(r.body.authRequired).toBe(true);
  });

  it("rejects login with the wrong token", async () => {
    const api = makeClient();
    const r = await api("/api/login", { token: "wrong" });
    expect(r.status).toBe(401);
    // still gated
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(401);
  });

  it("unlocks the session after login with the right token", async () => {
    const api = makeClient();
    const login = await api("/api/login", { token: TOKEN });
    expect(login.status).toBe(200);
    expect(login.body.authed).toBe(true);
    const me = await api("/api/me");
    expect(me.body.authed).toBe(true);
    expect(me.body.flow).toBe("delegated"); // full payload now visible
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(200);
  });

  it("fails closed: refuses to boot exposed with no token", async () => {
    const saved = process.env.DEMO_AUTH_TOKEN;
    delete process.env.DEMO_AUTH_TOKEN;
    process.env.DEMO_REQUIRE_AUTH = "true";
    try {
      await expect(createDemoApp()).rejects.toThrow(/DEMO_AUTH_TOKEN/);
    } finally {
      process.env.DEMO_AUTH_TOKEN = saved;
      delete process.env.DEMO_REQUIRE_AUTH;
    }
  });
});
