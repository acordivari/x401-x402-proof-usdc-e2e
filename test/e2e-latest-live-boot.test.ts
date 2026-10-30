/**
 * The `agentic-payments-live` blueprint service's configuration, booted for
 * real but never touching the network: gated + exposed, LATEST_PROOF_MODE=live,
 * the custom-domain origin, a P-256 verifier key. Asserts what Proof will see —
 * the CIMD it fetches at enrollment and the SDK-signed request a handoff
 * carries — without calling Proof.
 */
import { generateKeyPairSync } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeDcApiRequest, decodeTxData } from "@agentic-payments/credentials";
import { requestProof } from "@agentic-payments/agent";

const ORIGIN = "https://x401.thisisandrew.me";
Object.assign(process.env, {
  NODE_ENV: "production",
  DEMO_AUTH_TOKEN: "live-boot-test-token",
  DEMO_SESSION_SECRET: "live-boot-test-session-secret",
  X401_ENCRYPTOR_KEY: "live-boot-test-encryptor-key",
  MERCHANT_PORT: "0",
  LATEST_PROOF_MODE: "live",
  PUBLIC_ORIGIN: ORIGIN,
  PROOF_ENVIRONMENT: "sandbox",
  PROOF_TRUST_ROOT: "development",
  PROOF_MODE: "local",
  PROOF_CLIENT_ID: "",
  PROOF_CLIENT_SECRET: "",
  PROOF_LOGIN_HINT: "andrew@thisisandrew.me",
  PROOF_VERIFIER_KEY: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
delete process.env.DEMO_OPEN_ACCESS;
delete process.env.DEMO_PUBLIC_TOKEN;

let base: string;
let merchant: string;
let server: Server;
let close: () => Promise<void>;

beforeAll(async () => {
  const { createDemoApp } = await import("../apps/wallet-demo/server/index.ts");
  const demo = await createDemoApp();
  close = demo.close;
  merchant = `http://127.0.0.1:${(demo.merchantServer.address() as AddressInfo).port}`;
  server = await new Promise<Server>((r) => { const s = demo.app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await close();
  for (const k of ["NODE_ENV", "DEMO_AUTH_TOKEN", "LATEST_PROOF_MODE", "PUBLIC_ORIGIN", "PROOF_VERIFIER_KEY", "PROOF_LOGIN_HINT"]) delete process.env[k];
});

describe("live service configuration (offline boot)", () => {
  it("publishes the CIMD Proof will fetch at enrollment", async () => {
    const cimd = await (await fetch(`${base}/.well-known/proof-client.json`)).json();
    expect(cimd.client_id).toBe(`${ORIGIN}/.well-known/proof-client.json`);
    expect(cimd.redirect_uris).toEqual([ORIGIN, "https://api.fairfax.proof.com/.well-known/agents-trust-list"]);
    expect(cimd.jwks.keys).toHaveLength(1);
    expect(cimd.jwks.keys[0]).not.toHaveProperty("d");
  });

  it("is gated", async () => {
    expect((await fetch(`${base}/api/latest/me`)).status).toBe(401);
  });

  it("signs, via the Proof SDK, the request a handoff would carry", async () => {
    const pr = await requestProof(`${merchant}/x401/buy/vitamin-d3-2000`, {
      agentId: "did:pkh:eip155:84532:0x1111111111111111111111111111111111111111",
      loginHint: "andrew@thisisandrew.me",
    });
    const { header, claims } = decodeDcApiRequest(pr.requirement!.request);
    expect(header).toMatchObject({ typ: "oauth-authz-req+jwt", alg: "ES256" });
    expect(claims).toMatchObject({
      iss: `${ORIGIN}/.well-known/proof-client.json`,
      client_id: `${ORIGIN}/.well-known/proof-client.json`,
      aud: "https://api.fairfax.proof.com/verifiable-credentials/v1/presentation",
      response_mode: "dc_api",
      login_hint: "andrew@thisisandrew.me",
      expected_origins: [ORIGIN],
      scope: "urn:proof:params:scope:verifiable-credentials:basic",
    });
    // The SDK signs one transaction_data per request: the basket, no session data.
    expect(claims.transaction_data).toHaveLength(1);
    expect(decodeTxData(claims.transaction_data![0]!).type).toBe("urn:proof:params:vc:transaction-data:payment-itemized:v1");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
  });
});
