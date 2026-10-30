<script lang="ts">
  /**
   * What the MERCHANT established before it let money move — read from the
   * receipt it returned, not from anything the orchestrator asserts. In the
   * latest flow the merchant is the verifier, so this is its own account.
   */
  import { TEMPLATE_LABEL, fmtClaim, leaves, short } from "./api";
  let { outcome, verifier }: { outcome: any; verifier: any } = $props();

  const auth = $derived(outcome?.receipt?.authorization ?? outcome?.token?.x401);
  const refused = $derived(outcome && !outcome.ok);
</script>

{#if outcome}
  <div class="card fade-in">
    <h2>Merchant · what was proven
      {#if refused}<span class="badge b-bad" style="margin-left:auto">refused</span>{:else}<span class="badge b-ok" style="margin-left:auto">settled</span>{/if}
    </h2>
    {#if refused}
      <div class="kv">
        {#if outcome.proofResult}<span class="k">PROOF-RESULT</span><span class="mono">{outcome.proofResult.error}</span>{/if}
        <span class="k">Why</span><span>{outcome.refusal ?? outcome.error ?? "—"}</span>
      </div>
      <p class="note" style="margin:8px 0 0">Refused before any payment was signed. x401 failures travel in <span class="mono">PROOF-RESULT</span>; the HTTP status describes only the response.</p>
    {:else if auth}
      <div class="row" style="gap:6px;margin-bottom:10px">
        <span class="badge b-ok">{auth.kind === "delegation" ? "delegation chain" : "presentation"} ✓</span>
        <span class="badge b-ok">nonce single-use ✓</span>
        <span class="badge b-ok">aud = our client_id ✓</span>
        {#if auth.terms}<span class="badge {auth.terms.every((t: any) => t.matches) ? 'b-ok' : 'b-bad'}">terms match ✓</span>{/if}
        {#if auth.agentId}<span class="badge b-ok">payer = bound agent ✓</span>{/if}
      </div>
      <div class="kv">
        <span class="k">Trust anchor</span><span>{auth.principal?.trustAnchor ?? verifier?.trustAnchor}</span>
        <span class="k">Credential</span><span class="mono" style="font-size:11.5px">{auth.principal?.vct}</span>
        <span class="k">Disclosed</span>
        <span>{#each leaves(auth.principal?.claims ?? {}) as [k, v]}<span class="chip-claim claim-disclosed" style="margin:2px">{k}: <b>{fmtClaim(v)}</b></span>{/each}</span>
        {#if auth.terms}
          <span class="k">Signed terms</span>
          <span>{#each auth.terms as t}<span class="badge {t.matches ? 'b-ok' : 'b-bad'}" style="margin:2px">{TEMPLATE_LABEL[t.type] ?? t.claim} {t.matches ? "✓" : "✗"}</span>{/each}</span>
        {/if}
        {#if auth.agentId}<span class="k">Agent</span><span class="mono" title={auth.agentId}>{short(auth.agentId, 18, 6)}</span>{/if}
        {#if auth.mandateId}<span class="k">Mandate</span><span class="mono">{short(auth.mandateId, 8, 6)}</span>{/if}
        <span class="k">Proof carried as</span><span>{auth.via === "verification-token" ? "Verification Token (token exchange)" : "Result Artifact"}</span>
      </div>
      {#if auth.detachedSignatures}
        <div class="divider"></div>
        <div class="note">
          <b style="color:var(--ink)">Paid for with x402.</b> The presentation arrived with its signatures detached; the merchant fetched them from
          {verifier?.signaturePrice?.emulated ? "the emulated" : ""} Proof's x401 Signatures endpoint and paid
          {#each auth.signaturePayments ?? [] as p}<span class="mono"> {verifier?.signaturePrice ? `$${verifier.signaturePrice.usd}` : ""} USDC · tx {short(p.transaction, 10, 6)}</span>{/each}
          before it could verify anything.
        </div>
      {/if}
    {/if}
  </div>
{/if}
