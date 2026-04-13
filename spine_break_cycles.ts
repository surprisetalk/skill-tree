// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write spine_break_cycles.ts
// Greedy feedback arc set on spine_prereqs.tsv. High-confidence edges added first;
// later edges that would create a cycle are dropped. ESCO essential relations often
// cycle via occupation→skill→occupation paths — this prunes the weaker arc.

type Edge = { from: string; to: string; source: string; type: string; conf: number; raw: string; idx: number };

const SOURCE_CONFIDENCE: Record<string, number> = {
  khan: 1.0, alcpl: 1.0, metacademy: 1.0, opensalt: 1.0, asn: 1.0,
  esco: 1.0, csp_grade: 1.0,
  esco_optional: 0.9, junyi_hierarchy: 0.9, ngss_progression: 0.9, hess_progression: 0.9,
  junyi_logs: 0.8, assistments_logs: 0.8, mooccubex: 0.8, llm: 0.8,
  course_skill_atlas: 0.6, csa_distance: 0.6,
  lcsh_broader: 0.5, dbpedia_broader: 0.5, wikidata_p279: 0.7,
  semantic_bridge: 0.5,
};
const confOf = (s: string) => SOURCE_CONFIDENCE[s] ?? 0.5;

const edges: Edge[] = [];
{
  const txt = await Deno.readTextFile("spine_prereqs.tsv");
  let first = true; let i = 0;
  for (const line of txt.split("\n")) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const [skill_id, prereq_id, source, type, confidence] = line.split("\t");
    edges.push({
      from: prereq_id, to: skill_id, source, type,
      conf: Number(confidence) || confOf(source), raw: line, idx: i++,
    });
  }
}
console.log(`loaded ${edges.length} edges`);

const typeRank = (t: string) => t === "prerequisite" ? 0 : 1;
edges.sort((a, b) => {
  if (a.conf !== b.conf) return b.conf - a.conf;
  return typeRank(a.type) - typeRank(b.type);
});

const out = new Map<string, string[]>();
const kept: Edge[] = [];
const dropped: Edge[] = [];

function reachable(start: string, target: string): boolean {
  if (start === target) return true;
  const stack = [start];
  const seen = new Set<string>([start]);
  while (stack.length) {
    const v = stack.pop()!;
    const nxt = out.get(v);
    if (!nxt) continue;
    for (const w of nxt) {
      if (w === target) return true;
      if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
  }
  return false;
}

let n = 0;
for (const e of edges) {
  n++;
  if (n % 20000 === 0) console.log(`  processed ${n}, kept ${kept.length}, dropped ${dropped.length}`);
  if (e.from === e.to) { dropped.push(e); continue; }
  if (reachable(e.to, e.from)) { dropped.push(e); continue; }
  (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  kept.push(e);
}

console.log(`\nkept: ${kept.length}, dropped: ${dropped.length}`);
const bySource = new Map<string, number>();
for (const e of dropped) {
  const k = `${e.source}/${e.type}`;
  bySource.set(k, (bySource.get(k) ?? 0) + 1);
}
for (const [k, c] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.toString().padStart(6)}  ${k}`);
}

const keptSet = new Set(kept.map(e => e.idx));
const header = "skill_id\tprereq_id\tsource\ttype\tconfidence";
const keptLines: string[] = [header];
const all = [...edges].sort((a, b) => a.idx - b.idx);
for (const e of all) if (keptSet.has(e.idx)) keptLines.push(e.raw);
await Deno.writeTextFile("spine_prereqs.tsv", keptLines.join("\n") + "\n");
console.log(`\nwrote spine_prereqs.tsv (${kept.length} edges)`);
