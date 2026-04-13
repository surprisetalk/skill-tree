// deno run --v8-flags=--max-old-space-size=12288 --allow-read --allow-write --allow-run embed_taxonomy.ts
// Embed every taxonomy.tsv label with all-MiniLM-L6-v2 (384-dim).
// Writes taxonomy_embeddings.bin (Float32 flat) + taxonomy_embeddings_ids.tsv.

const EMB_DIM = 384;
const CHUNK = 50_000;

const ids: string[] = [];
const labels: string[] = [];
{
  const f = await Deno.open("taxonomy.tsv");
  const dec = new TextDecoder();
  const buf = new Uint8Array(1 << 20);
  let leftover = "";
  let header: string[] | null = null;
  let iId = -1, iLabel = -1;
  while (true) {
    const n = await f.read(buf);
    if (!n) break;
    leftover += dec.decode(buf.subarray(0, n), { stream: true });
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      const c = l.split("\t");
      if (!header) { header = c; iId = c.indexOf("id"); iLabel = c.indexOf("label"); continue; }
      const lab = (c[iLabel] ?? "").trim();
      if (!lab) continue;
      ids.push(c[iId]);
      labels.push(lab);
    }
  }
}
console.log(`${labels.length.toLocaleString()} labels to embed`);

await Deno.writeTextFile(
  "taxonomy_embeddings_ids.tsv",
  "id\n" + ids.join("\n") + "\n",
);

const outFile = await Deno.open("taxonomy_embeddings.bin", { create: true, write: true, truncate: true });

const script = `
import sys, numpy as np
from sentence_transformers import SentenceTransformer
m = SentenceTransformer('all-MiniLM-L6-v2')
for line in sys.stdin:
    n = int(line.strip())
    if n == 0: break
    labs = [sys.stdin.readline().rstrip('\\n') for _ in range(n)]
    v = m.encode(labs, normalize_embeddings=True, batch_size=128, show_progress_bar=False).astype(np.float32)
    sys.stdout.buffer.write(v.tobytes()); sys.stdout.buffer.flush()
    sys.stderr.write(f'chunk {n}\\n'); sys.stderr.flush()
`;

const venvPy = `${Deno.cwd()}/.venv/bin/python3`;
let pyCmd = "python3";
try { await Deno.stat(venvPy); pyCmd = venvPy; } catch { /* system */ }

const proc = new Deno.Command(pyCmd, {
  args: ["-u", "-c", script],
  stdin: "piped", stdout: "piped", stderr: "inherit",
}).spawn();

const writer = proc.stdin.getWriter();
const reader = proc.stdout.getReader();
const enc = new TextEncoder();

let written = 0;
for (let start = 0; start < labels.length; start += CHUNK) {
  const chunk = labels.slice(start, start + CHUNK);
  await writer.write(enc.encode(`${chunk.length}\n${chunk.join("\n")}\n`));
  const expectedBytes = chunk.length * EMB_DIM * 4;
  let got = 0;
  while (got < expectedBytes) {
    const { value, done } = await reader.read();
    if (done) throw new Error("python exited before expected bytes");
    await outFile.write(value);
    got += value.length;
  }
  written += chunk.length;
  console.log(`  embedded ${written.toLocaleString()}/${labels.length.toLocaleString()}`);
}
await writer.write(enc.encode("0\n"));
await writer.close();
outFile.close();
const { code } = await proc.status;
console.log(`done (exit ${code})`);
