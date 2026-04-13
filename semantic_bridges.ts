// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write semantic_bridges.ts
// For each orphan skill with an embedding, find nearest non-orphan neighbor in a
// source-compatible pool. Emit a "broader" edge at cos >= 0.82.

const EMB_DIM = 384;
const COS_THRESHOLD = 0.82;

// candidate pool by orphan source
const POOLS: Record<string, Set<string>> = {
  lightcast:   new Set(["lightcast", "esco", "onet", "khan", "mooccubex", "metacademy"]),
  esco:        new Set(["lightcast", "esco", "onet", "khan", "mooccubex", "metacademy"]),
  onet:        new Set(["lightcast", "esco", "onet"]),
  csp:         new Set(["csp", "opensalt", "asn", "khan", "mooccubex"]),
  opensalt:    new Set(["opensalt", "csp", "asn", "khan", "mooccubex"]),
  khan:        new Set(["khan", "mooccubex", "alcpl", "metacademy", "junyi", "assistments"]),
  junyi:       new Set(["khan", "junyi", "alcpl", "mooccubex", "assistments"]),
  alcpl:       new Set(["khan", "alcpl", "metacademy", "mooccubex"]),
  metacademy:  new Set(["metacademy", "mooccubex", "khan", "alcpl"]),
  mooccubex:   new Set(["mooccubex", "metacademy", "khan", "alcpl"]),
  assistments: new Set(["khan", "assistments", "junyi"]),
  fos:         new Set(["fos", "onet", "esco"]),
};

console.log("loading skills.tsv…");
const skillsTxt = await Deno.readTextFile("skills.tsv");
const sLines = skillsTxt.split("\n");
const cols = sLines[0].split("\t");
const iId = cols.indexOf("id"), iSrc = cols.indexOf("source"), iGs = cols.indexOf("grade_start");
const srcOf = new Map<string, string>();
const gsOf  = new Map<string, string>();
for (let i = 1; i < sLines.length; i++) {
  if (!sLines[i]) continue;
  const r = sLines[i].split("\t");
  srcOf.set(r[iId], r[iSrc]);
  gsOf.set(r[iId], r[iGs]);
}
console.log(`  ${srcOf.size} skills`);

console.log("loading prereqs.tsv…");
const pText = await Deno.readTextFile("prereqs.tsv");
const pLines = pText.split("\n");
const connected = new Set<string>();
const existingEdges = new Set<string>();
for (let i = 1; i < pLines.length; i++) {
  if (!pLines[i]) continue;
  const [a, b] = pLines[i].split("\t");
  connected.add(a); connected.add(b);
  existingEdges.add(`${a}\t${b}`);
}
console.log(`  ${pLines.length - 1} edges, ${connected.size} connected skills`);

console.log("loading embeddings_ids.tsv…");
const embIds = (await Deno.readTextFile("embeddings_ids.tsv")).split("\n").slice(1).filter(x => x);
const idxOf = new Map<string, number>();
for (let i = 0; i < embIds.length; i++) idxOf.set(embIds[i], i);
console.log(`  ${embIds.length} embeddings`);

console.log("loading embeddings.bin…");
const embBuf = await Deno.readFile("embeddings.bin");
// embeddings.bin starts with a 4-byte uint32 count header (main.ts writeEmbeddings).
const emb = new Float32Array(embBuf.buffer, embBuf.byteOffset + 4, (embBuf.byteLength - 4) / 4);

// --- build candidate index: source -> array of (embedding_row_idx, id, grade)
type Cand = { row: number; id: string; grade: string };
const candBySrc = new Map<string, Cand[]>();
for (let i = 0; i < embIds.length; i++) {
  const id = embIds[i];
  const src = srcOf.get(id);
  if (!src) continue;
  if (!connected.has(id)) continue; // candidates must be non-orphan
  (candBySrc.get(src) ?? candBySrc.set(src, []).get(src)!).push({ row: i, id, grade: gsOf.get(id) ?? "" });
}
for (const [s, c] of candBySrc) console.log(`  candidates ${s}: ${c.length}`);

// --- collect orphans (must have embedding)
const orphans: Array<{ row: number; id: string; src: string; grade: string }> = [];
for (let i = 0; i < embIds.length; i++) {
  const id = embIds[i];
  if (connected.has(id)) continue;
  const src = srcOf.get(id);
  if (!src) continue;
  orphans.push({ row: i, id, src, grade: gsOf.get(id) ?? "" });
}
console.log(`\n${orphans.length} orphans with embeddings`);

function dot(a: number, b: number): number {
  const pa = a * EMB_DIM, pb = b * EMB_DIM;
  let d = 0;
  for (let i = 0; i < EMB_DIM; i++) d += emb[pa + i] * emb[pb + i];
  return d;
}

// --- for each orphan, scan allowed pool; keep best
const newEdges: string[] = [];
let matched = 0, attempted = 0, tooFar = 0, noPool = 0;
for (const o of orphans) {
  attempted++;
  if (attempted % 2000 === 0) console.log(`  processed ${attempted}/${orphans.length}, matched ${matched}`);
  const allowedSrc = POOLS[o.src];
  if (!allowedSrc) { noPool++; continue; }
  let best = -1; let bestCos = COS_THRESHOLD;
  for (const s of allowedSrc) {
    const pool = candBySrc.get(s);
    if (!pool) continue;
    for (const c of pool) {
      if (c.id === o.id) continue;
      const d = dot(o.row, c.row);
      if (d > bestCos) { bestCos = d; best = c.row; }
    }
  }
  if (best < 0) { tooFar++; continue; }
  const neighborId = embIds[best];
  const k = `${o.id}\t${neighborId}`;
  if (existingEdges.has(k)) continue;
  existingEdges.add(k);
  newEdges.push([o.id, neighborId, "semantic_bridge", "broader", bestCos.toFixed(3)].join("\t"));
  matched++;
}
console.log(`\nmatched: ${matched}, below threshold: ${tooFar}, no pool: ${noPool}`);

// --- append
if (newEdges.length) {
  const needsNewline = !pText.endsWith("\n");
  await Deno.writeTextFile("prereqs.tsv", (needsNewline ? pText + "\n" : pText) + newEdges.join("\n") + "\n");
  console.log(`appended ${newEdges.length} bridge edges`);
}
