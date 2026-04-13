// Bulk P279 puller via SPARQL. Much faster than the label-matching crawler
// in wikidata.ts / wikidata_spine.ts: one query per root returns thousands of
// (child, parent) pairs. Writes data/wikidata/p279.jsonl in the format
// parseWikidata() consumes: {qid, label, parents: [{qid, label}]}.
//
//   deno run --allow-read --allow-write --allow-net data/wikidata_sparql.ts

const OUT_FILE = "data/wikidata/p279.jsonl";
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = { "User-Agent": "skill-tree/1.0", "Accept": "application/sparql-results+json" };

// Roots spanning knowledge domains. Each query pulls everything subclass-of a root
// transitively + each item's direct P279 parents.
const ROOTS: Array<{ qid: string; name: string }> = [
  { qid: "Q11862829", name: "academic discipline" },
  { qid: "Q336",      name: "science" },
  { qid: "Q11023",    name: "engineering" },
  { qid: "Q11190",    name: "medicine" },
  { qid: "Q735",      name: "art" },
  { qid: "Q8242",     name: "literature" },
  { qid: "Q638",      name: "music" },
  { qid: "Q9174",     name: "religion" },
  { qid: "Q309",      name: "history" },
  { qid: "Q34178",    name: "theory" },
  { qid: "Q28797",    name: "applied science" },
  { qid: "Q11862829", name: "academic discipline" },
  { qid: "Q1047113",  name: "specialty" },
  { qid: "Q2996394",  name: "branch of science" },
];

type Row = { qid: string; label: string; parents: Array<{ qid: string; label: string }> };

function qidFromUri(u: string): string { return u.split("/").pop() ?? ""; }

async function sparql(query: string): Promise<Array<Record<string, { value: string }>>> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text().catch(() => "")}`);
  const j = await res.json() as { results?: { bindings?: Array<Record<string, { value: string }>> } };
  return j.results?.bindings ?? [];
}

async function pullRoot(root: { qid: string; name: string }): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  const q = `
    SELECT ?s ?sLabel ?p ?pLabel WHERE {
      ?s wdt:P279+ wd:${root.qid} .
      ?s wdt:P279 ?p .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }`;
  console.log(`  ${root.qid} ${root.name}...`);
  const bindings = await sparql(q);
  for (const b of bindings) {
    const sQid = qidFromUri(b.s.value);
    const pQid = qidFromUri(b.p.value);
    const sLabel = b.sLabel?.value ?? "";
    const pLabel = b.pLabel?.value ?? "";
    if (!sQid || !pQid || sLabel.startsWith("Q")) continue;
    if (!rows.has(sQid)) rows.set(sQid, { qid: sQid, label: sLabel, parents: [] });
    const row = rows.get(sQid)!;
    if (!row.parents.some(p => p.qid === pQid)) row.parents.push({ qid: pQid, label: pLabel });
  }
  console.log(`    ${bindings.length} bindings, ${rows.size} items`);
  return rows;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

await Deno.mkdir("data/wikidata", { recursive: true });
const merged = new Map<string, Row>();

for (const root of ROOTS) {
  try {
    const rows = await pullRoot(root);
    for (const [q, r] of rows) {
      if (!merged.has(q)) merged.set(q, r);
      else {
        const cur = merged.get(q)!;
        for (const p of r.parents) if (!cur.parents.some(x => x.qid === p.qid)) cur.parents.push(p);
      }
    }
  } catch (e) {
    console.error(`  FAILED ${root.qid}: ${e}`);
  }
  await sleep(1500);
}

const out = await Deno.open(OUT_FILE, { create: true, write: true, truncate: true });
const enc = new TextEncoder();
for (const row of merged.values()) {
  await out.write(enc.encode(JSON.stringify(row) + "\n"));
}
out.close();
console.log(`\nWrote ${OUT_FILE}: ${merged.size} items`);
