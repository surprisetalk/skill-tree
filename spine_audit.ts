// deno run --allow-read spine_audit.ts
// Tarjan SCC + confidence-weighted edge audit over spine_skills.tsv / spine_prereqs.tsv.
// Reports cycles and source-confidence distribution separately so low-confidence
// LLM/bridge edges can be inspected independently from high-confidence log/curated ones.

type Edge = { from: string; to: string; source: string; type: string };

const SOURCE_CONFIDENCE: Record<string, number> = {
  khan: 1.0, alcpl: 1.0, metacademy: 1.0, opensalt: 1.0, asn: 1.0,
  esco: 1.0, csp_grade: 1.0,
  esco_optional: 0.9, junyi_hierarchy: 0.9, ngss_progression: 0.9, hess_progression: 0.9,
  junyi_logs: 0.8, assistments_logs: 0.8, mooccubex: 0.8, llm: 0.8,
  course_skill_atlas: 0.6, csa_distance: 0.6,
  lcsh_broader: 0.5, dbpedia_broader: 0.5, wikidata_p279: 0.7,
};
const confOf = (src: string) => SOURCE_CONFIDENCE[src] ?? 0.5;

const SKILLS = "spine_skills.tsv";
const EDGES = "spine_prereqs.tsv";

const ids = new Set<string>();
const label = new Map<string, string>();
for (const line of (await Deno.readTextFile(SKILLS)).split("\n").slice(1)) {
  if (!line) continue;
  const c = line.split("\t");
  if (c[0]) { ids.add(c[0]); label.set(c[0], c[3] ?? ""); }
}

const edges: Edge[] = [];
const out = new Map<string, number[]>();
for (const line of (await Deno.readTextFile(EDGES)).split("\n").slice(1)) {
  if (!line) continue;
  const [skill_id, prereq_id, source, type] = line.split("\t");
  if (!ids.has(skill_id) || !ids.has(prereq_id)) continue;
  const idx = edges.length;
  edges.push({ from: prereq_id, to: skill_id, source, type });
  (out.get(prereq_id) ?? out.set(prereq_id, []).get(prereq_id)!).push(idx);
}
console.log(`skills: ${ids.size}  edges: ${edges.length}`);

const index = new Map<string, number>();
const low = new Map<string, number>();
const onStack = new Set<string>();
const stack: string[] = [];
let idx = 0;
const sccOf = new Map<string, number>();
let sccId = 0;
const sccSize: number[] = [];
type Frame = { v: string; i: number; children: number[] };
const work: Frame[] = [];

for (const [v] of out) {
  if (index.has(v)) continue;
  work.push({ v, i: 0, children: out.get(v) ?? [] });
  index.set(v, idx); low.set(v, idx); idx++;
  stack.push(v); onStack.add(v);
  while (work.length) {
    const f = work[work.length - 1];
    if (f.i < f.children.length) {
      const w = edges[f.children[f.i++]].to;
      if (!index.has(w)) {
        index.set(w, idx); low.set(w, idx); idx++;
        stack.push(w); onStack.add(w);
        work.push({ v: w, i: 0, children: out.get(w) ?? [] });
      } else if (onStack.has(w)) {
        low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
      }
    } else {
      work.pop();
      if (work.length) {
        const p = work[work.length - 1];
        low.set(p.v, Math.min(low.get(p.v)!, low.get(f.v)!));
      }
      if (low.get(f.v) === index.get(f.v)) {
        let size = 0;
        while (true) {
          const u = stack.pop()!;
          onStack.delete(u);
          sccOf.set(u, sccId); size++;
          if (u === f.v) break;
        }
        sccSize.push(size);
        sccId++;
      }
    }
  }
}

let cycleNodes = 0;
for (const s of sccSize) if (s > 1) cycleNodes += s;
let selfLoops = 0;
for (const e of edges) if (e.from === e.to) selfLoops++;
const cycleEdges: Edge[] = [];
for (const e of edges) {
  const a = sccOf.get(e.from), b = sccOf.get(e.to);
  if (a !== undefined && a === b && (sccSize[a] > 1 || e.from === e.to)) cycleEdges.push(e);
}

console.log(`\n=== CYCLES ===`);
console.log(`non-trivial SCCs:   ${sccSize.filter(s => s > 1).length}`);
console.log(`nodes in cycles:    ${cycleNodes}`);
console.log(`self-loops:         ${selfLoops}`);
console.log(`largest SCC size:   ${sccSize.length ? Math.max(...sccSize) : 0}`);
console.log(`edges inside SCCs:  ${cycleEdges.length}`);
if (cycleEdges.length) {
  const bySource = new Map<string, number>();
  for (const e of cycleEdges) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  console.log(`cycle edges by source:`);
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(6)}  ${s.padEnd(20)} conf=${confOf(s).toFixed(2)}`);
  }
}

console.log(`\n=== CONFIDENCE BREAKDOWN ===`);
const bucket = new Map<string, number>();
const bySourceAll = new Map<string, number>();
for (const e of edges) {
  const c = confOf(e.source);
  const k = c >= 1.0 ? "1.0 (curated)"
          : c >= 0.9 ? "0.9 (strong)"
          : c >= 0.8 ? "0.8 (logs/LLM)"
          : c >= 0.7 ? "0.7 (wikidata)"
          : c >= 0.6 ? "0.6 (course-skill-atlas)"
          : "≤0.5 (taxonomy)";
  bucket.set(k, (bucket.get(k) ?? 0) + 1);
  bySourceAll.set(e.source, (bySourceAll.get(e.source) ?? 0) + 1);
}
for (const [k, n] of [...bucket.entries()].sort()) {
  const pct = ((100 * n) / edges.length).toFixed(1);
  console.log(`  ${k.padEnd(25)} ${n.toString().padStart(7)}  (${pct}%)`);
}
console.log(`\nby source:`);
for (const [s, n] of [...bySourceAll.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${n.toString().padStart(7)}  conf=${confOf(s).toFixed(2)}`);
}

console.log(`\n=== DANGLING / STRUCTURE ===`);
const withEdges = new Set<string>();
for (const e of edges) { withEdges.add(e.from); withEdges.add(e.to); }
const orphans = ids.size - withEdges.size;
console.log(`orphan nodes:       ${orphans}  (${(100 * orphans / ids.size).toFixed(1)}%)`);

if (cycleEdges.length) {
  const nontrivial = [...sccSize.entries()].filter(([, s]) => s > 1).sort((a, b) => a[1] - b[1]);
  console.log(`\nsample small SCCs:`);
  const members = new Map<number, string[]>();
  for (const [id, s] of sccOf) {
    if (sccSize[s] > 1 && sccSize[s] <= 4) (members.get(s) ?? members.set(s, []).get(s)!).push(id);
  }
  let shown = 0;
  for (const [scc, mem] of members) {
    if (shown >= 5) break;
    console.log(`  SCC #${scc} (size ${mem.length}):`);
    for (const m of mem) console.log(`    ${m}  "${label.get(m) ?? ""}"`);
    shown++;
  }
  console.log(`\ntotal non-trivial SCCs: ${nontrivial.length}`);
}
