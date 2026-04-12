// deno run --v8-flags=--max-old-space-size=8192 --allow-read validate.ts
// Integration check over skills.tsv + prereqs.tsv.
// Exits non-zero if dangling refs or cycles are found.

const SKILLS = "skills.tsv";
const PREREQS = "prereqs.tsv";

type Row = Record<string, string>;

async function* rows(path: string): AsyncGenerator<Row> {
  const file = await Deno.open(path);
  const reader = file.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream<string, string>({
      start() { (this as unknown as { buf: string }).buf = ""; },
      transform(chunk, ctrl) {
        const self = this as unknown as { buf: string };
        self.buf += chunk;
        const parts = self.buf.split("\n");
        self.buf = parts.pop() ?? "";
        for (const p of parts) ctrl.enqueue(p);
      },
      flush(ctrl) {
        const self = this as unknown as { buf: string };
        if (self.buf) ctrl.enqueue(self.buf);
      },
    }));
  let header: string[] | null = null;
  for await (const line of reader) {
    if (!line) continue;
    const cells = line.split("\t");
    if (!header) { header = cells; continue; }
    const row: Row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? "";
    yield row;
  }
}

function gradeBand(gs: string, ge: string): string {
  const s = gs === "" ? NaN : Number(gs);
  const e = ge === "" ? NaN : Number(ge);
  if (Number.isNaN(s) && Number.isNaN(e)) return "ungraded";
  const mid = Number.isNaN(s) ? e : Number.isNaN(e) ? s : (s + e) / 2;
  if (mid <= 5) return "K-5";
  if (mid <= 8) return "6-8";
  if (mid <= 12) return "9-12";
  return "post-12";
}

function sourceKind(source: string): "k12" | "pro" | "other" {
  const s = source.toLowerCase();
  if (/(khan|junyi|assistments|csp|opensalt|asn|ngss|hess|alcpl)/.test(s)) return "k12";
  if (/(esco|lightcast|onet)/.test(s)) return "pro";
  return "other";
}

const idToSource = new Map<string, string>();
const idToBand = new Map<string, string>();
const hasDesc = { yes: 0, no: 0 };
const sourceCounts = new Map<string, number>();
const bandCounts = new Map<string, number>();

console.log("scanning skills.tsv…");
for await (const r of rows(SKILLS)) {
  idToSource.set(r.id, r.source);
  const band = gradeBand(r.grade_start, r.grade_end);
  idToBand.set(r.id, band);
  bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1);
  sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
  if (r.description && r.description.trim()) hasDesc.yes++; else hasDesc.no++;
}
const totalSkills = idToSource.size;

console.log("scanning prereqs.tsv…");
const outEdges = new Map<string, string[]>();
const inDeg = new Map<string, number>();
const typeCounts = new Map<string, number>();
const edgeSourceCounts = new Map<string, number>();
let danglingSkill = 0;
let danglingPrereq = 0;
let crossBand = 0;
let k12ToProEdges = 0;
const nodesWithAnyEdge = new Set<string>();

for await (const r of rows(PREREQS)) {
  typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
  edgeSourceCounts.set(r.source, (edgeSourceCounts.get(r.source) ?? 0) + 1);
  const sOk = idToSource.has(r.skill_id);
  const pOk = idToSource.has(r.prereq_id);
  if (!sOk) danglingSkill++;
  if (!pOk) danglingPrereq++;
  if (!sOk || !pOk) continue;
  nodesWithAnyEdge.add(r.skill_id);
  nodesWithAnyEdge.add(r.prereq_id);
  (outEdges.get(r.prereq_id) ?? outEdges.set(r.prereq_id, []).get(r.prereq_id)!).push(r.skill_id);
  inDeg.set(r.skill_id, (inDeg.get(r.skill_id) ?? 0) + 1);
  const bs = idToBand.get(r.skill_id)!;
  const bp = idToBand.get(r.prereq_id)!;
  if (bs !== bp) crossBand++;
  const ks = sourceKind(idToSource.get(r.skill_id) ?? "");
  const kp = sourceKind(idToSource.get(r.prereq_id) ?? "");
  if ((ks === "pro" && kp === "k12") || (ks === "k12" && kp === "pro")) k12ToProEdges++;
}

// Kahn topo sort for cycle detection
console.log("cycle check…");
const indegWork = new Map<string, number>();
for (const [id] of idToSource) indegWork.set(id, inDeg.get(id) ?? 0);
const queue: string[] = [];
for (const [id, d] of indegWork) if (d === 0) queue.push(id);
let processed = 0;
while (queue.length) {
  const n = queue.pop()!;
  processed++;
  const outs = outEdges.get(n);
  if (!outs) continue;
  for (const m of outs) {
    const d = (indegWork.get(m) ?? 0) - 1;
    indegWork.set(m, d);
    if (d === 0) queue.push(m);
  }
}
const inCycles = totalSkills - processed;

// High fan-in/fan-out
let maxOut = 0, maxIn = 0;
let highOutCount = 0;
for (const [, outs] of outEdges) {
  if (outs.length > maxOut) maxOut = outs.length;
  if (outs.length > 100) highOutCount++;
}
for (const [, d] of inDeg) if (d > maxIn) maxIn = d;

const orphans = totalSkills - nodesWithAnyEdge.size;

console.log("\n=== skills ===");
console.log(`total:               ${totalSkills.toLocaleString()}`);
console.log(`with description:    ${hasDesc.yes.toLocaleString()} (${(100 * hasDesc.yes / totalSkills).toFixed(1)}%)`);
console.log(`orphans (no edge):   ${orphans.toLocaleString()} (${(100 * orphans / totalSkills).toFixed(1)}%)`);
console.log("\nby grade band:");
for (const [b, n] of [...bandCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${b.padEnd(10)} ${n.toLocaleString()}`);
}
console.log("\nby source (top 15):");
for (const [s, n] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${s.padEnd(25)} ${n.toLocaleString()}`);
}

console.log("\n=== prereqs ===");
let totalEdges = 0;
for (const [, n] of typeCounts) totalEdges += n;
console.log(`total edges:         ${totalEdges.toLocaleString()}`);
console.log("by type:");
for (const [t, n] of typeCounts) console.log(`  ${t.padEnd(15)} ${n.toLocaleString()}`);
console.log("by source:");
for (const [s, n] of [...edgeSourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(25)} ${n.toLocaleString()}`);
}
console.log(`dangling skill_id:   ${danglingSkill}`);
console.log(`dangling prereq_id:  ${danglingPrereq}`);
console.log(`cross-band edges:    ${crossBand.toLocaleString()}`);
console.log(`K12↔Pro edges:       ${k12ToProEdges.toLocaleString()}`);
console.log(`max out-degree:      ${maxOut}`);
console.log(`max in-degree:       ${maxIn}`);
console.log(`nodes with >100 out: ${highOutCount}`);
console.log(`nodes in cycles:     ${inCycles.toLocaleString()}`);

if (danglingSkill > 0 || danglingPrereq > 0 || inCycles > 0) {
  console.error("\nFAIL: dangling refs or cycles present");
  Deno.exit(1);
}
console.log("\nPASS");
