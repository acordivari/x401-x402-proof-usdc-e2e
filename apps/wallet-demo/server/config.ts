/**
 * Typed, centralized configuration for the demo orchestrator — the same
 * pattern as `packages/merchant/src/config.ts`. Every env var the orchestrator
 * honors is read HERE, once, at `resolveDemoConfig()` time (never at module
 * import), so tests can set env and then boot, and the fail-closed checks
 * (encryptor key, auth token, session secret) throw before any server listens.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

// --- the three selectable wallet workflows ---
//   self-issued : browser-held local SD-JWT-VC, per-purchase consent (offline)
//   proof-hosted: real Proof wallet via the proof-vc-server SDK, per-purchase
//   delegated   : one upfront grant -> a durable, scoped mandate the agent then
//                 spends autonomously (no per-purchase human approval)
export const FLOWS = ["self-issued", "proof-hosted", "delegated"] as const;
export type Flow = (typeof FLOWS)[number];

export interface DemoConfig {
  merchantPayTo: `0x${string}`;
  /** 0 => ephemeral (tests). */
  merchantPort: number;
  demoPort: number;
  verifierId: string;
  localIssuerId: string;
  mode: "live" | "local";
  defaultFlow: Flow;
  /** CAIP-2 network stamped into payment transaction_data. */
  network: string;
  /** Delegated-mandate defaults: a long-lived budget the agent spends within. */
  mandateTtlSeconds: number;
  mandateBudgetUsd: string;
  /**
   * Revocation channel: "local" = in-process registry shared with the merchant;
   * "http" = the merchant reads an issuer status endpoint (fail-closed).
   */
  revocationMode: "local" | "http";
  revocationTimeoutMs?: number;
  /** Spend-cap ledger: "local" = merchant-private in-memory; "http" = central durable service. */
  ledgerMode: "local" | "http";
  ledgerFile: string;
  /** Session store seam: "memory" (drop on restart) or durable "file". */
  sessionStore: "memory" | "file";
  sessionFile: string;
  sessionTtlMs: number;
  /** Exposed posture (NODE_ENV=production or DEMO_REQUIRE_AUTH=true): fail closed, Secure cookies. */
  exposed: boolean;
  /** Shared access token; undefined => gate disabled (local dev only). */
  authToken?: string;
  /** Signs the session cookie. Random per-boot locally; required when exposed. */
  sessionSecret: string;
  /** Authenticates the x401 challenge state that seals the payment binding. */
  encryptorKey: string;
  proof: {
    trustRoot: "development" | "production";
    /** "sandbox" => api.fairfax.proof.com */
    environment: string;
    responseMode: "fragment" | "direct_post";
    clientId?: string;
    clientSecret?: string;
    /** Where Proof's hosted flow redirects the browser back to. */
    callbackUri: string;
    loginHint: string;
    paymentInstrumentType: string;
    /** Defaults (in the app) to the agent wallet when unset. */
    paymentInstrumentId?: string;
    paymentCurrency: string;
  };
}

// The built-in x401 encryptor key is for LOCAL/OFFLINE dev only. If it ever took
// its default value in a shared/live deployment, the payment binding would be
// forgeable — so live/production refuses to boot with it.
const DEV_ENCRYPTOR_KEY = "dev-only-x401-encryptor-key-change-me";

export function resolveDemoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const mode = env.PROOF_MODE === "live" ? "live" : "local";
  const exposed = env.NODE_ENV === "production" || env.DEMO_REQUIRE_AUTH === "true";
  const demoPort = Number(env.DEMO_PORT ?? 4040);

  // Fail-closed resolutions — these THROW before any server boots.
  const encryptorKey = (() => {
    const key = env.X401_ENCRYPTOR_KEY;
    const usingDefault = !key || key === DEV_ENCRYPTOR_KEY;
    if (!usingDefault) return key;
    if (mode === "live" || env.NODE_ENV === "production") {
      throw new Error(
        "X401_ENCRYPTOR_KEY must be set to a strong, non-default value when PROOF_MODE=live " +
          "or NODE_ENV=production — it authenticates the x401 challenge state that seals the " +
          "payment binding. Refusing to boot with the built-in dev key.",
      );
    }
    if (env.NODE_ENV !== "test") {
      console.warn(
        "[demo] WARNING: using the built-in dev X401_ENCRYPTOR_KEY (local/offline only). " +
          "Set X401_ENCRYPTOR_KEY for any shared or live deployment.",
      );
    }
    return DEV_ENCRYPTOR_KEY;
  })();
  const authToken = (() => {
    if (env.DEMO_AUTH_TOKEN) return env.DEMO_AUTH_TOKEN;
    if (exposed) {
      throw new Error(
        "DEMO_AUTH_TOKEN must be set when NODE_ENV=production or DEMO_REQUIRE_AUTH=true — " +
          "refusing to boot the orchestrator with no authentication.",
      );
    }
    return undefined;
  })();
  const sessionSecret = (() => {
    if (env.DEMO_SESSION_SECRET) return env.DEMO_SESSION_SECRET;
    if (exposed) {
      throw new Error("DEMO_SESSION_SECRET must be set when NODE_ENV=production or DEMO_REQUIRE_AUTH=true.");
    }
    return randomUUID(); // ephemeral: sessions simply don't survive a restart in local dev
  })();

  return {
    merchantPayTo: (env.MERCHANT_PAY_TO ?? "0xc0ffee0000000000000000000000000000000000").toLowerCase() as `0x${string}`,
    merchantPort: Number(env.MERCHANT_PORT ?? 4052),
    demoPort,
    verifierId: env.X401_VERIFIER_ID ?? "https://sandbox.local/merchant",
    localIssuerId: env.X401_LOCAL_ISSUER_ID ?? "https://issuer.sandbox.local",
    mode,
    defaultFlow: (FLOWS as readonly string[]).includes(env.WALLET_FLOW ?? "")
      ? (env.WALLET_FLOW as Flow)
      : "self-issued",
    network: env.X402_NETWORK ?? "eip155:84532",
    mandateTtlSeconds: Number(env.MANDATE_TTL ?? 86_400), // 24h
    mandateBudgetUsd: env.MANDATE_BUDGET ?? "5.00",
    revocationMode: env.REVOCATION_MODE === "http" ? "http" : "local",
    ...(env.REVOCATION_STATUS_TIMEOUT_MS
      ? { revocationTimeoutMs: Number(env.REVOCATION_STATUS_TIMEOUT_MS) }
      : {}),
    ledgerMode: env.LEDGER_MODE === "http" ? "http" : "local",
    ledgerFile: env.LEDGER_FILE ?? path.join(os.tmpdir(), "agentic-payments-spend-ledger.json"),
    sessionStore: env.SESSION_STORE === "file" ? "file" : "memory",
    sessionFile: env.SESSION_FILE ?? path.join(os.tmpdir(), "agentic-payments-sessions.json"),
    sessionTtlMs: Number(env.DEMO_SESSION_TTL_MS ?? 3_600_000), // 1h idle
    exposed,
    ...(authToken !== undefined ? { authToken } : {}),
    sessionSecret,
    encryptorKey,
    proof: {
      trustRoot: env.PROOF_TRUST_ROOT === "production" ? "production" : "development",
      environment: env.PROOF_ENVIRONMENT ?? "sandbox",
      responseMode: env.PROOF_RESPONSE_MODE === "direct_post" ? "direct_post" : "fragment",
      ...(env.PROOF_CLIENT_ID ? { clientId: env.PROOF_CLIENT_ID } : {}),
      ...(env.PROOF_CLIENT_SECRET ? { clientSecret: env.PROOF_CLIENT_SECRET } : {}),
      callbackUri: env.PROOF_REDIRECT_URI ?? `http://localhost:${demoPort}/proof/callback`,
      loginHint: env.PROOF_LOGIN_HINT ?? "",
      paymentInstrumentType: env.PROOF_PAYMENT_INSTRUMENT_TYPE ?? "crypto",
      ...(env.PROOF_PAYMENT_INSTRUMENT_ID
        ? { paymentInstrumentId: env.PROOF_PAYMENT_INSTRUMENT_ID }
        : {}),
      paymentCurrency: env.PROOF_PAYMENT_CURRENCY ?? "USD",
    },
  };
}
