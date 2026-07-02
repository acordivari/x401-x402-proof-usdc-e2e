/**
 * Load + verify a standing live-buyer mandate (the grant file live:grant
 * writes). The buyer refuses to spend unless the mandate's signature verifies
 * against the bundled trust anchor, the validity window is open, and the
 * mandate binds the wallet that is about to sign — the wallet-side mirror of
 * the merchant's mandate gate, for merchants that have never heard of HAM.
 */
import { readFileSync } from "node:fs";
import {
  IntentMandate,
  collect,
  nowSeconds,
  type ValidationResult,
} from "@agentic-payments/shared";
import { MandateVerifier, trustedKeyFromJwk } from "@agentic-payments/identity";

export const LIVE_MANDATE_VERSION = 1 as const;

export interface LiveMandateFile {
  version: typeof LIVE_MANDATE_VERSION;
  intent: IntentMandate;
  /** The Authorization Service's public JWK — the buyer's trust anchor. */
  issuerPublicJwk: Record<string, unknown>;
  holder: string;
  /** CAIP-2 network the grant was issued for. */
  network: string;
  createdAt: string;
}

/** Read and structurally validate a grant file. Throws on any problem. */
export function loadMandateGrant(filePath: string): LiveMandateFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`cannot read mandate grant ${filePath}: ${(err as Error).message}`);
  }
  const parsed = JSON.parse(raw) as LiveMandateFile;
  if (parsed.version !== LIVE_MANDATE_VERSION || !parsed.issuerPublicJwk) {
    throw new Error(`mandate grant ${filePath} is malformed or an unsupported version`);
  }
  return { ...parsed, intent: IntentMandate.parse(parsed.intent) };
}

export interface VerifyGrantInput {
  grant: LiveMandateFile;
  /** The wallet about to sign payments; must be the one the mandate binds. */
  agentWallet?: `0x${string}`;
  /** The network this run pays on; must match the grant. */
  network?: string;
  now?: number;
}

/** Signature + window + wallet/network binding — all fail-closed. */
export async function verifyMandateGrant(input: VerifyGrantInput): Promise<ValidationResult> {
  const { grant } = input;
  const now = input.now ?? nowSeconds();
  const verifier = new MandateVerifier([
    await trustedKeyFromJwk(grant.issuerPublicJwk as never),
  ]);
  const signatureOk = await verifier.verifyProof(grant.intent);
  return collect([
    signatureOk ? null : "mandate signature is invalid or not from the bundled trust anchor",
    now < grant.intent.expiresAt ? null : "mandate has expired — issue a new grant",
    now >= grant.intent.issuedAt ? null : "mandate is not yet active",
    !input.agentWallet || input.agentWallet === grant.intent.agentWallet
      ? null
      : `mandate binds agent ${grant.intent.agentWallet}, not this wallet ${input.agentWallet}`,
    !input.network || input.network === grant.network
      ? null
      : `mandate was granted for ${grant.network}, not ${input.network}`,
  ]);
}
