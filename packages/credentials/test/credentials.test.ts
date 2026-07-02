/**
 * The verifiable-credentials seam — the highest-complexity, multi-state piece
 * (issue → hold → DCQL-select → present → verify, plus payment binding). These
 * tests run the full local round trip with no network and assert the failure
 * modes the protocol must catch: selective disclosure, holder/nonce binding,
 * tampering, and the transaction_data (payment) binding that makes this 401+402.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildPaymentMandateTransactionData,
  buildProofIdDcqlQuery,
  createEncryptor,
  createIdentityChallenge,
  buildProofRequest,
  detectRequirement,
  getRequestChallenge,
  packCredentialResult,
  verifyAuthorization,
  encodeTransactionData,
  generateEs256Keys,
  localVcVerifier,
  LocalVcIssuer,
  LocalWallet,
  DEMO_HOLDERS,
  PROOF_CREDENTIAL_ID,
  PROOF_ID_CLAIM_KEYS,
  type Jwk,
  type VerifiableCredentialVerifier,
  type X401Payload,
} from "../src/index.ts";

const ISSUER_ID = "https://issuer.sandbox.local";
const VERIFIER_ID = "https://merchant.sandbox.local";
const RESOURCE = "https://merchant.sandbox.local/buy/allergy-relief-24";
const TOKEN_ENDPOINT = "https://merchant.sandbox.local/oauth/token";

let issuerKeys: { publicJwk: Jwk; privateJwk: Jwk };
let issuer: LocalVcIssuer;
let wallet: LocalWallet;
let vcVerifier: VerifiableCredentialVerifier;

function encryptor() {
  return createEncryptor({ key: "credentials-test-key-0123456789", purpose: "x401-test" });
}

const txData = () =>
  encodeTransactionData(
    buildPaymentMandateTransactionData({
      amount: "1500000",
      currency: "USDC",
      merchant: "0xc0ffee0000000000000000000000000000000000",
      network: "eip155:84532",
      sku: "allergy-relief-24",
    }),
  );

/** Build PROOF-REQUEST, present from the wallet, return the PROOF-RESPONSE header. */
async function authorize(opts: {
  enc: ReturnType<typeof encryptor>;
  requested: string[];
  transactionData?: string;
}): Promise<{ resultHeader: string; payload: X401Payload; disclosed: string[]; withheld: string[]; missing: string[] }> {
  const challenge = await createIdentityChallenge({
    encryptor: opts.enc,
    verifierId: VERIFIER_ID,
    resource: RESOURCE,
    method: "GET",
    ttlSeconds: 600,
    ...(opts.transactionData !== undefined ? { transactionData: opts.transactionData } : {}),
  });
  const { payload, header } = buildProofRequest({
    challenge,
    tokenEndpoint: TOKEN_ENDPOINT,
    scope: "urn:proof:params:scope:verifiable-credentials:basic",
    requestId: "proof-id-v1",
  });
  const detected = detectRequirement({ "PROOF-REQUEST": header });
  expect(detected).toBeTruthy();
  const present = await wallet.present({
    query: buildProofIdDcqlQuery(opts.requested),
    nonce: getRequestChallenge(detected!.payload).value,
    audience: VERIFIER_ID,
  });
  const { header: resultHeader } = packCredentialResult({
    payload,
    agentId: "did:web:agent.sandbox.local",
    vpToken: present.vpToken,
  });
  return { resultHeader, payload, ...present };
}

beforeAll(async () => {
  issuerKeys = await generateEs256Keys();
  const holderKeys = await generateEs256Keys();
  issuer = new LocalVcIssuer({ issuerId: ISSUER_ID, privateJwk: issuerKeys.privateJwk });
  wallet = new LocalWallet(holderKeys.privateJwk, holderKeys.publicJwk);
  const compact = await issuer.issue(DEMO_HOLDERS["andrew@example.com"]!, wallet.publicJwk);
  wallet.store({ id: PROOF_CREDENTIAL_ID, compact, claimNames: [...PROOF_ID_CLAIM_KEYS] });
  vcVerifier = localVcVerifier({ issuerId: ISSUER_ID, issuerPublicJwk: issuerKeys.publicJwk });
});

describe("DCQL selective disclosure", () => {
  it("reveals only the requested claims and withholds the rest", async () => {
    const { disclosed, withheld, missing } = await authorize({
      enc: encryptor(),
      requested: ["given_name", "family_name", "age_over_21"],
    });
    expect(disclosed.sort()).toEqual(["age_over_21", "family_name", "given_name"]);
    expect(withheld).toContain("email");
    expect(withheld).toContain("birth_date");
    expect(missing).toEqual([]);
  });

  it("reports requested-but-unheld claims as missing", async () => {
    const { missing } = await authorize({ enc: encryptor(), requested: ["given_name", "passport_photo"] });
    expect(missing).toEqual(["passport_photo"]);
  });
});

describe("verifyAuthorization (x401 challenge + VC + payment binding)", () => {
  it("verifies a valid presentation bound to the payment", async () => {
    const enc = encryptor();
    const td = txData();
    const { resultHeader } = await authorize({ enc, requested: ["given_name", "family_name", "age_over_21"], transactionData: td });
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: enc,
      vcVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: RESOURCE,
      expectedMethod: "GET",
      requiredClaims: ["given_name", "family_name", "age_over_21"],
      transactionData: td,
    });
    expect(v.result.ok).toBe(true);
    expect(v.challengeOk).toBe(true);
    expect(v.txDataBound).toBe(true);
    expect(v.proof?.nonceBound).toBe(true);
    expect(v.proof?.holderBound).toBe(true);
    expect(v.proof?.issuer).toBe(ISSUER_ID);
    expect(v.proof?.subject).toEqual({ given_name: "Andrew", family_name: "Cordivari", age_over_21: true });
  });

  it("rejects when the payment is tampered (transaction_data binding broken)", async () => {
    const enc = encryptor();
    const { resultHeader } = await authorize({ enc, requested: ["given_name"], transactionData: txData() });
    const tamperedTd = encodeTransactionData(
      buildPaymentMandateTransactionData({ amount: "9900000", currency: "USDC", merchant: "0xc0ffee0000000000000000000000000000000000" }),
    );
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: enc,
      vcVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: RESOURCE,
      expectedMethod: "GET",
      requiredClaims: ["given_name"],
      transactionData: tamperedTd,
    });
    expect(v.txDataBound).toBe(false);
    expect(v.result.ok).toBe(false);
  });

  it("rejects when a DCQL-required claim was not disclosed", async () => {
    const enc = encryptor();
    const { resultHeader } = await authorize({ enc, requested: ["given_name"] });
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: enc,
      vcVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: RESOURCE,
      expectedMethod: "GET",
      requiredClaims: ["given_name", "email"],
    });
    expect(v.result.ok).toBe(false);
    expect(v.result.ok === false && v.result.violations.join()).toMatch(/email/);
  });

  it("rejects a challenge replayed against a different resource", async () => {
    const enc = encryptor();
    const { resultHeader } = await authorize({ enc, requested: ["given_name"] });
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: enc,
      vcVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: "https://merchant.sandbox.local/buy/something-else",
      expectedMethod: "GET",
      requiredClaims: ["given_name"],
    });
    expect(v.challengeOk).toBe(false);
    expect(v.result.ok).toBe(false);
  });

  it("rejects a presentation verified under a different challenge encryptor", async () => {
    const { resultHeader } = await authorize({ enc: encryptor(), requested: ["given_name"] });
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: createEncryptor({ key: "a-totally-different-secret-key", purpose: "x401-test" }),
      vcVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: RESOURCE,
      expectedMethod: "GET",
      requiredClaims: ["given_name"],
    });
    expect(v.result.ok).toBe(false);
  });

  it("rejects a credential from an untrusted issuer", async () => {
    const enc = encryptor();
    const { resultHeader } = await authorize({ enc, requested: ["given_name"] });
    const strangerVerifier = localVcVerifier({
      issuerId: "https://evil.example.com",
      issuerPublicJwk: issuerKeys.publicJwk,
    });
    const v = await verifyAuthorization({
      resultHeader,
      encryptor: enc,
      vcVerifier: strangerVerifier,
      expectedVerifierId: VERIFIER_ID,
      expectedResource: RESOURCE,
      expectedMethod: "GET",
      requiredClaims: ["given_name"],
    });
    expect(v.result.ok).toBe(false);
  });
});
