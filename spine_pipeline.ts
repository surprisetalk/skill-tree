// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write --allow-run spine_pipeline.ts
// Rebuild spine end-to-end. Chains:
//   1. spine.ts                    — prune skills/edges to pedagogic sources
//   2. spine_bridge_orphans.ts     — NN bridge remaining orphans; drop unbridgeable
//   3. spine_backfill_grades.ts    — embedding-NN grade imputation
//   4. spine_college_grades.ts     — source-rule grade defaults
//   5. spine_taxonomy_link.ts      — shallow LCSH/DBpedia label match
//   6. spine_merge_wikidata.ts     — join P279 parents into spine
//   7. spine_taxonomy_deep_link.ts — embedding NN across taxonomy
//   8. spine_html.ts               — interactive viz

const steps = [
  "spine.ts",
  "spine_bridge_orphans.ts",
  "spine_backfill_grades.ts",
  "spine_college_grades.ts",
  "spine_taxonomy_link.ts",
  "spine_merge_wikidata.ts",
  "spine_taxonomy_deep_link.ts",
  "spine_break_cycles.ts",
  "spine_html.ts",
];

for (const step of steps) {
  console.log(`\n===== ${step} =====`);
  const proc = new Deno.Command("deno", {
    args: ["run", "--v8-flags=--max-old-space-size=12288", "--allow-read", "--allow-write", "--allow-run", step],
    stdout: "inherit", stderr: "inherit",
  });
  const { success, code } = await proc.output();
  if (!success) { console.error(`FAILED: ${step} (exit ${code})`); Deno.exit(code); }
}
console.log("\nspine pipeline complete");
