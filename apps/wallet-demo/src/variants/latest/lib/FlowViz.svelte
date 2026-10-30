<script lang="ts">
  /**
   * The step rail. Same markup either way — `layout` only switches which axis
   * the dots and connector run along, so the vertical column rail and the
   * full-width horizontal stepper stay one component. "horizontal" applies at
   * desktop widths only; once the page stacks to one column it reverts to the
   * vertical rail, which is the readable shape in a narrow viewport.
   */
  type Step = { title: string; sub?: string; status: "todo" | "active" | "done" | "bad" };
  let { steps, layout = "vertical" }: { steps: Step[]; layout?: "vertical" | "horizontal" } =
    $props();
</script>

<div class="flow {layout}">
  {#each steps as s, i}
    <div class="fstep {s.status}">
      <div class="dotcol">
        <div class="dot"></div>
        {#if i < steps.length - 1}<div class="line"></div>{/if}
      </div>
      <div class="body">
        <div class="title">
          {s.title}
          {#if s.status === "done"}<span class="badge b-ok" style="margin-left:6px">✓</span>{/if}
          {#if s.status === "bad"}<span class="badge b-bad" style="margin-left:6px">✗</span>{/if}
        </div>
        {#if s.sub}<div class="sub">{s.sub}</div>{/if}
      </div>
    </div>
  {/each}
</div>
