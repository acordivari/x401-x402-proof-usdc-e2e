<script lang="ts">
  /**
   * The Proof tab, when this deployment has no live Proof credentials.
   *
   * Previously that tab was a greyed-out dead control, which reads as "broken"
   * — and the demo's most valuable artifact sat in a sidebar card below the
   * fold. This walks the REAL recorded presentation step by step instead, then
   * stops where it must.
   *
   * Steps 1-4 are facts re-derived from the recording on every page load. Step 5
   * is the point: a recorded presentation is welded to a single-use nonce, so it
   * verifies as a historical fact and is worthless as authorization. Nothing
   * here touches the mandate-issuing path — see the route comment in
   * server/index.ts.
   */
  import { usd } from "./api";

  let { exhibit }: { exhibit: any } = $props();

  const cred = $derived(exhibit?.credential ?? {});
  const disc = $derived(exhibit?.disclosure ?? { disclosed: [], withheldCount: 0, totalSdClaims: 0 });
  const rec = $derived(exhibit?.liveVerification?.asRecorded);
  const replay = $derived(exhibit?.liveVerification?.asReplayed);
  const approved = $derived(exhibit?.paymentApproved);
  const scoped = $derived(exhibit?.scopedTo);
  const offline = $derived(exhibit?.offlineVerify);

  /** Claim values are not always scalars — Proof returns age as {"18": true}. */
  const fmt = (v: unknown): string =>
    v === null || v === undefined
      ? "—"
      : typeof v === "object"
        ? Object.entries(v as Record<string, unknown>)
            .map(([k, val]) => `${k}+ ${val ? "✓" : "✗"}`)
            .join(", ")
        : String(v);

  const cn = (dn?: string): string | undefined =>
    dn?.split("\n").find((p) => p.startsWith("CN="))?.slice(3);

  const clip = (s?: string, n = 44): string => (!s ? "—" : s.length <= n ? s : s.slice(0, n) + "…");
  const when = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : "—");
</script>

<div class="card fade-in" style="border-color:rgba(47,210,160,.45)">
  <h2>
    <span class="step" style="background:var(--ok)">real</span>
    A real Proof credential, end to end
    <span class="badge b-mut" style="margin-left:auto">recorded · re-verified live</span>
  </h2>

  <p class="note" style="margin:0 0 14px">
    Everywhere else you mint your own credential — real cryptography, but you're vouching for
    yourself. <b>Proof</b> issued this one to a real person who completed identity verification,
    presented once against a payment. Re-checked by this server on every page load.
  </p>

  <div class="steps">
    <div class="wstep">
      <span class="n">1</span>
      <div class="b">
        <div class="t">Proof issued the credential <span class="badge b-ok">real ✓</span></div>
        <div class="kv">
          <span class="k">Issuer</span><span class="mono">{cred.issuer ?? "—"}</span>
          <span class="k">Signing cert</span><span class="mono">{cn(cred.issuerCert?.subject) ?? "—"}</span>
          <span class="k">Type</span><span class="mono" style="word-break:break-all">{cred.vct ?? "—"}</span>
          <span class="k">Issued</span><span>{when(cred.issuedAt)}</span>
        </div>
        <p class="why">
          It carries {cred.expiresAt ? `an expiry of ${when(cred.expiresAt)}` : "no expiry claim"}
          and {cred.revocable ? "a status list, so it can be revoked upstream" : "no status list — so it cannot be revoked upstream"}.
          Stated plainly because it is the honest limitation of this sandbox credential.
        </p>
      </div>
    </div>

    <div class="wstep">
      <span class="n">2</span>
      <div class="b">
        <div class="t">The human approved a specific payment <span class="badge b-ok">real ✓</span></div>
        {#if approved}
          <div class="kv">
            <span class="k">Amount</span>
            <span><b>{approved.amount}</b> <span class="mut">{approved.currency}</span></span>
            <span class="k">Payee</span><span>{approved.payee?.name ?? "—"}</span>
            <span class="k">Shown as</span><span>{approved.prompt_summary ?? "—"}</span>
            <span class="k">Instrument</span>
            <span class="mono" style="word-break:break-all">{clip(approved.payment_instrument?.id, 34)}</span>
          </div>
        {/if}
        <p class="why">
          Approved on <b>Proof's own screen</b>, then sealed into the holder-signed key-binding
          JWT as <span class="mono">{exhibit.transactionDataType ?? "a payment mandate"}</span> —
          what makes this proof of <i>this</i> payment, not some payment. Settlement quotes USDC
          ({usd(exhibit.payment?.amount)}); the mandate records what the human actually saw.
        </p>
      </div>
    </div>

    <div class="wstep">
      <span class="n">3</span>
      <div class="b">
        <div class="t">
          Only {disc.disclosedCount} of {disc.totalSdClaims} attributes were revealed
          <span class="badge b-ok">real ✓</span>
        </div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          {#each disc.disclosed as c}
            <span class="chip-claim claim-disclosed">{c.name}: {fmt(c.value)}</span>
          {/each}
        </div>
        {#if disc.withheldCount > 0}
          <div class="row" style="gap:6px;margin-bottom:8px">
            {#each Array.from({ length: disc.withheldCount }) as _}
              <span class="chip-claim claim-withheld">undisclosed</span>
            {/each}
          </div>
        {/if}
        <p class="why">
          The withheld ones exist in the signed credential only as salted hashes. Not hidden by
          this page — <b>not recoverable</b>, by the merchant or by you. Their names aren't even
          knowable from the token, which is why they render unlabelled above.
        </p>
      </div>
    </div>

    <div class="wstep">
      <span class="n">4</span>
      <div class="b">
        <div class="t">Verified against the CA — offline <span class="badge b-ok">real ✓</span></div>
        <div class="row" style="gap:6px;margin-bottom:8px">
          <span class="badge {rec?.ok ? 'b-ok' : 'b-bad'}">chain {rec?.ok ? "trusted ✓" : "✗"}</span>
          <span class="badge {rec?.holderBound ? 'b-ok' : 'b-bad'}">holder bound</span>
          <span class="badge {rec?.nonceBound ? 'b-ok' : 'b-bad'}">nonce bound</span>
        </div>
        <div class="kv">
          {#if rec?.issuerCert?.trustAnchor}
            <span class="k">Pinned to</span><span>{rec.issuerCert.trustAnchor}</span>
          {/if}
          <span class="k">Checked</span><span>{when(exhibit.verifiedAt)}</span>
          {#if scoped}
            <span class="k">Asked by</span><span class="mono">{scoped.verifierId}</span>
            <span class="k">For</span>
            <span class="mono" style="word-break:break-all">{scoped.method} {scoped.resource}</span>
          {/if}
          {#if exhibit.proof?.scope}
            <span class="k">Scope</span>
            <span class="mono" style="word-break:break-all">{exhibit.proof.scope}</span>
          {/if}
        </div>
        <p class="why">
          {#if offline && !offline.proofSecretHeld}
            This server holds <b>no Proof credential</b> and made <b>no call to Proof</b> — the
            chain was checked against a trust store shipped in the package. That's the argument
            for a public CA: anyone can verify, forever, without the issuer's permission or
            telling it who's asking.
          {:else}
            The chain was checked against Proof's committed trust store rather than by calling
            an API — a verifier needs no relationship with the issuer.
          {/if}
        </p>
        <p class="why" style="margin-top:6px">
          Note what it was scoped to: one resource, one asker, one time. A credential
          presentation is not a bearer token.
        </p>
      </div>
    </div>
  </div>
</div>

<!-- The punchline gets its own frame. -->
<div class="card fade-in" style="border-color:var(--warn)">
  <h2>
    <span class="step" style="background:var(--warn)">5</span>
    Issue a mandate — stopped, by design
    <span class="badge b-bad" style="margin-left:auto">cannot proceed</span>
  </h2>

  <div class="kv" style="margin-bottom:10px">
    <span class="k">Against its own challenge</span>
    <span>
      {#if rec?.ok}<span class="badge b-ok">verified ✓</span>
      {:else}<span class="badge b-bad">failed ✗</span>{/if}
    </span>
    <span class="k">Against a fresh challenge</span>
    <span>
      {#if replay?.ok === false}
        <span class="badge b-bad">rejected ✗</span>
        <span class="mut" style="margin-left:6px;font-size:11.5px">{replay.violations?.join("; ")}</span>
      {:else}
        <span class="badge b-warn">unexpectedly accepted</span>
      {/if}
    </span>
    {#if scoped?.nonce}
      <span class="k">Welded to</span>
      <span class="mono" style="font-size:11px;word-break:break-all">{clip(scoped.nonce, 52)}</span>
    {/if}
  </div>

  <p class="note" style="margin:0 0 10px">
    That second line is the safety property, not a bug. Key-bound to the single-use challenge it
    was made for, this presentation verifies as a <b>historical fact</b> and is worthless as
    authorization — it can't pay for anything, here or anywhere, which is why it's safe to
    publish. Same replay gate that protects a live presentation.
  </p>

  <div class="gate">
    <b>To go past this step you need a live presentation — and that needs your own identity
    verification.</b>
    Nobody can hand you a verified human; that is the entire point of the layer. Switch to
    <b>Browser wallet</b> to run the full flow end to end on a credential you mint yourself,
    where the plumbing is identical and only the vouching is missing.
  </div>

  <p class="note" style="margin:10px 0 0;font-size:11px;opacity:.75">
    Operators: set <span class="mono">PROOF_CLIENT_ID</span> +
    <span class="mono">PROOF_CLIENT_SECRET</span> with <span class="mono">PROOF_MODE=live</span>
    to make this tab a real hosted presentation instead of a recording.
  </p>
</div>

<style>
  .steps { display: flex; flex-direction: column; gap: 16px; }
  .wstep { display: grid; grid-template-columns: 24px 1fr; gap: 11px; }
  .n {
    width: 22px; height: 22px; border-radius: 7px;
    display: grid; place-items: center;
    background: var(--ok); color: #05201a;
    font-size: 11.5px; font-weight: 800;
  }
  .t { font-weight: 700; font-size: 13px; margin-bottom: 7px; }
  .why { font-size: 11.5px; line-height: 1.55; color: var(--mut); margin: 8px 0 0; }
  .why :global(b) { color: var(--ink); font-weight: 700; }
  .gate {
    background: var(--chip);
    border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--mut);
  }
  .gate :global(b) { color: var(--ink); font-weight: 700; }
</style>
