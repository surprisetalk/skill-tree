// Wikidata P279 downloader, scoped to spine_skills.tsv (~4k skills).
// Uses the same API patterns as data/wikidata.ts but drops the technical-tag
// filter since the spine is already curated.
//
// Usage:
//   deno run --allow-read --allow-write --allow-net data/wikidata_spine.ts [MAX]
// Resumable: re-running skips already-fetched labels.

const SPINE_TSV = "spine_skills.tsv";
const OUT_DIR = "data/wikidata";
const OUT_FILE = `${OUT_DIR}/p279_spine.jsonl`;
const WBSEARCH = "https://www.wikidata.org/w/api.php";
const ENTITY_DATA = "https://www.wikidata.org/wiki/Special:EntityData";

type Row = { label: string; qid: string; parents: Array<{ qid: string; label: string }> };

async function loadDone(): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    for (const line of (await Deno.readTextFile(OUT_FILE)).split("\n")) {
      if (!line.trim()) continue;
      done.add((JSON.parse(line) as Row).label);
    }
  } catch { /* no cache */ }
  return done;
}

function loadLabels(): string[] {
  const text = Deno.readTextFileSync(SPINE_TSV);
  const lines = text.split("\n");
  const labels = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 5) continue;
    const label = parts[3]?.trim();
    if (!label || label.length < 4 || label.length > 80) continue;
    if (label.split(/\s+/).length > 10) continue;
    labels.add(label);
  }
  return [...labels].sort();
}

const UA = { "User-Agent": "skill-tree/1.0 (https://github.com/taylorlapeyre/skill-tree)" };

async function searchLabel(label: string): Promise<string | null> {
  const url = `${WBSEARCH}?action=wbsearchentities&search=${encodeURIComponent(label)}&language=en&format=json&limit=1&type=item`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const j = await res.json() as { search?: Array<{ id: string; match?: { text: string } }> };
  const hit = j.search?.[0];
  if (!hit) return null;
  if (hit.match?.text?.toLowerCase() !== label.toLowerCase()) return null;
  return hit.id;
}

async function fetchP279(qid: string): Promise<Array<{ qid: string; label: string }>> {
  const res = await fetch(`${ENTITY_DATA}/${qid}.json`, { headers: UA });
  if (!res.ok) return [];
  const j = await res.json() as {
    entities?: Record<string, { claims?: { P279?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> } }>;
  };
  const parents: string[] = [];
  for (const c of j.entities?.[qid]?.claims?.P279 ?? []) {
    const pid = c.mainsnak?.datavalue?.value?.id;
    if (pid) parents.push(pid);
  }
  if (!parents.length) return [];
  const lr = await fetch(`${WBSEARCH}?action=wbgetentities&ids=${parents.join("|")}&props=labels&languages=en&format=json`, { headers: UA });
  if (!lr.ok) return parents.map(q => ({ qid: q, label: "" }));
  const lj = await lr.json() as { entities?: Record<string, { labels?: { en?: { value: string } } }> };
  return parents.map(q => ({ qid: q, label: lj.entities?.[q]?.labels?.en?.value ?? "" }));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const maxArg = parseInt(Deno.args[0] ?? "10000");
await Deno.mkdir(OUT_DIR, { recursive: true });
const done = await loadDone();
const labels = loadLabels();
const todo = labels.filter(l => !done.has(l)).slice(0, maxArg);
console.log(`${labels.length} candidate labels, ${done.size} done, processing ${todo.length}`);

const out = await Deno.open(OUT_FILE, { create: true, append: true });
const enc = new TextEncoder();
let ok = 0, miss = 0;
for (let i = 0; i < todo.length; i++) {
  const label = todo[i];
  try {
    const qid = await searchLabel(label);
    await sleep(600);
    if (!qid) {
      await out.write(enc.encode(JSON.stringify({ label, qid: "", parents: [] }) + "\n"));
      miss++; continue;
    }
    const parents = await fetchP279(qid);
    await sleep(600);
    await out.write(enc.encode(JSON.stringify({ label, qid, parents } as Row) + "\n"));
    ok++;
  } catch (e) {
    console.error(`  ${label}: ${e}`);
    await sleep(5000);
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${todo.length}  ok=${ok} miss=${miss}`);
}
out.close();
console.log(`Done. ok=${ok} miss=${miss}`);
