// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write spine_bridge_orphans.ts
// For each spine skill with no prereq edges, find nearest connected spine skill
// via cosine. If cos >= threshold, emit a "broader" edge (orphan <- neighbor).
// Else drop the orphan from spine_skills.tsv.

const EMB_DIM = 384;
const BRIDGE_THRESHOLD = 0.65;

const sLines = (await Deno.readTextFile("spine_skills.tsv")).split("\n").filter(x => x);
const sHeader = sLines[0].split("\t");
const iId = sHeader.indexOf("id");
const rowsById = new Map<string, string[]>();
for (let i = 1; i < sLines.length; i++) {
  const r = sLines[i].split("\t");
  rowsById.set(r[iId], r);
}

const pLines = (await Deno.readTextFile("spine_prereqs.tsv")).split("\n").filter(x => x);
const pHeader = pLines[0];
const connected = new Set<string>();
const existing = new Set<string>();
for (let i = 1; i < pLines.length; i++) {
  const [a, b] = pLines[i].split("\t");
  connected.add(a); connected.add(b);
  existing.add(`${a}\t${b}`);
}

const embIds = (await Deno.readTextFile("embeddings_ids.tsv")).split("\n").slice(1).filter(x => x);
const idxOf = new Map<string, number>();
for (let i = 0; i < embIds.length; i++) idxOf.set(embIds[i], i);
const embBuf = await Deno.readFile("embeddings.bin");
// embeddings.bin starts with a 4-byte uint32 count header (main.ts writeEmbeddings).
const emb = new Float32Array(embBuf.buffer, embBuf.byteOffset + 4, (embBuf.byteLength - 4) / 4);
const vec = (row: number) => emb.subarray(row * EMB_DIM, (row + 1) * EMB_DIM);

type Cand = { id: string; row: number };
const connCands: Cand[] = [];
const orphans: Cand[] = [];
let noEmb = 0;
for (const [id] of rowsById) {
  const row = idxOf.get(id);
  if (row === undefined) { noEmb++; continue; }
  (connected.has(id) ? connCands : orphans).push({ id, row });
}
console.log(`orphans: ${orphans.length}, connected: ${connCands.length}, no emb: ${noEmb}`);

const connNorms = new Float32Array(connCands.length);
for (let i = 0; i < connCands.length; i++) {
  const v = vec(connCands[i].row);
  let s = 0; for (let k = 0; k < EMB_DIM; k++) s += v[k] * v[k];
  connNorms[i] = Math.sqrt(s) || 1;
}

const newEdges: string[] = [];
const dropIds = new Set<string>();
let bridged = 0;
for (const o of orphans) {
  const v = vec(o.row);
  let vn = 0; for (let k = 0; k < EMB_DIM; k++) vn += v[k] * v[k];
  vn = Math.sqrt(vn) || 1;
  let bestSim = -Infinity, bestIdx = -1;
  for (let i = 0; i < connCands.length; i++) {
    const g = vec(connCands[i].row);
    let dot = 0; for (let k = 0; k < EMB_DIM; k++) dot += v[k] * g[k];
    const sim = dot / (vn * connNorms[i]);
    if (sim > bestSim) { bestSim = sim; bestIdx = i; }
  }
  if (bestSim >= BRIDGE_THRESHOLD && bestIdx >= 0) {
    const nbr = connCands[bestIdx].id;
    const key = `${o.id}\t${nbr}`;
    if (!existing.has(key)) {
      newEdges.push(`${o.id}\t${nbr}\tsemantic_bridge\tbroader\t${bestSim.toFixed(3)}`);
      existing.add(key);
      bridged++;
    }
  } else {
    dropIds.add(o.id);
  }
}
// orphans with no embedding: drop
for (const [id] of rowsById) if (!idxOf.has(id) && !connected.has(id)) dropIds.add(id);

console.log(`bridged: ${bridged}`);
console.log(`dropped: ${dropIds.size}`);

const outSkills = [sHeader.join("\t")];
for (const [id, r] of rowsById) if (!dropIds.has(id)) outSkills.push(r.join("\t"));
await Deno.writeTextFile("spine_skills.tsv", outSkills.join("\n") + "\n");

const outEdges = [pHeader, ...pLines.slice(1), ...newEdges];
await Deno.writeTextFile("spine_prereqs.tsv", outEdges.join("\n") + "\n");

console.log(`spine_skills.tsv: ${outSkills.length - 1} skills`);
console.log(`spine_prereqs.tsv: ${outEdges.length - 1} edges`);
