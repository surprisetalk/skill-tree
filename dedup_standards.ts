// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write dedup_standards.ts
// Post-hoc dedup of standards across jurisdictions (CSP/OpenSALT/ASN).
// Uses embeddings.bin (L2-normalized, 384-dim). Bucket by (grade, first content token).
// Merges via union-find at cos >= 0.92 + Jaccard token overlap >= 0.5.
// Rewrites skills.tsv and prereqs.tsv in place (backups created).

const EMB_DIM = 384;
const COS_THRESHOLD = 0.92;
const JACCARD_MIN = 0.5;
const STANDARDS_SOURCES = new Set(["csp", "opensalt", "asn"]);
const STOP = new Set(["a","an","the","and","or","of","in","to","for","is","on","at","by","with","as","it","its","be","are","was","were","been","has","have","had","do","does","did","not","no","but","if","so","up","out","all","can","will","may","use","used","using","student","students","able","expected","demonstrate","understanding","learner","should"]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(t => t.length >= 3 && !STOP.has(t));
}
function firstToken(s: string): string {
  for (const t of normalize(s).split(" ")) if (t.length >= 3 && !STOP.has(t)) return t;
  return "";
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [sm, lg] = a.size < b.size ? [a, b] : [b, a];
  for (const x of sm) if (lg.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// --- load skills.tsv
console.log("loading skills.tsv…");
const skillsTxt = await Deno.readTextFile("skills.tsv");
const skillLines = skillsTxt.split("\n");
const skillsHeader = skillLines[0];
const cols = skillsHeader.split("\t"); // id,ext_ids,ext_urls,label,description,tags,source,grade_start,grade_end
const iId = cols.indexOf("id"), iExt = cols.indexOf("ext_ids"), iLabel = cols.indexOf("label"),
      iSrc = cols.indexOf("source"), iGs = cols.indexOf("grade_start");

type Row = string[];
const rows: Row[] = [];
const idToRow = new Map<string, number>();
for (let i = 1; i < skillLines.length; i++) {
  if (!skillLines[i]) continue;
  const r = skillLines[i].split("\t");
  idToRow.set(r[iId], rows.length);
  rows.push(r);
}
console.log(`  ${rows.length} skills`);

// --- load embeddings_ids.tsv to verify order matches skills.tsv
const embIdsTxt = await Deno.readTextFile("embeddings_ids.tsv");
const embIds = embIdsTxt.split("\n").slice(1).filter(x => x);
if (embIds.length !== rows.length) throw new Error(`emb ${embIds.length} vs skills ${rows.length}`);
for (let i = 0; i < embIds.length; i++) {
  if (embIds[i] !== rows[i][iId]) throw new Error(`row ${i}: emb=${embIds[i]} skills=${rows[i][iId]}`);
}
console.log("  embeddings alignment verified");

// --- mmap embeddings
console.log("loading embeddings.bin…");
const embBuf = await Deno.readFile("embeddings.bin");
const emb = new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4);
console.log(`  ${emb.length / EMB_DIM} vectors`);

// --- bucket standards
console.log("bucketing standards…");
type Cand = { idx: number; tokens: Set<string> };
const buckets = new Map<string, Cand[]>();
let candidates = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!STANDARDS_SOURCES.has(r[iSrc])) continue;
  const label = r[iLabel] ?? "";
  if (label.length < 10) continue;
  const tok = firstToken(label);
  if (!tok) continue;
  const grade = r[iGs] ?? "";
  const key = `${grade}|${tok}`;
  const toks = new Set(tokens(label));
  if (toks.size < 3) continue;
  (buckets.get(key) ?? buckets.set(key, []).get(key)!).push({ idx: i, tokens: toks });
  candidates++;
}
console.log(`  ${candidates} candidate standards in ${buckets.size} buckets`);

// Bucket size histogram
let big = 0; let sumSqr = 0;
for (const [, b] of buckets) { if (b.length > 200) big++; sumSqr += b.length * b.length; }
console.log(`  buckets with >200: ${big}; sum(size^2)=${sumSqr.toLocaleString()}`);

// --- union find
const parent = new Int32Array(rows.length);
for (let i = 0; i < parent.length; i++) parent[i] = i;
function find(x: number): number {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
  return x;
}
function union(a: number, b: number) {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent[ra] = rb;
}

function cos(a: number, b: number): number {
  const pa = a * EMB_DIM, pb = b * EMB_DIM;
  let d = 0;
  for (let i = 0; i < EMB_DIM; i++) d += emb[pa + i] * emb[pb + i];
  return d;
}

// --- pairwise within bucket
console.log("pairwise matching…");
let compared = 0, merged = 0;
const bucketList = [...buckets.values()];
for (let bi = 0; bi < bucketList.length; bi++) {
  const b = bucketList[bi];
  if (b.length < 2 || b.length > 500) continue; // cap to avoid O(n^2) blowups
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      compared++;
      const c = cos(b[i].idx, b[j].idx);
      if (c < COS_THRESHOLD) continue;
      const jac = jaccard(b[i].tokens, b[j].tokens);
      if (jac < JACCARD_MIN) continue;
      union(b[i].idx, b[j].idx);
      merged++;
    }
  }
  if (bi % 5000 === 0 && bi) console.log(`  bucket ${bi}/${bucketList.length}, compared ${compared}, merged ${merged}`);
}
console.log(`  compared ${compared.toLocaleString()} pairs, merged ${merged.toLocaleString()}`);

// --- build groups
const groups = new Map<number, number[]>();
for (let i = 0; i < parent.length; i++) {
  const r = find(i);
  (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
}
let collapsed = 0;
for (const [, g] of groups) if (g.length > 1) collapsed += g.length - 1;
console.log(`  ${collapsed} rows will collapse into canonicals`);

// --- pick canonical: shortest id that isn't a hash
function idPenalty(id: string): number {
  const parts = id.split(".");
  const last = parts[parts.length - 1];
  // hex-hash-like penalty
  if (/^[a-f0-9-]{12,}$/i.test(last)) return 10000;
  if (/^\d{5,}$/.test(last)) return 5000;
  return id.length;
}

const idMap = new Map<string, string>(); // old id -> canonical id
const droppedRows = new Set<number>();

for (const [, g] of groups) {
  if (g.length < 2) continue;
  // canonical = lowest penalty; tiebreak = fewest dots, then lexical
  let canon = g[0];
  for (const i of g) {
    const a = rows[i][iId], b = rows[canon][iId];
    if (idPenalty(a) < idPenalty(b) ||
        (idPenalty(a) === idPenalty(b) && a < b)) canon = i;
  }
  const canonId = rows[canon][iId];
  const extSet = new Set<string>();
  if (rows[canon][iExt]) for (const e of rows[canon][iExt].split(";")) if (e) extSet.add(e);
  for (const i of g) {
    if (i === canon) continue;
    idMap.set(rows[i][iId], canonId);
    extSet.add(rows[i][iId]);
    if (rows[i][iExt]) for (const e of rows[i][iExt].split(";")) if (e) extSet.add(e);
    droppedRows.add(i);
  }
  rows[canon][iExt] = [...extSet].join(";");
}
console.log(`  dropping ${droppedRows.size} rows`);

// --- rewrite skills.tsv
await Deno.writeTextFile("skills.tsv.bak", skillsTxt);
const outSkills: string[] = [skillsHeader];
for (let i = 0; i < rows.length; i++) {
  if (droppedRows.has(i)) continue;
  outSkills.push(rows[i].join("\t"));
}
await Deno.writeTextFile("skills.tsv", outSkills.join("\n") + "\n");
console.log(`wrote skills.tsv: ${outSkills.length - 1} rows`);

// --- rewrite prereqs.tsv
console.log("rewriting prereqs.tsv…");
const prereqsTxt = await Deno.readTextFile("prereqs.tsv");
await Deno.writeTextFile("prereqs.tsv.bak2", prereqsTxt);
const pLines = prereqsTxt.split("\n");
const pHeader = pLines[0];
const seen = new Set<string>();
let selfLoop = 0, dup = 0, kept = 0;
const outP: string[] = [pHeader];
for (let i = 1; i < pLines.length; i++) {
  if (!pLines[i]) continue;
  const parts = pLines[i].split("\t");
  const skill_id = idMap.get(parts[0]) ?? parts[0];
  const prereq_id = idMap.get(parts[1]) ?? parts[1];
  if (skill_id === prereq_id) { selfLoop++; continue; }
  parts[0] = skill_id; parts[1] = prereq_id;
  const k = `${skill_id}\t${prereq_id}`;
  if (seen.has(k)) { dup++; continue; }
  seen.add(k);
  outP.push(parts.join("\t"));
  kept++;
}
await Deno.writeTextFile("prereqs.tsv", outP.join("\n") + "\n");
console.log(`  kept ${kept}, dropped ${selfLoop} self-loops, ${dup} duplicates`);
