<script lang="ts">
  /**
   * The merchant's order ledger, split out of MerchantPanel so it can sit in the
   * LEFT column under Activity.
   *
   * Two reasons, one editorial and one structural. Editorially it belongs next to
   * Activity: both answer "what just happened", where the right column answers
   * "what was proven". Structurally the right column is the taller of the two at
   * every step of the flow, and moving this card is what stops the left column
   * ending in a large void on first load.
   *
   * Note this table is the merchant's GLOBAL ledger — every visitor's orders, not
   * just yours — which is why Reset deliberately leaves it alone.
   */
  import { usd, short } from "./api";
  let { orders }: { orders: any[] } = $props();

  const stateClass = (s: string) =>
    s === "SETTLED" ? "b-ok" : s === "FAILED" || s === "EXPIRED" ? "b-bad" : "b-warn";
</script>

<div class="card">
  <h2>Mock-VeryGood-RX merchant · live orders</h2>
  <table>
    <thead><tr><th>Order</th><th>Item</th><th>USDC</th><th>State</th><th>Tx</th></tr></thead>
    <tbody>
      {#if orders?.length}
        {#each orders as o}
          <tr>
            <td class="mono">{(o.id ?? "").replace("ord_0x", "0x").slice(0, 10)}…</td>
            <td>{o.sku}</td>
            <td>{usd(o.amount)}</td>
            <td><span class="badge {stateClass(o.state)}">{o.state}</span></td>
            <td class="mono">{short(o.txHash)}</td>
          </tr>
        {/each}
      {:else}
        <tr><td colspan="5" class="mut">No orders yet.</td></tr>
      {/if}
    </tbody>
  </table>
</div>
