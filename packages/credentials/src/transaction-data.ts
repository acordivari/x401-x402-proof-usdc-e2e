/**
 * OID4VP `transaction_data` — the mechanism that turns a plain identity
 * presentation into proof that *this human authorized this payment*. Proof's
 * presentation flow accepts a `payment-mandate` transaction_data object the
 * End-User explicitly approves; the returned vp_token is bound to its digest.
 * We build the same object for the live path AND for the local seam, so the
 * 401↔402 join is identical in both.
 */
import { encodeJsonB64url, sha256Base64url } from "./crypto.ts";
import { PROOF_CREDENTIAL_ID } from "./proof-credential.ts";

export const PAYMENT_MANDATE_TX_TYPE =
  "urn:proof:params:vc:transaction-data:payment-mandate:v1" as const;

/** The common OID4VP transaction_data envelope (any type). */
export interface ProofTransactionData {
  type: string;
  credential_ids: string[];
  payload: object;
}

/**
 * Our internal payment record. This is what we seal into the x401 challenge and
 * re-verify, regardless of which transaction_data type Proof is sent — so the
 * agent's payment is always bound at the x401 layer.
 */
export interface PaymentMandatePayload {
  amount: string; // atomic USDC units
  currency: string; // "USDC"
  merchant: string; // 0x receiving address
  asset?: string; // token contract
  network?: string; // e.g. eip155:84532
  sku?: string;
  description?: string;
}

export interface PaymentMandateTransactionData extends ProofTransactionData {
  type: typeof PAYMENT_MANDATE_TX_TYPE;
  payload: PaymentMandatePayload;
}

/** Build our internal payment transaction_data (sealed into the x401 challenge). */
export function buildPaymentMandateTransactionData(
  payload: PaymentMandatePayload,
): PaymentMandateTransactionData {
  return { type: PAYMENT_MANDATE_TX_TYPE, credential_ids: [PROOF_CREDENTIAL_ID], payload };
}

/** Encode transaction_data for the wire (base64url JSON), per the Proof API. */
export function encodeTransactionData(td: ProofTransactionData): string {
  return encodeJsonB64url(td);
}

/** sha-256 digest (base64url) of the *encoded* transaction_data string. */
export function transactionDataDigest(encoded: string): Promise<string> {
  return sha256Base64url(encoded);
}
