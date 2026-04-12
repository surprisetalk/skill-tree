// deno run --v8-flags=--max-old-space-size=8192 --allow-read cycle_audit.ts
// Tarjan SCC over prereqs.tsv. Reports edges inside non-trivial SCCs by source/type.

type Edge = { from: string; to: string; source: string; type: string; conf: string };

const ids = new Set<string>();
{
  const txt = await Deno.readTextFile("skills.tsv");
  let first = true;
  for (const line of txt.split("\n")) {
    if (first) { first = false; continue; }
    const i = line.indexOf("\t");
    if (i > 0) ids.add(line.slice(0, i));
  }
}

const edges: Edge[] = [];
const out = new Map<string, number[]>();
{
  const txt = await Deno.readTextFile("prereqs.tsv");
  let first = true;
  for (const line of txt.split("\n")) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const [skill_id, prereq_id, source, type, conf] = line.split("\t");
    if (!ids.has(skill_id) || !ids.has(prereq_id)) continue;
    // Edge direction: prereq_id -> skill_id (prereq leads to skill)
    const idx = edges.length;
    edges.push({ from: prereq_id, to: skill_id, source, type, conf });
    (out.get(prereq_id) ?? out.set(prereq_id, []).get(prereq_id)!).push(idx);
  }
}
console.log(`loaded ${edges.length} edges`);

// Iterative Tarjan
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
      const e = edges[f.children[f.i++]];
      const w = e.to;
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
          sccOf.set(u, sccId);
          size++;
          if (u === f.v) break;
        }
        sccSize.push(size);
        sccId++;
      }
    }
  }
}

// Count nodes in non-trivial SCCs (size > 1); also self-loops become their own SCC of size 1 but self-edge in cycle
let cycleNodes = 0;
for (const s of sccSize) if (s > 1) cycleNodes += s;
// self-loops
let selfLoops = 0;
for (const e of edges) if (e.from === e.to) selfLoops++;

console.log(`non-trivial SCCs:   ${sccSize.filter(s => s > 1).length}`);
console.log(`nodes in cycles:    ${cycleNodes}`);
console.log(`self-loops:         ${selfLoops}`);
console.log(`largest SCC size:   ${Math.max(...sccSize)}`);

// Edges inside same SCC
const cycleEdges: Edge[] = [];
for (const e of edges) {
  const a = sccOf.get(e.from); const b = sccOf.get(e.to);
  if (a !== undefined && a === b && (sccSize[a] > 1 || e.from === e.to)) {
    cycleEdges.push(e);
  }
}
console.log(`edges inside SCCs:  ${cycleEdges.length}`);

const bySourceType = new Map<string, number>();
for (const e of cycleEdges) {
  const k = `${e.source}\t${e.type}`;
  bySourceType.set(k, (bySourceType.get(k) ?? 0) + 1);
}
console.log("\ncycle edges by source/type:");
for (const [k, n] of [...bySourceType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(7)}  ${k}`);
}

// Sample a few small SCCs for human inspection
const label = new Map<string, string>();
{
  const txt = await Deno.readTextFile("skills.tsv");
  let first = true;
  for (const line of txt.split("\n")) {
    if (first) { first = false; continue; }
    const cells = line.split("\t");
    if (cells[0]) label.set(cells[0], cells[3] ?? "");
  }
}
const nontrivial = [...sccSize.entries()].filter(([, s]) => s > 1).sort((a, b) => a[1] - b[1]);
console.log("\nsample small SCCs:");
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
