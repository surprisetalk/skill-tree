// deno run --allow-read --allow-write spine.ts
// Prune the 704k-skill graph to a ~5k pedagogic spine for flashcard generation.
// Keeps skills from intentionally pedagogic sources; drops CSP/OpenSALT/Lightcast mass.
// Keeps only true-prereq edges (drops broader/csp_grade/csp_parent/lcsh/dbpedia).

const SPINE_SOURCES = new Set([
  "khan", "metacademy", "alcpl", "mooccubex", "junyi", "assistments",
  "onet", "ngss", "asn", "fos",
]);

const SPINE_EDGE_SOURCES = new Set([
  "khan", "metacademy", "alcpl", "mooccubex",
  "junyi_logs", "junyi_hierarchy", "assistments_logs",
  "esco", "esco_optional", "ngss_progression", "opensalt", "llm",
]);

async function* rows(path: string): AsyncGenerator<string[]> {
  const f = await Deno.open(path);
  const dec = new TextDecoder();
  const buf = new Uint8Array(1 << 20);
  let leftover = "";
  while (true) {
    const n = await f.read(buf);
    if (!n) break;
    leftover += dec.decode(buf.subarray(0, n), { stream: true });
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";
    for (const l of lines) if (l) yield l.split("\t");
  }
  if (leftover) yield leftover.split("\t");
}

function band(gs: string, ge: string): string {
  const s = gs === "" ? NaN : +gs, e = ge === "" ? NaN : +ge;
  if (isNaN(s) && isNaN(e)) return "ungraded";
  const m = isNaN(s) ? e : isNaN(e) ? s : (s + e) / 2;
  if (m <= 5) return "K-5";
  if (m <= 8) return "6-8";
  if (m <= 12) return "9-12";
  return "post-12";
}

const keepIds = new Set<string>();
const skillLines: string[] = [];
let header: string[] | null = null;
const bandCounts = new Map<string, number>();
const sourceCounts = new Map<string, number>();

for await (const c of rows("skills.tsv")) {
  if (!header) { header = c; skillLines.push(c.join("\t")); continue; }
  const src = c[6] ?? "";
  if (!SPINE_SOURCES.has(src)) continue;
  keepIds.add(c[0]);
  skillLines.push(c.join("\t"));
  const b = band(c[7] ?? "", c[8] ?? "");
  bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
}

await Deno.writeTextFile("spine_skills.tsv", skillLines.join("\n") + "\n");

const edgeLines: string[] = [];
let edgeHeader: string[] | null = null;
const edgeTypeCounts = new Map<string, number>();
const edgeSrcCounts = new Map<string, number>();
const nodesWithEdges = new Set<string>();
let droppedOutOfSpine = 0, droppedWrongSource = 0;

for await (const c of rows("prereqs.tsv")) {
  if (!edgeHeader) { edgeHeader = c; edgeLines.push(c.join("\t")); continue; }
  if (!SPINE_EDGE_SOURCES.has(c[2])) { droppedWrongSource++; continue; }
  if (!keepIds.has(c[0]) || !keepIds.has(c[1])) { droppedOutOfSpine++; continue; }
  edgeLines.push(c.join("\t"));
  edgeTypeCounts.set(c[3], (edgeTypeCounts.get(c[3]) ?? 0) + 1);
  edgeSrcCounts.set(c[2], (edgeSrcCounts.get(c[2]) ?? 0) + 1);
  nodesWithEdges.add(c[0]);
  nodesWithEdges.add(c[1]);
}

await Deno.writeTextFile("spine_prereqs.tsv", edgeLines.join("\n") + "\n");

const orphans = keepIds.size - nodesWithEdges.size;
console.log(`spine_skills.tsv: ${keepIds.size.toLocaleString()} skills`);
console.log(`spine_prereqs.tsv: ${(edgeLines.length - 1).toLocaleString()} edges`);
console.log(`orphans: ${orphans.toLocaleString()} (${(100 * orphans / keepIds.size).toFixed(1)}%)`);
console.log(`\ndropped edges (wrong source): ${droppedWrongSource.toLocaleString()}`);
console.log(`dropped edges (endpoint not in spine): ${droppedOutOfSpine.toLocaleString()}`);

console.log("\nskills by source:");
for (const [s, n] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(15)} ${n.toLocaleString()}`);
}
console.log("\nskills by grade band:");
for (const [b, n] of [...bandCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${b.padEnd(10)} ${n.toLocaleString()}`);
}
console.log("\nedges by source:");
for (const [s, n] of [...edgeSrcCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${n.toLocaleString()}`);
}
console.log("\nedges by type:");
for (const [t, n] of edgeTypeCounts) console.log(`  ${t.padEnd(15)} ${n.toLocaleString()}`);
