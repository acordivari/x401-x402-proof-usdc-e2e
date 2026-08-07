/**
 * Security regression: the Proof VC layer is pinned to Proof's FAIRFAX SANDBOX.
 * Any boot that could reach the real Proof network (PROOF_MODE=live) — and any
 * exposed deployment, so a later PROOF_MODE flip on a public instance can't escape
 * the pin — must FAIL CLOSED when PROOF_ENVIRONMENT / PROOF_TRUST_ROOT point
 * anywhere other than the sandbox and its development trust root.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveDemoConfig } from "../apps/wallet-demo/server/config.ts";

/** A minimal env that satisfies every OTHER fail-closed check, so the only thing
 *  under test is the Fairfax pin. */
const base = {
  X401_ENCRYPTOR_KEY: "strong-non-default-key-for-this-test",
  DEMO_AUTH_TOKEN: "strong-token",
  DEMO_SESSION_SECRET: "strong-secret",
} as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env.PROOF_ENVIRONMENT;
  delete process.env.PROOF_TRUST_ROOT;
});

describe("Proof Fairfax sandbox pin (server boot guard)", () => {
  it("boots in live mode with the sandbox defaults", () => {
    const cfg = resolveDemoConfig({ ...base, PROOF_MODE: "live" });
    expect(cfg.proof.environment).toBe("sandbox");
    expect(cfg.proof.trustRoot).toBe("development");
  });

  it("refuses a live boot pointed at a non-sandbox Proof environment", () => {
    expect(() => resolveDemoConfig({ ...base, PROOF_MODE: "live", PROOF_ENVIRONMENT: "production" }))
      .toThrow(/Fairfax sandbox/);
  });

  it("refuses a live boot carrying the production trust root", () => {
    expect(() => resolveDemoConfig({ ...base, PROOF_MODE: "live", PROOF_TRUST_ROOT: "production" }))
      .toThrow(/Fairfax sandbox/);
  });

  it("refuses an EXPOSED boot off-sandbox even in local mode (no later flip can escape)", () => {
    expect(() =>
      resolveDemoConfig({
        ...base, PROOF_MODE: "local", DEMO_REQUIRE_AUTH: "true", PROOF_ENVIRONMENT: "next",
      }),
    ).toThrow(/Fairfax sandbox/);
  });

  it("leaves the offline local demo alone (pin only binds live/exposed boots)", () => {
    const cfg = resolveDemoConfig({ ...base, PROOF_MODE: "local", PROOF_ENVIRONMENT: "next" });
    expect(cfg.proof.environment).toBe("next");
  });
});

/**
 * Deploy regression: a PaaS injects the port to bind as PORT and routes only that
 * one, so binding anything else makes the service unreachable behind the router.
 */
describe("orchestrator port resolution", () => {
  it("prefers the platform-injected PORT over DEMO_PORT", () => {
    expect(resolveDemoConfig({ ...base, PORT: "10000", DEMO_PORT: "4040" }).demoPort).toBe(10_000);
  });

  it("falls back to DEMO_PORT off-platform, then to 4040", () => {
    expect(resolveDemoConfig({ ...base, DEMO_PORT: "4040" }).demoPort).toBe(4040);
    expect(resolveDemoConfig({ ...base }).demoPort).toBe(4040);
  });

  it("treats an empty PORT as unset (never binds port 0)", () => {
    // A platform exporting PORT="" would otherwise give Number("") === 0 — an
    // ephemeral port the router cannot reach, and a health check that never passes.
    expect(resolveDemoConfig({ ...base, PORT: "", DEMO_PORT: "4040" }).demoPort).toBe(4040);
    expect(resolveDemoConfig({ ...base, PORT: "" }).demoPort).toBe(4040);
  });
});
