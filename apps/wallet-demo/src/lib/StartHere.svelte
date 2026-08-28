<script lang="ts">
  /**
   * The on-ramp. Everything below this card speaks x401/x402/HAM on purpose —
   * that vocabulary is the point for the audience evaluating the protocol. This
   * card exists so nobody has to learn it before they can press a button, and so
   * the single most confusing thing on the page (a greyed-out "Proof wallet")
   * gets an answer where people actually look.
   */
  let { proofLiveReady, exhibitAvailable }: { proofLiveReady: boolean; exhibitAvailable: boolean } =
    $props();

  const LS = "x401demo.starthere.hidden";
  let hidden = $state(false);
  $effect(() => {
    try { hidden = localStorage.getItem(LS) === "1"; } catch {}
  });
  function setHidden(v: boolean) {
    hidden = v;
    try { localStorage.setItem(LS, v ? "1" : "0"); } catch {}
  }
</script>

{#if hidden}
  <button class="ghost reopen" onclick={() => setHidden(false)}>What is this? →</button>
{:else}
  <div class="card start">
    <h2>
      <span class="step">start</span>
      New here? This takes about a minute
      <button class="ghost hide" onclick={() => setHidden(true)}>Hide</button>
    </h2>

    <p class="note lead">
      An AI agent buys something on your behalf. The hard question isn't the payment — it's
      <b>who said the agent could spend, and how much</b>. That's what this demo makes visible.
      Testnet only: settlement is simulated and the agent's wallet is a throwaway key, so
      nothing here moves real money.
    </p>

    <div class="cols">
      <section>
        <h3>Try it</h3>
        <ol>
          <li>Create your credential — a digital ID, held in this browser.</li>
          <li>Pick something to buy and approve it. You choose exactly which personal details to reveal.</li>
          <li>Let the agent pay. Watch it get blocked if it tries to exceed what you approved.</li>
        </ol>
      </section>

      <section>
        <h3>What you're seeing</h3>
        <ul>
          <li>A payment cryptographically tied to <b>one specific human's approval</b> — not just "an agent had a key".</li>
          <li>That approval acting as a <b>cap</b>: a budget, a named merchant, an expiry. The agent cannot step outside it.</li>
          <li>Identity proven <b>without oversharing</b> — show you're over 18 without handing over your birthday.</li>
        </ul>
      </section>

      <section>
        <h3>About the “Proof wallet”</h3>
        <ul>
          <li>The credential you'll use is <b>minted in your browser</b>. The cryptography is real, but you're vouching for yourself.</li>
          {#if !proofLiveReady}
            <li>A <b>Proof wallet</b> means a third party vouches for you instead. That requires your own identity
              verification, so it's switched off here — nobody can hand you a verified identity.</li>
            {#if exhibitAvailable}
              <li>So instead, a <b>genuine Proof-issued credential</b> is displayed further down, re-verified
                on every page load — including a demonstration of why it can't be reused to buy anything.</li>
            {/if}
          {:else}
            <li>The <b>Proof wallet</b> option is live on this instance: a real third party vouches for you,
              and you approve the payment on Proof's own screen.</li>
          {/if}
        </ul>
      </section>
    </div>
  </div>
{/if}

<style>
  .start { margin-bottom: 16px; }
  .lead { font-size: 13px; line-height: 1.55; margin: 0 0 14px; }
  .hide { margin-left: auto; font-size: 11px; padding: 3px 10px; }
  .reopen { margin-bottom: 14px; font-size: 12px; }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 18px;
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--mut);
    margin: 0 0 8px;
  }
  ol, ul { margin: 0; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.5; margin-bottom: 7px; color: var(--ink); }
  li :global(b) { font-weight: 700; }
</style>
