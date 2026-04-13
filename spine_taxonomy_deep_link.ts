// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write --allow-run spine_taxonomy_deep_link.ts
// For each spine skill with an embedding, find nearest taxonomy concept via cosine.
// Append taxonomy id/url to spine ext_ids/ext_urls where cos >= threshold.
// Uses numpy via .venv for the heavy matmul.

const EMB_DIM = 384;
const COS_THRESHOLD = 0.65;

// 1) Collect spine skill IDs (exclude wikidata nodes — they have no embeddings)
const sLines = (await Deno.readTextFile("spine_skills.tsv")).split("\n").filter(x => x);
const sH = sLines[0].split("\t");
const iId = sH.indexOf("id"), iExtIds = sH.indexOf("ext_ids"),
  iExtUrls = sH.indexOf("ext_urls"), iSrc = sH.indexOf("source");

const spineIds: string[] = [];
const rowById = new Map<string, string[]>();
for (let i = 1; i < sLines.length; i++) {
  const r = sLines[i].split("\t");
  while (r.length < sH.length) r.push("");
  rowById.set(r[iId], r);
  if (r[iSrc] !== "wikidata") spineIds.push(r[iId]);
}

// 2) Find each spine skill's row in embeddings.bin
const embIds = (await Deno.readTextFile("embeddings_ids.tsv")).split("\n").slice(1).filter(x => x);
const idxOf = new Map<string, number>();
for (let i = 0; i < embIds.length; i++) idxOf.set(embIds[i], i);

const rowsToExtract: number[] = [];
const spineWithEmb: string[] = [];
for (const id of spineIds) {
  const row = idxOf.get(id);
  if (row !== undefined) { rowsToExtract.push(row); spineWithEmb.push(id); }
}
console.log(`spine skills with embeddings: ${spineWithEmb.length}`);

// 3) Write spine subset embeddings to a temp file
const embBuf = await Deno.readFile("embeddings.bin");
// embeddings.bin starts with a 4-byte uint32 count header (see main.ts writeEmbeddings).
const emb = new Float32Array(embBuf.buffer, embBuf.byteOffset + 4, (embBuf.byteLength - 4) / 4);
const spineVecBytes = rowsToExtract.length * EMB_DIM * 4;
const spineVecBuf = new Uint8Array(spineVecBytes);
const spineVec = new Float32Array(spineVecBuf.buffer);
for (let i = 0; i < rowsToExtract.length; i++) {
  const src = emb.subarray(rowsToExtract[i] * EMB_DIM, (rowsToExtract[i] + 1) * EMB_DIM);
  spineVec.set(src, i * EMB_DIM);
}
await Deno.writeFile("spine_vecs.bin", spineVecBuf);
console.log(`wrote spine_vecs.bin (${(spineVecBytes / 1024 / 1024).toFixed(1)} MB)`);

// 4) Python NN search: for each spine vec, find argmax cos-sim over taxonomy
const py = `
import numpy as np
import sys

N_SPINE = ${spineWithEmb.length}
N_TAX = ${(() => {
  return 1875337;
})()}  # rows in taxonomy_embeddings.bin
DIM = ${EMB_DIM}

spine = np.memmap("spine_vecs.bin", dtype=np.float32, mode='r').reshape(N_SPINE, DIM)
tax = np.memmap("taxonomy_embeddings.bin", dtype=np.float32, mode='r').reshape(N_TAX, DIM)

# Vectors assumed already L2-normalized by sentence-transformers. Double-check spine.
sn = np.linalg.norm(spine, axis=1, keepdims=True)
spine_n = spine / np.clip(sn, 1e-8, None)

BATCH = 50
best_idx = np.zeros(N_SPINE, dtype=np.int64)
best_sim = np.zeros(N_SPINE, dtype=np.float32)
for i in range(0, N_SPINE, BATCH):
    j = min(i + BATCH, N_SPINE)
    s = spine_n[i:j]  # (b, dim)
    # dot products vs entire taxonomy. tax is already normalized by MiniLM.
    scores = s @ tax.T  # (b, N_TAX)
    idx = np.argmax(scores, axis=1)
    sim = scores[np.arange(j - i), idx]
    best_idx[i:j] = idx
    best_sim[i:j] = sim
    if (i // BATCH) % 10 == 0:
        print(f"  {j}/{N_SPINE}", file=sys.stderr, flush=True)

# Write results as TSV: row_in_spine\\ttax_row\\tcos
with open("spine_tax_nn.tsv", "w") as f:
    for i in range(N_SPINE):
        f.write(f"{i}\\t{best_idx[i]}\\t{best_sim[i]:.4f}\\n")
print("done", file=sys.stderr)
`;

console.log("running NN search via numpy…");
const venv = `${Deno.cwd()}/.venv/bin/python3`;
const proc = new Deno.Command(venv, {
  args: ["-c", py], stdout: "inherit", stderr: "inherit",
});
const { success } = await proc.output();
if (!success) { console.error("python failed"); Deno.exit(1); }

// 5) Load taxonomy IDs + relevant fields
const taxIdsAll = (await Deno.readTextFile("taxonomy_embeddings_ids.tsv")).split("\n").slice(1);
console.log(`tax ids loaded: ${taxIdsAll.length}`);

// Build a tax lookup: id -> {url, label}
const taxMeta = new Map<string, { url: string; label: string }>();
{
  const f = await Deno.open("taxonomy.tsv");
  const dec = new TextDecoder();
  const buf = new Uint8Array(1 << 20);
  let leftover = "";
  let header: string[] | null = null;
  let tI = -1, tU = -1, tL = -1;
  while (true) {
    const n = await f.read(buf);
    if (!n) break;
    leftover += dec.decode(buf.subarray(0, n), { stream: true });
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      const c = l.split("\t");
      if (!header) { header = c; tI = c.indexOf("id"); tU = c.indexOf("ext_urls"); tL = c.indexOf("label"); continue; }
      taxMeta.set(c[tI], { url: (c[tU] ?? "").split(";")[0] ?? "", label: c[tL] ?? "" });
    }
  }
}

// 6) Apply results
const nnLines = (await Deno.readTextFile("spine_tax_nn.tsv")).split("\n").filter(x => x);
let applied = 0, belowThresh = 0;
const simHist: number[] = [];
for (const l of nnLines) {
  const [spineRowStr, taxRowStr, simStr] = l.split("\t");
  const sim = +simStr;
  simHist.push(sim);
  if (sim < COS_THRESHOLD) { belowThresh++; continue; }
  const sId = spineWithEmb[+spineRowStr];
  const tId = taxIdsAll[+taxRowStr];
  const meta = taxMeta.get(tId);
  if (!meta) continue;
  const r = rowById.get(sId)!;
  const ids = new Set((r[iExtIds] ?? "").split(";").filter(x => x));
  const urls = new Set((r[iExtUrls] ?? "").split(";").filter(x => x));
  ids.add(tId);
  if (meta.url) urls.add(meta.url);
  r[iExtIds] = [...ids].join(";");
  r[iExtUrls] = [...urls].join(";");
  applied++;
}

const out = [sH.join("\t")];
for (const [, r] of rowById) out.push(r.join("\t"));
await Deno.writeTextFile("spine_skills.tsv", out.join("\n") + "\n");

simHist.sort((a, b) => a - b);
const median = simHist[Math.floor(simHist.length / 2)];
const p90 = simHist[Math.floor(simHist.length * 0.9)];

console.log(`\napplied (cos >= ${COS_THRESHOLD}): ${applied}`);
console.log(`below threshold: ${belowThresh}`);
console.log(`median sim: ${median?.toFixed(3)}, p90: ${p90?.toFixed(3)}`);

// Cleanup tmp
try { await Deno.remove("spine_vecs.bin"); } catch { /* ok */ }
try { await Deno.remove("spine_tax_nn.tsv"); } catch { /* ok */ }
