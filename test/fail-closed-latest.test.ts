/**
 * Boot guards for the LATEST variant's config. Live mode needs a real P-256
 * verifier key and an https origin Proof can fetch the CIMD from; anything
 * else either refuses to boot or stays offline — never a half-live verifier.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveDemoConfig } from "../apps/wallet-demo/server/config.ts";

const base = {
  X401_ENCRYPTOR_KEY: "strong-non-default-key-for-this-test",
  DEMO_AUTH_TOKEN: "strong-token",
  DEMO_SESSION_SECRET: "strong-secret",
} as NodeJS.ProcessEnv;

const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("latest variant config", () => {
  it("is offline unless LATEST_PROOF_MODE=live — PROOF_MODE is July's switch", () => {
    expect(resolveDemoConfig({ ...base, PROOF_MODE: "live" }).latest.mode).toBe("local");
    expect(resolveDemoConfig({ ...base, PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem, PUBLIC_ORIGIN: "https://shop.example" }).latest.mode).toBe("local");
  });

  it("refuses an incomplete live request instead of silently running offline", () => {
    expect(() => resolveDemoConfig({ ...base, LATEST_PROOF_MODE: "live", PUBLIC_ORIGIN: "https://shop.example" })).toThrow(/PROOF_VERIFIER_KEY/);
  });

  it("refuses live alongside open access", () => {
    expect(() => resolveDemoConfig({
      ...base, DEMO_AUTH_TOKEN: undefined, DEMO_OPEN_ACCESS: "true", NODE_ENV: "production",
      LATEST_PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem, PUBLIC_ORIGIN: "https://shop.example",
    })).toThrow(/DEMO_OPEN_ACCESS/);
  });

  it("refuses live alongside a published token — open access by another name", () => {
    expect(() => resolveDemoConfig({
      ...base, DEMO_PUBLIC_TOKEN: "printed-on-the-login-screen",
      LATEST_PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem, PUBLIC_ORIGIN: "https://shop.example",
    })).toThrow(/DEMO_PUBLIC_TOKEN/);
  });

  it("goes live with a P-256 PEM key and an https origin", () => {
    const cfg = resolveDemoConfig({ ...base, LATEST_PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem, PUBLIC_ORIGIN: "https://shop.example/anything" });
    expect(cfg.latest.mode).toBe("live");
    expect(cfg.latest.publicOrigin).toBe("https://shop.example");
    expect(cfg.latest.proof.verifierPrivateJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("accepts a PEM pasted with escaped newlines (as PaaS env editors store it)", () => {
    const cfg = resolveDemoConfig({ ...base, LATEST_PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem.replace(/\n/g, "\\n"), PUBLIC_ORIGIN: "https://shop.example" });
    expect(cfg.latest.mode).toBe("live");
  });

  it("refuses a live verifier on an http origin Proof could not fetch", () => {
    expect(() => resolveDemoConfig({ ...base, LATEST_PROOF_MODE: "live", PROOF_VERIFIER_KEY: pem, PUBLIC_ORIGIN: "http://shop.example" }))
      .toThrow(/https PUBLIC_ORIGIN/);
  });

  it("refuses a verifier key that is not P-256", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => resolveDemoConfig({ ...base, PROOF_VERIFIER_KEY: rsa })).toThrow(/P-256/);
    expect(() => resolveDemoConfig({ ...base, PROOF_VERIFIER_KEY: "not a key" })).toThrow(/PROOF_VERIFIER_KEY/);
  });

  it("refuses a malformed verifier EVM key", () => {
    expect(() => resolveDemoConfig({ ...base, PROOF_VERIFIER_EVM_KEY: "0x1234" })).toThrow(/PROOF_VERIFIER_EVM_KEY/);
  });

  it("uses Render's external URL as the origin, and admits dev origins only when not exposed", () => {
    const exposed = resolveDemoConfig({ ...base, NODE_ENV: "production", RENDER_EXTERNAL_URL: "https://demo.onrender.com" });
    expect(exposed.latest.publicOrigin).toBe("https://demo.onrender.com");
    expect(exposed.latest.expectedOrigins).toEqual(["https://demo.onrender.com"]);
    expect(exposed.latest.allowInsecureUri).toBe(false);
    const local = resolveDemoConfig({ ...base, DEMO_AUTH_TOKEN: undefined, DEMO_SESSION_SECRET: undefined });
    expect(local.latest.expectedOrigins).toContain("http://localhost:5173");
    expect(local.latest.allowInsecureUri).toBe(true);
  });
});
