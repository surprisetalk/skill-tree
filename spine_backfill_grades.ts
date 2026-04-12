// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write spine_backfill_grades.ts
// For each ungraded skill in spine_skills.tsv with an embedding, find the nearest
// graded neighbor (cosine similarity) and copy its grade_start/grade_end.
// Writes spine_skills.tsv in place (overwriting).

const EMB_DIM = 384;
const COS_THRESHOLD = 0.40;

const skillsTxt = await Deno.readTextFile("spine_skills.tsv");
const lines = skillsTxt.split("\n").filter(x => x);
const header = lines[0].split("\t");
const iId = header.indexOf("id");
const iGs = header.indexOf("grade_start");
const iGe = header.indexOf("grade_end");

type Row = string[];
const rowsById = new Map<string, Row>();
for (let i = 1; i < lines.length; i++) {
  const r = lines[i].split("\t");
  rowsById.set(r[iId], r);
}
console.log(`${rowsById.size} spine skills`);

const embIds = (await Deno.readTextFile("embeddings_ids.tsv")).split("\n").slice(1).filter(x => x);
const idxOf = new Map<string, number>();
for (let i = 0; i < embIds.length; i++) idxOf.set(embIds[i], i);
const embBuf = await Deno.readFile("embeddings.bin");
const emb = new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4);

function vec(row: number): Float32Array {
  return emb.subarray(row * EMB_DIM, (row + 1) * EMB_DIM);
}

// Partition: graded (has gs or ge) vs ungraded; both must have embedding.
type Cand = { id: string; row: number; gs: string; ge: string };
const graded: Cand[] = [];
const ungraded: Cand[] = [];
let noEmb = 0;
for (const [id, r] of rowsById) {
  const row = idxOf.get(id);
  if (row === undefined) { noEmb++; continue; }
  const rec: Cand = { id, row, gs: r[iGs] ?? "", ge: r[iGe] ?? "" };
  if (rec.gs !== "" || rec.ge !== "") graded.push(rec);
  else ungraded.push(rec);
}
console.log(`graded: ${graded.length}, ungraded: ${ungraded.length}, no embedding: ${noEmb}`);

// Pre-normalize graded vectors.
const gradedNorms = new Float32Array(graded.length);
for (let i = 0; i < graded.length; i++) {
  const v = vec(graded[i].row);
  let s = 0;
  for (let k = 0; k < EMB_DIM; k++) s += v[k] * v[k];
  gradedNorms[i] = Math.sqrt(s) || 1;
}

let backfilled = 0, belowThresh = 0;
const simSum: number[] = [];

for (const u of ungraded) {
  const v = vec(u.row);
  let vn = 0;
  for (let k = 0; k < EMB_DIM; k++) vn += v[k] * v[k];
  vn = Math.sqrt(vn) || 1;

  let bestSim = -Infinity, bestIdx = -1;
  for (let i = 0; i < graded.length; i++) {
    const g = vec(graded[i].row);
    let dot = 0;
    for (let k = 0; k < EMB_DIM; k++) dot += v[k] * g[k];
    const sim = dot / (vn * gradedNorms[i]);
    if (sim > bestSim) { bestSim = sim; bestIdx = i; }
  }
  simSum.push(bestSim);
  if (bestSim < COS_THRESHOLD) { belowThresh++; continue; }
  const src = graded[bestIdx];
  const r = rowsById.get(u.id)!;
  r[iGs] = src.gs;
  r[iGe] = src.ge;
  backfilled++;
}

console.log(`backfilled: ${backfilled}`);
console.log(`below threshold (${COS_THRESHOLD}): ${belowThresh}`);
simSum.sort((a, b) => a - b);
const median = simSum[Math.floor(simSum.length / 2)];
console.log(`median best-sim: ${median?.toFixed(3)}`);

const out = [header.join("\t")];
for (const [, r] of rowsById) out.push(r.join("\t"));
await Deno.writeTextFile("spine_skills.tsv", out.join("\n") + "\n");

function band(gs: string, ge: string): string {
  const s = gs === "" ? NaN : +gs, e = ge === "" ? NaN : +ge;
  if (isNaN(s) && isNaN(e)) return "ungraded";
  const m = isNaN(s) ? e : isNaN(e) ? s : (s + e) / 2;
  if (m <= 5) return "K-5";
  if (m <= 8) return "6-8";
  if (m <= 12) return "9-12";
  return "post-12";
}
const bandCounts = new Map<string, number>();
for (const [, r] of rowsById) {
  const b = band(r[iGs] ?? "", r[iGe] ?? "");
  bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
}
console.log("\npost-backfill grade bands:");
for (const [b, n] of [...bandCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${b.padEnd(10)} ${n.toLocaleString()}`);
}
