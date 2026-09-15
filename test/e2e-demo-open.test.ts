/**
 * Open access — the ungated public posture (DEMO_OPEN_ACCESS=true). No token
 * screen: a visitor lands on a working demo. This is the counterpart to
 * e2e-demo-auth (the gated posture), and it asserts the three properties that
 * make removing the gate safe rather than merely easy:
 *
 *   1. every endpoint works with no login, and /api/me says so (authRequired
 *      false), which is what makes the SPA skip its login card;
 *   2. a caller that never mutates anything gets NO server-side session row, so
 *      an ungated demo can't be filled up by cookie-less traffic;
 *   3. state-changing calls are still capped per IP, since the login throttle
 *      is no longer standing in front of the crypto routes.
 *
 * Plus the fail-closed boot guards: open access must never silently coexist
 * with a token it has disabled, or with live Proof credentials. Fully offline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Configure BEFORE importing the module (per-file env, like e2e-demo-auth).
// DEMO_REQUIRE_AUTH is the EXPOSED-posture switch, not a gate switch: it turns
// on fail-closed secrets and Secure cookies, which is the posture a public
// deployment runs in. DEMO_OPEN_ACCESS then removes the gate inside it — that
// combination is precisely what Render runs, and what the write limiter needs.
process.env.PROOF_MODE = "local";
process.env.WALLET_FLOW = "delegated";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
delete process.env.DEMO_AUTH_TOKEN;
delete process.env.DEMO_PUBLIC_TOKEN;
process.env.DEMO_OPEN_ACCESS = "true";
process.env.DEMO_REQUIRE_AUTH = "true";
process.env.DEMO_SESSION_SECRET = "test-session-secret-open";
process.env.X401_ENCRYPTOR_KEY = "a-strong-non-default-encryptor-key";

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

function makeClient(at = () => base) {
  let cookie = "";
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${at()}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get("set-cookie");
    const reissued = Boolean(setCookie);
    if (setCookie) cookie = setCookie.split(";")[0];
    return {
      status: res.status,
      headers: res.headers,
      reissued,
      body: (await res.json().catch(() => ({}))) as any,
    };
  };
}

describe("open access (ungated public demo)", () => {
  it("serves the full /api/me payload with no login at all", async () => {
    const api = makeClient();
    const me = await api("/api/me");
    // authRequired false is what the SPA derives `needsLogin` from — false here
    // means the login card never renders and the visitor lands on the demo.
    expect(me.body.authRequired).toBe(false);
    expect(me.body.authed).toBe(true);
    expect(me.body.flow).toBe("delegated");
    expect(me.body.agentWallet).toMatch(/^0x/);
    expect(me.body.publicToken).toBeUndefined(); // nothing left to publish
  });

  it("lets a first-time visitor reach protected endpoints directly", async () => {
    const api = makeClient();
    expect((await api("/api/catalog")).body.products.length).toBeGreaterThan(0);
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(200);
    expect((await api("/api/me")).body.flow).toBe("self-issued");
  });

  it("still isolates one visitor's session state from another's", async () => {
    // The gate was never what separated clients — the signed cookie is. Removing
    // it must not turn per-visitor state into shared state.
    const a = makeClient();
    const b = makeClient();
    expect((await a("/api/flow", { flow: "delegated" })).status).toBe(200);
    expect((await b("/api/flow", { flow: "self-issued" })).status).toBe(200);
    expect((await a("/api/me")).body.flow).toBe("delegated");
    expect((await b("/api/me")).body.flow).toBe("self-issued");
  });

  it("does not allocate server-side state for read-only callers", async () => {
    // The property e2e-demo-auth pins for unauthenticated callers, now carried
    // by the mint path itself rather than by the gate: a fresh session is pure
    // defaults, so it is never stored. Observable as a re-issued cookie each
    // time. This is what stops a crawler sweeping an ungated demo from filling
    // the session store (or rewriting the whole file under SESSION_STORE=file).
    const api = makeClient();
    expect((await api("/api/me")).reissued).toBe(true);
    expect((await api("/api/me")).reissued).toBe(true);
    expect((await api("/api/orders")).reissued).toBe(true);

    // A mutation is worth remembering, so it IS stored — and the churn stops.
    expect((await api("/api/flow", { flow: "delegated" })).status).toBe(200);
    const after = await api("/api/me");
    expect(after.reissued).toBe(false);
    expect(after.body.flow).toBe("delegated");
  });

  it("serves the same baseline security headers", async () => {
    const api = makeClient();
    const { headers } = await api("/api/me");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    // Exposed posture => HSTS, exactly as with the gate on.
    expect(headers.get("strict-transport-security")).toContain("max-age=");
  });
});

/**
 * With no token, /api/login is the only limiter the app used to have and it no
 * longer guards anything. The write limiter replaces it in front of the routes
 * that actually cost CPU.
 */
describe("open-access write limiter", () => {
  it("caps state-changing calls per IP with 429 + Retry-After", async () => {
    // Its own orchestrator, so the per-app counter starts clean.
    const demo = await createDemoApp();
    const server = await new Promise<Server>((resolve) => {
      const s = demo.app.listen(0, () => resolve(s));
    });
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = makeClient(() => at);
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      // PUBLIC_WRITE_MAX_PER_MIN is 120; go well past it.
      for (let i = 0; i < 140; i += 1) {
        const r = await api("/api/flow", { flow: "delegated" });
        statuses.push(r.status);
        retryAfter ??= r.status === 429 ? r.headers.get("retry-after") : null;
      }
      expect(statuses[0]).toBe(200); // a human never sees this
      expect(statuses.at(-1)).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await demo.close();
    }
  });

  it("never throttles GETs — the UI polls them on a timer", async () => {
    const demo = await createDemoApp();
    const server = await new Promise<Server>((resolve) => {
      const s = demo.app.listen(0, () => resolve(s));
    });
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = makeClient(() => at);
      for (let i = 0; i < 200; i += 1) {
        expect((await api("/api/me")).status).toBe(200);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await demo.close();
    }
  });
});

/**
 * Open access is an explicit operator decision, and the boot refuses every
 * configuration where it would be ambiguous or unsafe.
 */
describe("open-access boot guards", () => {
  it("still fails closed when exposed with NEITHER a token nor the flag", async () => {
    delete process.env.DEMO_OPEN_ACCESS;
    try {
      await expect(createDemoApp()).rejects.toThrow(/DEMO_AUTH_TOKEN/);
    } finally {
      process.env.DEMO_OPEN_ACCESS = "true";
    }
  });

  it("refuses to boot alongside a token it would silently disable", async () => {
    process.env.DEMO_AUTH_TOKEN = "left-over-from-the-gated-deploy";
    try {
      await expect(createDemoApp()).rejects.toThrow(/cannot be combined with DEMO_AUTH_TOKEN/);
    } finally {
      delete process.env.DEMO_AUTH_TOKEN;
    }
  });

  it("refuses to boot alongside a now-meaningless published token", async () => {
    process.env.DEMO_PUBLIC_TOKEN = "left-over-published-token";
    try {
      await expect(createDemoApp()).rejects.toThrow(/cannot be combined with DEMO_PUBLIC_TOKEN/);
    } finally {
      delete process.env.DEMO_PUBLIC_TOKEN;
    }
  });

  it("refuses to boot alongside PROOF_MODE=live", async () => {
    // The guard that mattered most to carry over from the published token: an
    // ungated demo on live Proof credentials means any visitor spends them.
    process.env.PROOF_MODE = "live";
    try {
      await expect(createDemoApp()).rejects.toThrow(/PROOF_MODE=live/);
    } finally {
      process.env.PROOF_MODE = "local";
    }
  });
});
