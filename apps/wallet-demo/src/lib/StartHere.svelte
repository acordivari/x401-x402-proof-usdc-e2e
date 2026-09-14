<script lang="ts">
  /**
   * The on-ramp. Everything below this card speaks x401/x402/HAM on purpose —
   * that vocabulary is the point for the audience evaluating the protocol. This
   * card exists so nobody has to learn it before they can press a button.
   *
   * It deliberately does NOT restate the value proposition — ThreeQuestions sits
   * directly above it and owns that. This card is the practical half: what to
   * press, and what to watch while you press it.
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
      Below, an AI agent buys something on your behalf and you decide what it's allowed to do.
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
        <h3>What to watch for</h3>
        <ul>
          <li>Choose which details to reveal — then watch the merchant's panel receive <b>only those</b>, and nothing else.</li>
          <li>The amount you approve is sealed into the presentation. Nothing downstream can change it afterwards.</li>
          <li>Push past your own budget, or revoke the mandate mid-run, and watch the merchant <b>refuse</b>.</li>
        </ul>
      </section>

      <section>
        <h3>About the “Proof wallet”</h3>
        <ul>
          <li>The credential you'll use is <b>minted in your browser</b>. The cryptography is real, but you're vouching for yourself.</li>
          {#if !proofLiveReady}
            {#if exhibitAvailable}
              <li>Open the <b>Proof wallet</b> tab to walk through a <b>genuine Proof-issued credential</b>
                instead — a real person, really verified, re-checked by this server on every page load.</li>
              <li>It stops one step short of paying, on purpose. A recorded approval can't authorize a new
                purchase, and seeing exactly why is the most useful thing on this page.</li>
            {:else}
              <li>A <b>Proof wallet</b> means a third party vouches for you instead. That requires your own identity
                verification, so it's switched off here — nobody can hand you a verified identity.</li>
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
