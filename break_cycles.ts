// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write break_cycles.ts
// Greedy feedback arc set: sort all edges by (confidence asc, broader-before-prereq).
// Process in that order; if adding edge would create a cycle, drop it.
// Cycle check via incremental topological ordering (per inverted-index).
// Uses DFS from target to source — O(edges * avg-path), acceptable for 188k edges.

type Edge = { from: string; to: string; source: string; type: string; conf: number; raw: string; idx: number };

const edges: Edge[] = [];
{
  const txt = await Deno.readTextFile("prereqs.tsv");
  let first = true; let i = 0;
  for (const line of txt.split("\n")) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const [skill_id, prereq_id, source, type, confidence] = line.split("\t");
    edges.push({
      from: prereq_id, to: skill_id, source, type,
      conf: Number(confidence) || 0, raw: line, idx: i++,
    });
  }
}
console.log(`loaded ${edges.length} edges`);

// Process high-confidence edges FIRST; keep them if acyclic. This means we sort DESCENDING
// by confidence. When we encounter a would-cycle edge it gets dropped (it's lower conf).
const typeRank = (t: string) => t === "prerequisite" ? 0 : 1; // prefer prerequisite
edges.sort((a, b) => {
  if (a.conf !== b.conf) return b.conf - a.conf;
  return typeRank(a.type) - typeRank(b.type);
});

const out = new Map<string, string[]>(); // kept adjacency
const kept: Edge[] = [];
const dropped: Edge[] = [];

// DFS: is there a path from `to` back to `from`? if yes, adding from->to creates a cycle
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
  // Would this edge create a cycle? A cycle exists iff there's already a path to -> ... -> from
  if (reachable(e.to, e.from)) {
    dropped.push(e);
    continue;
  }
  (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  kept.push(e);
}

console.log(`\ntotal kept: ${kept.length}, dropped: ${dropped.length}`);
const bySource = new Map<string, number>();
for (const e of dropped) {
  const k = `${e.source}/${e.type}`;
  bySource.set(k, (bySource.get(k) ?? 0) + 1);
}
for (const [k, c] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.toString().padStart(6)}  ${k}`);
}

// Rewrite prereqs.tsv preserving original order
const keptSet = new Set(kept.map(e => e.idx));
const header = "skill_id\tprereq_id\tsource\ttype\tconfidence";
const keptLines: string[] = [header];
const dropLines: string[] = [header];
const all = [...edges].sort((a, b) => a.idx - b.idx);
for (const e of all) {
  if (keptSet.has(e.idx)) keptLines.push(e.raw);
  else dropLines.push(e.raw);
}
await Deno.writeTextFile("prereqs.tsv", keptLines.join("\n") + "\n");
await Deno.writeTextFile("prereqs_dropped.tsv", dropLines.join("\n") + "\n");
console.log(`\nwrote prereqs.tsv (${kept.length}) and prereqs_dropped.tsv (${dropped.length})`);
