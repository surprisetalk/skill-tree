// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write --allow-run pipeline.ts
// Post-main.ts pipeline. Applies graph-quality passes in order:
//   1. dedup_standards   — collapse cross-jurisdiction duplicates via embeddings
//   2. csp_hierarchy     — inject CSP parent skills + parent->child broader edges
//   3. semantic_bridges  — NN-bridge remaining orphans to non-orphan neighbors
//   4. csp_refine_grades — tighten CSP grade_start/grade_end from statementNotation
//   5. break_cycles      — greedy FAS, drops lowest-confidence cyclic edges
//   6. validate          — pass/fail report

const steps = [
  "dedup_standards.ts",
  "csp_hierarchy.ts",
  "semantic_bridges.ts",
  "csp_refine_grades.ts",
  "onet_hub_align.ts",
  "onet_hub_prereqs.ts",
  "break_cycles.ts",
  "split_edges.ts",
  "validate.ts",
];

for (const step of steps) {
  console.log(`\n===== ${step} =====`);
  const proc = new Deno.Command("deno", {
    args: ["run", "--v8-flags=--max-old-space-size=12288", "--allow-read", "--allow-write", "--allow-run", step],
    stdout: "inherit", stderr: "inherit",
  });
  const { success, code } = await proc.output();
  if (!success) {
    console.error(`FAILED: ${step} (exit ${code})`);
    Deno.exit(code);
  }
}
console.log("\npipeline complete");
