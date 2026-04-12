// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write spine_taxonomy_link.ts
// Link LCSH/DBpedia concepts into spine_skills.tsv via normalized label match.
// Appends taxonomy ids/urls into ext_ids/ext_urls of matched spine rows.

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const taxIdx = new Map<string, { id: string; url: string }[]>();
{
  const f = await Deno.open("taxonomy.tsv");
  const dec = new TextDecoder();
  const buf = new Uint8Array(1 << 20);
  let leftover = "";
  let header: string[] | null = null;
  let iId = -1, iUrls = -1, iLabel = -1;
  while (true) {
    const n = await f.read(buf);
    if (!n) break;
    leftover += dec.decode(buf.subarray(0, n), { stream: true });
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      const c = l.split("\t");
      if (!header) {
        header = c;
        iId = header.indexOf("id");
        iUrls = header.indexOf("ext_urls");
        iLabel = header.indexOf("label");
        continue;
      }
      const id = c[iId], label = c[iLabel];
      if (!label) continue;
      // Only LCSH/DBpedia heads — others (csp/lightcast) are already in spine graph
      if (!id.startsWith("lcsh.") && !id.startsWith("dbpedia.")) continue;
      const k = norm(label);
      if (!k) continue;
      const url = (c[iUrls] ?? "").split(";")[0] ?? "";
      const arr = taxIdx.get(k);
      const entry = { id, url };
      if (arr) arr.push(entry); else taxIdx.set(k, [entry]);
    }
  }
}
console.log(`taxonomy labels indexed: ${taxIdx.size}`);

const sLines = (await Deno.readTextFile("spine_skills.tsv")).split("\n").filter(x => x);
const sH = sLines[0].split("\t");
const iId = sH.indexOf("id"), iExtIds = sH.indexOf("ext_ids"),
  iExtUrls = sH.indexOf("ext_urls"), iLabel = sH.indexOf("label");

// Keep only multi-word tax labels ≥10 chars for n-gram matching (else "water" hits too much)
const taxNgramIdx = new Map<string, { id: string; url: string }[]>();
for (const [k, v] of taxIdx) {
  if (k.length >= 10 && k.includes(" ")) taxNgramIdx.set(k, v);
}

function ngrams(tokens: string[], nMax: number): string[] {
  const out: string[] = [];
  for (let n = Math.min(nMax, tokens.length); n >= 2; n--) {
    for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

let matched = 0, multiMatched = 0, added = 0;
const out = [sLines[0]];
for (let i = 1; i < sLines.length; i++) {
  const r = sLines[i].split("\t");
  const k = norm(r[iLabel] ?? "");
  let hits = k ? taxIdx.get(k) : undefined;
  if (!hits) {
    const toks = k.split(" ").filter(x => x && x.length > 2);
    for (const g of ngrams(toks, 4)) {
      const h = taxNgramIdx.get(g);
      if (h) { hits = h; break; }
    }
  }
  if (hits && hits.length) {
    matched++;
    if (hits.length > 1) multiMatched++;
    const existIds = new Set((r[iExtIds] ?? "").split(";").filter(x => x));
    const existUrls = new Set((r[iExtUrls] ?? "").split(";").filter(x => x));
    for (const h of hits) {
      if (!existIds.has(h.id)) { existIds.add(h.id); added++; }
      if (h.url && !existUrls.has(h.url)) existUrls.add(h.url);
    }
    r[iExtIds] = [...existIds].join(";");
    r[iExtUrls] = [...existUrls].join(";");
  }
  out.push(r.join("\t"));
}
await Deno.writeTextFile("spine_skills.tsv", out.join("\n") + "\n");

console.log(`spine skills matched: ${matched} / ${sLines.length - 1}`);
console.log(`multi-match: ${multiMatched}`);
console.log(`taxonomy ids added: ${added}`);
