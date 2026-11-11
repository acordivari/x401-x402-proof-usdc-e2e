<script lang="ts">
  /** What this variant changes relative to July, in six lines. Collapsible, remembered per browser. */
  const LS = "x401v1.whatsnew.hidden";
  let hidden = $state(false);
  $effect(() => { try { hidden = localStorage.getItem(LS) === "1"; } catch {} });
  const set = (v: boolean) => { hidden = v; try { localStorage.setItem(LS, v ? "1" : "0"); } catch {} };
</script>

{#if hidden}
  <button class="ghost" style="font-size:12px;margin-top:14px" onclick={() => set(false)}>What changed since July? →</button>
{:else}
  <div class="card news">
    <h2><span class="step" style="background:var(--acc2)">new</span> What changed since the July build
      <button class="ghost" style="margin-left:auto;font-size:11px;padding:3px 10px" onclick={() => set(true)}>Hide</button>
    </h2>
    <div class="grid6">
      <section><h3>The merchant asks</h3><p>The store itself answers <span class="mono">401</span> with a signed request, identified by a metadata document it hosts. No OAuth app, no client secret.</p></section>
      <section><h3>Proof's Cloud Wallet</h3><p>The request is handed to the person's Proof wallet, which posts the presentation back. Proof launched it Oct 15.</p></section>
      <section><h3>Terms, not just identity</h3><p>The exact basket is signed into the presentation. A standing grant uses Proof's payment-mandate template.</p></section>
      <section><h3>Identity paid with x402</h3><p>The presentation arrives with its signatures removed, and the merchant buys them back from Proof over x402.</p></section>
      <section><h3>Delegate Authority</h3><p>Your credential's key signs the agent's mandate. Proof's version of this is in early access, so this demo runs a stand-in for it.</p></section>
      <section><h3>One 401, one 402</h3><p>The agent proves, exchanges the proof for a token, then pays. x401 and x402 stay separate protocols.</p></section>
    </div>
  </div>
{/if}

<style>
  .news { margin-top: 14px; }
  .grid6 { display: grid; grid-template-columns: 1fr; gap: 14px; }
  @media (min-width: 640px) { .grid6 { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 1001px) { .grid6 { grid-template-columns: repeat(3, 1fr); } }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--mut); margin: 0 0 5px; }
  p { margin: 0; font-size: 12.5px; line-height: 1.5; }
</style>
