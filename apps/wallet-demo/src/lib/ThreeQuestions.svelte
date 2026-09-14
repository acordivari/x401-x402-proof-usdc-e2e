<script lang="ts">
  /**
   * The thesis of the demo, stated before anyone presses a button.
   *
   * Every business interaction with a person on the internet answers the same
   * three questions. An agentic payment has to answer them too — and the third
   * one is the one today's rails skip: x402 moves money but is identity-agnostic,
   * and AP2 defines the mandate chain while leaving *how human identity is
   * captured and bound* to integrators (docs/HAM-PROTOCOL.md).
   *
   * Wherever a real recorded Proof presentation is deployed, each column shows
   * the ACTUAL answer taken from it rather than describing one. Without a
   * recording the columns still stand; they just describe instead of prove.
   */
  import { usd } from "./api";

  let { exhibit }: { exhibit: any } = $props();

  const have = $derived(exhibit?.available === true);
  const disc = $derived(exhibit?.disclosure);
  const cert = $derived(exhibit?.credential?.issuerCert);
  const approved = $derived(exhibit?.paymentApproved);
  const offline = $derived(exhibit?.offlineVerify);

  /** Pull the CN out of an X.509 DN ("C=US\nO=Proof.com\nCN=…"). */
  const cn = (dn?: string): string | undefined =>
    dn
      ?.split("\n")
      .find((p) => p.startsWith("CN="))
      ?.slice(3);
</script>

<div class="card band">
  <div class="qs">
    <section>
      <h3>Who is this?</h3>
      <p>
        A person, identified by the attributes <b>they</b> chose to reveal — not by an
        account, a session, or a key.
      </p>
      {#if have}
        <div class="ev">
          <div class="row" style="gap:5px">
            {#each disc.disclosed as c}<span class="chip-claim claim-disclosed">{c.name}</span>{/each}
          </div>
        </div>
      {/if}
      <div class="sub mono">x401 presentation · SD-JWT-VC</div>
    </section>

    <section>
      <h3>Says who?</h3>
      <p>
        <b>Proof</b> — not the person vouching for themselves. The credential carries a
        certificate chain anyone can check independently.
      </p>
      {#if have && cert}
        <div class="ev">
          <div class="mono cert">{cn(cert.issuer) ?? cert.issuer}</div>
          {#if cert.trustAnchor}
            <div class="row" style="gap:6px;margin-top:5px">
              <span class="badge b-ok">chain verified ✓</span>
              <span class="mut tiny">{cert.trustAnchor}</span>
            </div>
          {/if}
          {#if offline && !offline.proofSecretHeld}
            <div class="tiny hi">
              Checked by this server just now — with <b>no call to Proof</b>, and no Proof
              credential on this machine. That is what a public CA is for.
            </div>
          {/if}
        </div>
      {/if}
      <div class="sub mono">x5c chain → committed trust store</div>
    </section>

    <section class="third">
      <h3>Did they authorize <i>this</i>?</h3>
      <p>
        The exact amount, to the exact payee, sealed inside what the human signed. Not
        “a payment” — <b>this</b> payment.
      </p>
      {#if have && approved}
        <div class="ev">
          <div class="amt">
            {approved.amount}
            <span class="mut">{approved.currency}</span>
            {#if approved.payee?.name}<span class="mut">→ {approved.payee.name}</span>{/if}
          </div>
          {#if approved.prompt_summary}
            <div class="tiny mut">“{approved.prompt_summary}”</div>
          {/if}
        </div>
      {/if}
      <div class="sub mono">transaction_data in the key-binding JWT</div>
      <p class="punch">
        This is the question the rails skip. <b>x402</b> moves money but is
        identity-agnostic. <b>AP2</b> defines the mandate chain and leaves identity
        binding to integrators. Answering it is what this project is for.
      </p>
    </section>
  </div>

  <div class="divider"></div>

  <div class="ledger">
    <section>
      <h3 class="ok">Real today</h3>
      <ul>
        {#if have}
          <li>A credential <b>Proof issued to a real person</b>, presented once and captured.</li>
          <li>
            A chain to Proof's CA — verified on this page load
            {#if offline && !offline.proofSecretHeld}<b>without contacting Proof</b>{/if}.
          </li>
          <li>
            Selective disclosure: <b>{disc.disclosedCount} of {disc.totalSdClaims}</b> attributes
            revealed, {disc.withheldCount} held back as salted hashes.
          </li>
          <li>
            A payment of <b>{usd(exhibit.payment?.amount)}</b> sealed into the presentation the
            human signed.
          </li>
        {:else}
          <li>The protocol plumbing — presentation, selective disclosure, payment binding, mandate.</li>
          <li>
            This deployment carries <b>no recorded Proof credential</b>, so the credential you
            use here is one you mint yourself.
          </li>
        {/if}
      </ul>
    </section>

    <section>
      <h3 class="warn">Doesn't exist yet</h3>
      <ul>
        <li>
          <b>A verifier that asks.</b> No merchant today requires which verified human approved a
          spend, or under what cap. Mock-VeryGood-RX here stands in for the verifier neither x402
          nor AP2 specifies — that is the dependency, and it is the interesting part.
        </li>
        <li>
          <b>An assurance level.</b> The credential says <i>who</i> vouched, not <i>how
          rigorously</i>. It carries no IAL/AAL claim — so you learn it was Proof, not what Proof
          checked.
        </li>
      </ul>
    </section>
  </div>
</div>

<style>
  .band { margin-bottom: 16px; }
  .qs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 20px;
  }
  .qs section { border-left: 2px solid var(--line); padding-left: 14px; }
  .qs .third { border-left-color: var(--acc2); }
  h3 { font-size: 15px; margin: 0 0 7px; font-weight: 800; }
  h3 i { color: var(--acc2); font-style: italic; }
  .qs p { font-size: 12.5px; line-height: 1.55; color: var(--mut); margin: 0 0 10px; }
  .qs p :global(b) { color: var(--ink); font-weight: 700; }
  .ev {
    background: var(--chip);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 9px;
    margin-bottom: 9px;
  }
  .cert { font-size: 11.5px; color: var(--ink); line-height: 1.4; }
  .amt { font-size: 15px; font-weight: 800; }
  .amt .mut { font-size: 12px; font-weight: 600; }
  .tiny { font-size: 11px; line-height: 1.45; }
  .hi { margin-top: 6px; color: var(--ok); }
  .hi :global(b) { color: var(--ok); }
  .sub { font-size: 11px; color: var(--mut); opacity: 0.8; }
  .punch {
    margin-top: 10px !important;
    padding-top: 9px;
    border-top: 1px dashed var(--line);
    font-size: 12px !important;
  }
  .ledger {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 18px;
  }
  .ledger h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.07em; }
  .ledger h3.ok { color: var(--ok); }
  .ledger h3.warn { color: var(--warn); }
  .ledger ul { margin: 0; padding-left: 17px; }
  .ledger li { font-size: 12px; line-height: 1.5; margin-bottom: 6px; color: var(--mut); }
  .ledger li :global(b) { color: var(--ink); font-weight: 700; }
</style>
