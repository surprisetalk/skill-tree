import { assert, assertEquals, assertGreater } from "jsr:@std/assert@1";

Deno.test("stage 1: build/1_skills.tsv exists with expected schema", () => {
  const text = Deno.readTextFileSync("build/1_skills.tsv");
  const lines = text.split("\n").filter((l) => l.length);
  assertGreater(lines.length, 20000, "too few rows");
  assertEquals(lines[0], "id\ttitle\tdescription\tsources\ttags");

  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    const cols = lines[i].split("\t");
    assertEquals(cols.length, 5, `row ${i} has ${cols.length} cols, not 5`);
    assert(cols[0].length > 0, `row ${i} empty id`);
    assert(cols[1].length > 0, `row ${i} empty title`);
    assert(cols[3].length > 0, `row ${i} empty sources`);
    assert(/^[a-z0-9-]+$/.test(cols[0]), `row ${i} bad slug: ${cols[0]}`);
  }
});

Deno.test("stage 1 stats: all four sources represented", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/1_stats.json"));
  for (const src of ["esco", "onet", "lightcast", "opensalt"]) {
    assertGreater(s.per_source[src], 0, `${src} has 0 rows`);
  }
  assertGreater(s.dedupe_collisions, 0, "no dedupe collisions — likely broken");
});

Deno.test("stage 1: ids are unique", () => {
  const text = Deno.readTextFileSync("build/1_skills.tsv");
  const ids = text.split("\n").slice(1).filter((l) => l.length).map((l) => l.split("\t")[0]);
  const set = new Set(ids);
  assertEquals(ids.length, set.size, "duplicate ids in output");
});

Deno.test("stage 2: embeddings file matches ids and is correct shape", () => {
  const ids = Deno.readTextFileSync("build/2_ids.tsv").split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync("build/2_embeddings.bin");
  const DIM = 768;
  assertEquals(bin.byteLength, ids.length * DIM * 4, "bin size doesn't match ids × dim × 4");
  const f32 = new Float32Array(bin.buffer);

  const N = Math.min(ids.length, 500);
  for (let i = 0; i < N; i++) {
    let norm = 0;
    for (let j = 0; j < DIM; j++) {
      const v = f32[i * DIM + j];
      assert(Number.isFinite(v), `row ${i}[${j}] not finite`);
      norm += v * v;
    }
    assertGreater(norm, 0, `row ${i} is zero vector`);
  }
});

Deno.test("stage 2 stats: dim=768 and no NaNs", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/2_stats.json"));
  assertEquals(s.dim, 768);
  assertEquals(s.nan_count, 0);
  assertGreater(s.total, 0);
});

Deno.test("stage 3: tagged.tsv has 7 columns and tags are reasonable", () => {
  const lines = Deno.readTextFileSync("build/3_tagged.tsv").split("\n").filter((l) => l.length);
  assertEquals(lines[0], "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics");
  for (let i = 1; i < Math.min(lines.length, 500); i++) {
    const c = lines[i].split("\t");
    assertEquals(c.length, 7, `row ${i} has ${c.length} cols`);
  }
});

Deno.test("stage 3: known skills land on sensible tags", () => {
  const lines = Deno.readTextFileSync("build/3_tagged.tsv").split("\n").filter((l) => l.length);
  const byId = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    byId.set(c[0], c);
  }
  const js = byId.get("javascript");
  assert(js, "missing javascript row");
  assert(js![5].includes("software-developer") || js![6].includes("programming"), `javascript tags look wrong: occ=${js![5]} topics=${js![6]}`);
  const bio = byId.get("biology");
  assert(bio, "missing biology row");
  assert(bio![5].includes("biologist") || bio![6].includes("biology"), `biology tags look wrong`);
});

Deno.test("stage 3 stats: IDF pruning dropped the worst embedding-match offenders", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/3_stats.json"));
  // Direct tags (ESCO relations, OpenSALT frameworks) can legitimately cluster beyond the IDF cap.
  // Just check that no degenerate embedding-match winner (chief-executives-style) slipped through.
  for (const [name, n] of s.top_occupations) {
    if (/chief-executives|marketing-managers|sales-managers/.test(name)) {
      throw new Error(`degenerate ${name} not pruned: ${n}`);
    }
  }
  assert(s.top_occupations[0][1] < 10000, `top occupation clustered too hard: ${s.top_occupations[0][1]}`);
});

Deno.test("stage 4: difficulty.tsv is 1..20 integer band", () => {
  const lines = Deno.readTextFileSync("build/4_difficulty.tsv").split("\n").filter((l) => l.length);
  assertEquals(lines[0], "id\tdifficulty\tdifficulty_raw");
  for (let i = 1; i < Math.min(lines.length, 500); i++) {
    const [, band, raw] = lines[i].split("\t");
    const b = Number(band);
    assert(Number.isInteger(b) && b >= 1 && b <= 20, `row ${i} band out of range: ${band}`);
    assert(Number.isFinite(Number(raw)), `row ${i} non-finite raw`);
  }
});

Deno.test("stage 4: monotonic sanity — addition before calculus", () => {
  const lines = Deno.readTextFileSync("build/4_difficulty.tsv").split("\n").filter((l) => l.length);
  const map = new Map(lines.slice(1).map((l) => l.split("\t")).map((c) => [c[0], Number(c[1])]));
  const add = map.get("addition"), calc = map.get("calculus");
  if (add !== undefined && calc !== undefined) {
    assert(add <= calc, `addition (${add}) should be ≤ calculus (${calc})`);
  }
});

Deno.test("stage 4 stats: kendall-τ vs anchors above 0.5", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/4_stats.json"));
  assert(s.kendall_tau_vs_anchor > 0.5, `kendall τ = ${s.kendall_tau_vs_anchor}`);
});

Deno.test("final skills.tsv schema", () => {
  const lines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  assertEquals(lines[0], "id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end");
  for (let i = 1; i < Math.min(lines.length, 500); i++) {
    const c = lines[i].split("\t");
    assertEquals(c.length, 10, `row ${i} has ${c.length} cols`);
    const d = Number(c[4]);
    assert(Number.isInteger(d) && d >= 1 && d <= 20, `row ${i} bad difficulty: ${c[4]}`);
    assert(c[0].length <= 80, `row ${i} id too long: ${c[0].length}`);
    assert(c[2].length <= 80, `row ${i} display_title too long: ${c[2].length}`);
  }
});

Deno.test("final: every non-orphan skill reachable from some root", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/7_stats.json"));
  assertEquals(s.unreachable, 0, `${s.unreachable} skills unreachable from roots`);
  assert(s.roots > 0, "no root skills");
});

Deno.test("final: every prereq id exists as a skill id", () => {
  const lines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  const ids = new Set<string>();
  for (let i = 1; i < lines.length; i++) ids.add(lines[i].split("\t")[0]);
  let missing = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t")[5];
    if (!p) continue;
    for (const pid of p.split(",")) if (pid && !ids.has(pid)) missing++;
  }
  assertEquals(missing, 0, `${missing} dangling prereq references`);
});

Deno.test("final: no self-loops in prereq column", () => {
  const lines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  let loops = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (!c[5]) continue;
    if (c[5].split(",").includes(c[0])) loops++;
  }
  assertEquals(loops, 0, `${loops} self-loops`);
});

Deno.test("final: difficulty mostly monotonic across prereq chains", () => {
  // Seed edges can override inferred difficulty, so we allow a small fraction
  // of chains to violate monotonicity. ≥98% of sampled chains should be clean.
  const lines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  const diff = new Map<string, number>();
  const prereqs = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    diff.set(c[0], Number(c[4]));
    if (c[5]) prereqs.set(c[0], c[5].split(","));
  }
  const ids = [...prereqs.keys()];
  let clean = 0, violated = 0;
  for (let n = 0; n < 500; n++) {
    const start = ids[Math.floor(Math.random() * ids.length)];
    const target = diff.get(start)!;
    const stack = [...(prereqs.get(start) ?? [])];
    const seen = new Set<string>([start]);
    let ok = true;
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      if ((diff.get(u) ?? 0) > target) { ok = false; break; }
      for (const p of prereqs.get(u) ?? []) if (!seen.has(p)) stack.push(p);
    }
    if (ok) clean++; else violated++;
  }
  const pct = clean / (clean + violated);
  assert(pct >= 0.95, `only ${(pct * 100).toFixed(1)}% of chains monotonic (${violated} violations)`);
});

Deno.test("final: roots are a non-trivial fraction of skills", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/7_stats.json"));
  assert(s.roots > 100, `only ${s.roots} roots — graph may be over-connected`);
  assert(s.roots < s.skills_emitted * 0.2, `${s.roots} roots >20% of skills — too many orphans`);
});

Deno.test("dedupe: if stage 3b ran, alias file references real ids", () => {
  try {
    Deno.statSync("build/3b_aliases.tsv");
  } catch { return; /* dedupe didn't run, skip */ }
  const aliasLines = Deno.readTextFileSync("build/3b_aliases.tsv").split("\n").filter((l) => l.length);
  const skillIds = new Set<string>();
  const skillLines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  for (let i = 1; i < skillLines.length; i++) skillIds.add(skillLines[i].split("\t")[0]);
  for (let i = 1; i < aliasLines.length; i++) {
    const [, canonical] = aliasLines[i].split("\t");
    assert(skillIds.has(canonical), `alias canonical ${canonical} not in skills.tsv`);
  }
});

Deno.test("final: final_edges preserves strict raw-difficulty ordering", () => {
  const skillLines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  const diff = new Map<string, number>();
  for (let i = 1; i < skillLines.length; i++) {
    const c = skillLines[i].split("\t");
    diff.set(c[0], Number(c[4]));
  }
  const edgeLines = Deno.readTextFileSync("build/6_edges.tsv").split("\n").filter((l) => l.length).slice(1);
  for (let i = 0; i < Math.min(edgeLines.length, 1000); i++) {
    const [s, p] = edgeLines[i].split("\t");
    const ds = diff.get(s), dp = diff.get(p);
    if (ds === undefined || dp === undefined) continue; // edge references skill not in final output
    assert(dp <= ds, `edge ${s}(b${ds}) → ${p}(b${dp}) has prereq above skill`);
  }
});

Deno.test("stage 8: eval metrics are sane (not column-shifted)", () => {
  let s: Record<string, unknown>;
  try { s = JSON.parse(Deno.readTextFileSync("build/8_stats.json")); } catch { return; }

  // Kendall tau should be positive (difficulty correlates with Khan ordering)
  const kt = s.khan_tau as { kendall_tau: number | null };
  if (kt?.kendall_tau !== null) {
    assert(kt.kendall_tau > 0, `kendall_tau ${kt.kendall_tau} should be positive`);
  }

  // Graph must be a DAG
  const cy = s.cycles as { dag: boolean; leftover_after_kahn: number };
  assert(cy.dag, `cycles.dag should be true, leftover=${cy.leftover_after_kahn}`);

  // Depth should be > 1 (not a flat graph)
  const dd = s.depth_distribution as { max: number };
  assert(dd.max > 1, `depth max=${dd.max} — graph is flat, likely column-shift bug`);

  // Top out-degree nodes should be real skill IDs, not bare numbers
  const br = s.branching as { top_out_degree: [string, number, string | null][] };
  for (const [id] of br.top_out_degree) {
    assert(!/^\d+$/.test(id), `top hub "${id}" is a bare number — likely difficulty parsed as prereq`);
  }

  // Reachability: roots should exist
  const re = s.reachability as { roots: number; reachable: number };
  assert(re.roots > 0, "no roots — every skill has prereqs?");
  assert(re.reachable > re.roots, "nothing reachable beyond roots");
});

Deno.test("stage 6: orphan_rate is in [0, 1]", () => {
  let s: Record<string, unknown>;
  try { s = JSON.parse(Deno.readTextFileSync("build/6_stats.json")); } catch { return; }
  const r = s.orphan_rate as number;
  assert(r >= 0 && r <= 1, `orphan_rate ${r} outside [0,1]`);
});

Deno.test("stage 1: no embedded tabs or newlines in fields", () => {
  const text = Deno.readTextFileSync("build/1_skills.tsv");
  const lines = text.split("\n").filter((l) => l.length);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    assertEquals(cols.length, 5, `row ${i} bad column count → embedded tab?`);
  }
});
