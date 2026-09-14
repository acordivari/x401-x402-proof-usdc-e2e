<script lang="ts">
  /**
   * A REAL Proof credential, recorded once and re-verified on every load.
   *
   * The public demo runs on a self-issued credential you mint in-browser, which
   * proves the plumbing but not the trust: nothing in it was ever vouched for by
   * an identity provider. This card closes that gap without asking a visitor to
   * complete Proof's IDV — and then shows why the recording still cannot buy
   * anything, which is the same replay gate protecting a live presentation.
   *
   * This is the EVIDENCE panel. The narrative walkthrough of the same recording
   * lives in ProofWalkthrough.svelte, behind the "Proof wallet" tab, and this
   * card is hidden while that one is open.
   */
  import { usd } from "./api";
  let { exhibit }: { exhibit: any } = $props();

  /** Claim values are not always scalars — Proof returns age as {"18": true}. */
  const fmt = (v: unknown): string =>
    v === null || v === undefined
      ? "—"
      : typeof v === "object"
        ? Object.entries(v as Record<string, unknown>)
            .map(([k, val]) => `${k}: ${String(val)}`)
            .join(", ")
        : String(v);

  const rec = $derived(exhibit?.liveVerification?.asRecorded);
  const replay = $derived(exhibit?.liveVerification?.asReplayed);
  const cred = $derived(exhibit?.credential ?? {});
  const disc = $derived(exhibit?.disclosure ?? { disclosed: [], withheldCount: 0, totalSdClaims: 0 });
</script>

{#if exhibit?.available}
  <div class="card fade-in" style="border-color:rgba(47,210,160,.45)">
    <h2>
      <span class="step" style="background:var(--ok)">real</span>
      a genuine Proof credential
      <span class="badge b-mut" style="margin-left:auto">recorded exhibit</span>
    </h2>

    <p class="note" style="margin:0 0 12px">
      The credential you mint above is real cryptography, but you vouched for yourself. This
      one was issued by <b>Proof</b> to a real person who completed identity verification —
      re-verified by this server every time you load the page.
      <b>Open the “Proof wallet” tab</b> to walk through it step by step.
    </p>

    <!-- The two verifications. The second one is the point. -->
    <div class="kv" style="gap:8px 12px">
      <span class="k">Against its own challenge</span>
      <span>
        {#if rec?.ok}
          <span class="badge b-ok">verified ✓</span>
          <span class="mut" style="margin-left:6px">issuer chain · holder key · nonce</span>
        {:else}
          <span class="badge b-bad">failed ✗</span>
          <span class="mut" style="margin-left:6px">{rec?.violations?.join("; ")}</span>
        {/if}
      </span>
      <span class="k">Against a fresh challenge</span>
      <span>
        {#if replay?.ok === false}
          <span class="badge b-bad">rejected ✗</span>
          <span class="mut" style="margin-left:6px">{replay.violations?.join("; ")}</span>
        {:else}
          <span class="badge b-warn">unexpectedly accepted</span>
        {/if}
      </span>
    </div>

    <p class="note" style="margin:10px 0 0">
      That second line is the safety property, not a bug. A presentation is key-bound to the
      single-use nonce it was made for, so this verifies as a <b>historical fact</b> and is
      worthless as authorization — which is exactly why it is safe to publish.
    </p>

    <div class="divider"></div>

    <!-- Selective disclosure, shown rather than asserted. -->
    <div class="mut" style="margin-bottom:6px">
      The verifier received {disc.disclosedCount} of {disc.totalSdClaims} attributes this credential holds:
    </div>
    <div class="row" style="gap:6px">
      {#each disc.disclosed as c}
        <span class="chip-claim claim-disclosed">{c.name}: {fmt(c.value)}</span>
      {/each}
    </div>
    {#if disc.withheldCount > 0}
      <div class="mut" style="margin:10px 0 6px">
        {disc.withheldCount} withheld — present in the signed credential only as salted hashes,
        not recoverable by the merchant or by you:
      </div>
      <div class="row" style="gap:6px">
        {#each Array.from({ length: disc.withheldCount }) as _}
          <span class="chip-claim claim-withheld">undisclosed</span>
        {/each}
      </div>
    {/if}

    {#if exhibit.paymentApproved}
      <div class="divider"></div>
      <div class="mut" style="margin-bottom:6px">
        The payment this human approved on Proof's own screen, sealed into the key-binding JWT:
      </div>
      <div class="kv">
        <span class="k">Amount</span>
        <span><b>{exhibit.paymentApproved.amount}</b> <span class="mut">{exhibit.paymentApproved.currency}</span></span>
        <span class="k">Payee</span><span>{exhibit.paymentApproved.payee?.name ?? "—"}</span>
        <span class="k">Prompt</span><span>{exhibit.paymentApproved.prompt_summary ?? "—"}</span>
        <span class="k">Instrument</span>
        <span class="mono" style="word-break:break-all">{exhibit.paymentApproved.payment_instrument?.id ?? "—"}</span>
      </div>
      <p class="note" style="margin:8px 0 0">
        Settlement quotes USDC ({usd(exhibit.payment?.amount)}); Proof's mandate records the
        fiat-denominated figure the human was shown.
      </p>
    {/if}

    <div class="divider"></div>

    <div class="kv">
      <span class="k">Issuer</span><span class="mono">{cred.issuer ?? "—"}</span>
      <span class="k">Signed by</span><span class="mono">{cred.issuerCert?.subject?.replace(/\n/g, " ") ?? "—"}</span>
      {#if cred.issuerCert?.trustAnchor}
        <span class="k">Chain pinned to</span><span>{cred.issuerCert.trustAnchor}</span>
      {/if}
      <span class="k">Type</span><span class="mono" style="word-break:break-all">{cred.vct ?? "—"}</span>
      <span class="k">Presented</span><span>{new Date(exhibit.capturedAt).toLocaleString()}</span>
      <span class="k">Expires</span>
      <span>{cred.expiresAt ? new Date(cred.expiresAt).toLocaleString() : "no expiry claim"}</span>
      <span class="k">Revocable</span>
      <span>{cred.revocable ? "yes — carries a status list" : "no status list on the credential"}</span>
    </div>

    <details style="margin-top:12px">
      <summary class="mut" style="cursor:pointer;font-size:12px">
        Raw vp_token — verify it yourself rather than trusting this page
      </summary>
      <p class="note" style="margin:8px 0">
        Decode it and you will find the issuer JWT, one disclosure per revealed attribute,
        the salted hashes of the withheld ones, and the holder's key-binding JWT over the
        recorded nonce.
      </p>
      <textarea class="mono" readonly rows="6" style="width:100%;font-size:10.5px"
        >{exhibit.vpToken}</textarea>
      {#if exhibit.transactionData}
        <p class="note" style="margin:10px 0 4px">
          And the <span class="mono">transaction_data</span> whose digest was sealed into the
          challenge — hash it yourself rather than taking the “payment bound” badge on faith:
        </p>
        <textarea class="mono" readonly rows="3" style="width:100%;font-size:10.5px"
          >{exhibit.transactionData}</textarea>
      {/if}
    </details>
  </div>
{/if}
