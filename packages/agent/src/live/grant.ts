/**
 * live:grant — the "human presents once" step for the live buyer, headless.
 *
 *   npm run live:grant -- --merchant 0xPAYEE[,0xPAYEE2] [--budget 1.00]
 *                         [--ttl 86400] [--holder andrew@example.com]
 *                         [--mainnet] [--out .live-mandate.json]
 *
 * Runs the exact x401 flow the wallet demo's delegated workflow uses — issue a
 * local SD-JWT-VC, selectively disclose it against a challenge with the budget
 * grant's transaction_data sealed in, verify the presentation — and then has
 * the Authorization Service issue ONE durable, signed IntentMandate:
 * budget cap + payee allowlist + expiry, bound to the agent's wallet address.
 *
 * The signed mandate and the AS public key (the trust anchor) are written to a
 * grant file that `live:buy` verifies and enforces on every purchase. The AS
 * private key is discarded: the grant cannot be amended, only expire (or be
 * deleted). Enforcement is wallet-side — open-web merchants never see HAM.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  atomicToDollars,
  buildAgentDid,
  buildWalletControlMessage,
  dollarsToAtomic,
  loadEnv,
  type IntentMandate,
  type NetworkConfig,
} from "@agentic-payments/shared";
import {
  buildPaymentMandateTransactionData,
  buildProofIdDcqlQuery,
  buildProofRequest,
  createEncryptor,
  createIdentityChallenge,
  detectRequirement,
  encodeTransactionData,
  generateEs256Keys,
  getRequestChallenge,
  localVcVerifier,
  packCredentialResult,
  verifyAuthorization,
  DEMO_HOLDERS,
  LocalVcIssuer,
  LocalWallet,
  PROOF_BASIC_SCOPE,
  PROOF_CREDENTIAL_ID,
  PROOF_ID_CLAIM_KEYS,
} from "@agentic-payments/credentials";
import {
  AuthorizationService,
  MandateSigner,
  createSigningKeyPair,
  eip191AccountControl,
} from "@agentic-payments/identity";
import { createLocalSigner, createSigner, personalSign } from "../wallet.ts";
import { LIVE_MANDATE_VERSION, type LiveMandateFile } from "./mandate.ts";

const VERIFIER_ID = "https://live-buyer.local/verifier";
const ISSUER_ID = "https://issuer.live-buyer.local";
const GRANT_CLAIMS = ["given_name", "family_name", "email"];

export interface LiveGrantOptions {
  /** Payees (0x addresses) the mandate authorizes. */
  merchantAllowlist: `0x${string}`[];
  budgetUsdc: string;
  ttlSeconds: number;
  network: NetworkConfig;
  /** Which demo holder presents (the "human"). */
  holder: string;
  /** The agent wallet address the mandate binds to. */
  agentWallet: `0x${string}`;
  /**
   * Personal-sign with the agent wallet. When present, the grant carries a
   * wallet-control proof over the same single-use challenge as the human's
   * presentation, and the AS verifies it (EIP-191) before signing — the
   * account-control step.
   */
  signMessage?: (message: string) => Promise<`0x${string}`>;
}

/**
 * Run the x401 presentation and issue the signed standing mandate. Exported so
 * the offline e2e can drive the same path the CLI does.
 */
export async function issueLiveGrant(opts: LiveGrantOptions): Promise<LiveMandateFile> {
  const holderClaims = DEMO_HOLDERS[opts.holder];
  if (!holderClaims) {
    throw new Error(`unknown holder "${opts.holder}" — known: ${Object.keys(DEMO_HOLDERS).join(", ")}`);
  }
  const budgetAtomic = dollarsToAtomic(opts.budgetUsdc).toString();

  // The human's wallet: a local SD-JWT-VC issued to a fresh holder key.
  const issuerKeys = await generateEs256Keys();
  const holderKeys = await generateEs256Keys();
  const issuer = new LocalVcIssuer({ issuerId: ISSUER_ID, privateJwk: issuerKeys.privateJwk });
  const wallet = new LocalWallet(holderKeys.privateJwk, holderKeys.publicJwk);
  wallet.store({
    id: PROOF_CREDENTIAL_ID,
    compact: await issuer.issue(holderClaims, wallet.publicJwk),
    claimNames: [...PROOF_ID_CLAIM_KEYS],
  });

  // The budget grant, sealed into a single-use x401 challenge. The encryptor is
  // ephemeral to this run: challenge creation and verification both happen here.
  const promptSummary =
    `Standing mandate: authorize agent ${opts.agentWallet} to spend up to ` +
    `$${opts.budgetUsdc} USDC on ${opts.network.caip2} at ${opts.merchantAllowlist.join(", ")}.`;
  const transactionData = encodeTransactionData(
    buildPaymentMandateTransactionData({
      amount: budgetAtomic,
      currency: "USDC",
      merchant: opts.merchantAllowlist[0]!,
      network: opts.network.caip2,
      sku: "mandate-grant",
      description: promptSummary,
    }),
  );
  const encryptor = createEncryptor({ key: randomUUID(), purpose: "x401-live-grant" });
  const resource = `${VERIFIER_ID}/mandate/grant`;
  const challenge = await createIdentityChallenge({
    encryptor, verifierId: VERIFIER_ID, resource, method: "GET",
    ttlSeconds: 600, transactionData,
  });
  const { payload, header } = buildProofRequest({
    challenge, tokenEndpoint: `${VERIFIER_ID}/oauth/token`,
    scope: PROOF_BASIC_SCOPE, requestId: "proof-id-v1",
  });
  const detected = detectRequirement({ "PROOF-REQUEST": header });
  if (!detected) throw new Error("failed to build the x401 PROOF-REQUEST");

  // The human "presents once": selective disclosure + KB-JWT over the nonce.
  const presented = await wallet.present({
    query: buildProofIdDcqlQuery(GRANT_CLAIMS),
    nonce: getRequestChallenge(detected.payload).value,
    audience: VERIFIER_ID,
  });
  const agentDid = buildAgentDid(opts.network.caip2, opts.agentWallet);
  const { header: resultHeader } = packCredentialResult({
    payload, agentId: agentDid, vpToken: presented.vpToken,
  });

  // Verify exactly as a standalone verifier would: challenge + credential +
  // holder/nonce binding + the payment (budget) digest.
  const authorization = await verifyAuthorization({
    resultHeader,
    encryptor,
    vcVerifier: localVcVerifier({ issuerId: ISSUER_ID, issuerPublicJwk: issuerKeys.publicJwk }),
    expectedVerifierId: VERIFIER_ID,
    expectedResource: resource,
    expectedMethod: "GET",
    requiredClaims: GRANT_CLAIMS,
    transactionData,
  });

  // The agent proves control of the wallet being bound by signing the same
  // single-use challenge the human's presentation just satisfied.
  const walletProof = opts.signMessage
    ? {
        challenge: challenge.value,
        signature: await opts.signMessage(
          buildWalletControlMessage({ agentId: agentDid, challenge: challenge.value }),
        ),
      }
    : undefined;

  // Issue the ONE durable mandate. The AS key lives only for this call; its
  // public half ships in the grant file as the buyer's trust anchor.
  const asKey = await createSigningKeyPair(`live-grant-${randomUUID().slice(0, 8)}`);
  const service = new AuthorizationService(
    { verify: async () => { throw new Error("OIDC path disabled for live grants"); } } as never,
    new MandateSigner(asKey),
    undefined,
    undefined,
    walletProof ? eip191AccountControl() : undefined,
  );
  const intent: IntentMandate = await service.issueIntentFromPresentation({
    authorization,
    agentWallet: opts.agentWallet,
    scope: {
      maxAmount: budgetAtomic,
      merchantAllowlist: opts.merchantAllowlist,
      allowedCategories: ["open-web"],
    },
    ttlSeconds: opts.ttlSeconds,
    // Bind the wallet-native agentId to the chain this grant pays on — the
    // chain id is part of the identity.
    network: opts.network.caip2,
    ...(walletProof ? { walletProof } : {}),
  });

  return {
    version: LIVE_MANDATE_VERSION,
    intent,
    issuerPublicJwk: { ...asKey.publicJwk },
    holder: opts.holder,
    network: opts.network.caip2,
    createdAt: new Date().toISOString(),
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      merchant: { type: "string" },
      budget: { type: "string", default: "1.00" },
      ttl: { type: "string", default: "86400" },
      holder: { type: "string", default: "andrew@example.com" },
      mainnet: { type: "boolean", default: false },
      out: { type: "string", default: ".live-mandate.json" },
    },
  });
  const merchants = (values.merchant ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (merchants.length === 0 || !merchants.every((m) => /^0x[0-9a-f]{40}$/.test(m))) {
    console.error(
      "usage: npm run live:grant -- --merchant 0xPAYEE[,0xPAYEE2] [--budget 1.00] [--ttl 86400] [--mainnet] [--out .live-mandate.json]\n" +
        "  (find a resource's payTo with a live:buy dry run — you are authorizing WHO may be paid)",
    );
    process.exit(2);
  }

  (async () => {
    const env = process.env;
    if (!env.WALLET_MODE) env.WALLET_MODE = env.AGENT_PRIVATE_KEY ? "local" : "cdp";
    const signer =
      env.WALLET_MODE === "local"
        ? createLocalSigner(env.AGENT_PRIVATE_KEY as `0x${string}` | undefined)
        : await createSigner(env);
    const grant = await issueLiveGrant({
      merchantAllowlist: merchants as `0x${string}`[],
      budgetUsdc: values.budget,
      ttlSeconds: Number(values.ttl),
      network: values.mainnet ? BASE_MAINNET : BASE_SEPOLIA,
      holder: values.holder,
      agentWallet: signer.address,
      signMessage: (message) => personalSign(signer, message),
    });
    writeFileSync(values.out, JSON.stringify(grant, null, 2));
    const scope = grant.intent.scope;
    console.log(`[live-grant] signed standing mandate ${grant.intent.id}`);
    console.log(`[live-grant]   principal  ${grant.intent.principal.sub} (via ${grant.intent.principal.verifiedVia})`);
    console.log(`[live-grant]   agent      ${grant.intent.agentWallet} (${signer.label})`);
    console.log(`[live-grant]   budget     ${atomicToDollars(BigInt(scope.maxAmount))} USDC on ${grant.network}`);
    console.log(`[live-grant]   payees     ${scope.merchantAllowlist.join(", ")}`);
    console.log(`[live-grant]   expires    ${new Date(grant.intent.expiresAt * 1000).toISOString()}`);
    console.log(`[live-grant]   saved to   ${values.out} — live:buy now enforces it`);
  })().catch((err) => {
    console.error(`[live-grant] failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
