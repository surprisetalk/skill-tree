// Wikidata P279 (subclass-of) downloader via SPARQL batching.
// Reads spine labels from spine_skills.tsv, queries WDQS for exact-label matches
// and their P279 chain. Writes to data/wikidata/p279.jsonl (resumable, case-insensitive).
//
// Usage:
//   deno run --allow-read --allow-write --allow-net data/wikidata.ts [MAX_LABELS]

const SKILLS_TSV = "spine_skills.tsv"
const OUT_DIR = "data/wikidata"
const OUT_FILE = `${OUT_DIR}/p279.jsonl`
const SPARQL = "https://query.wikidata.org/sparql"
const BATCH = 40

type Row = { label: string; qid: string; parents: Array<{ qid: string; label: string }> }

async function loadDone(): Promise<Set<string>> {
  const done = new Set<string>()
  try {
    const text = await Deno.readTextFile(OUT_FILE)
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      const r = JSON.parse(line) as Row
      done.add(r.label.toLowerCase())
    }
  } catch { /* no cache yet */ }
  return done
}

async function loadLabels(): Promise<string[]> {
  const text = await Deno.readTextFile(SKILLS_TSV)
  const lines = text.split("\n")
  const labels = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t")
    if (parts.length < 6) continue
    const label = parts[3]?.trim()
    if (!label) continue
    if (label.length < 4 || label.length > 60) continue
    if (label.split(/\s+/).length > 6) continue
    if (/[.!?]$/.test(label)) continue // skip sentence-shaped standards
    labels.add(label)
  }
  return [...labels].sort()
}

function sparqlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function sleep(ms: number) { await new Promise(r => setTimeout(r, ms)) }

async function queryBatch(batch: string[]): Promise<Map<string, Row>> {
  // Match lowercase English labels; each item's P279 parents with English labels.
  // Excludes P31=human/city/country/film/book/etc. to skip proper nouns/titles.
  const values = batch.map(l => `"${sparqlEscape(l.toLowerCase())}"@en`).join(" ")
  const q = `SELECT ?label ?item ?itemLabel ?p279 ?p279Label WHERE {
    VALUES ?label { ${values} }
    ?item rdfs:label ?label .
    ?item wdt:P279 ?p279 .
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q5 }
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q515 }
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q6256 }
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q11424 }
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q571 }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }`
  const res = await fetch(SPARQL, {
    method: "POST",
    headers: {
      "User-Agent": "skill-tree/1.0",
      "Accept": "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `query=${encodeURIComponent(q)}`,
  })
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const j = await res.json() as {
    results: { bindings: Array<Record<string, { value: string }>> }
  }
  const out = new Map<string, Row>()
  for (const b of j.results.bindings) {
    const label = b.label.value
    const qid = b.item.value.replace("http://www.wikidata.org/entity/", "")
    const p279 = b.p279.value.replace("http://www.wikidata.org/entity/", "")
    const pLabel = b.p279Label?.value ?? ""
    let r = out.get(label)
    if (!r) { r = { label, qid, parents: [] }; out.set(label, r) }
    // Avoid duplicate parents; also skip self
    if (p279 !== qid && !r.parents.some(p => p.qid === p279)) {
      r.parents.push({ qid: p279, label: pLabel })
    }
  }
  return out
}

async function main() {
  const maxArg = parseInt(Deno.args[0] ?? "10000")
  await Deno.mkdir(OUT_DIR, { recursive: true })
  const done = await loadDone()
  const labels = await loadLabels()
  const todo = labels.filter(l => !done.has(l.toLowerCase())).slice(0, maxArg)
  console.log(`${labels.length} candidate labels, ${done.size} done, processing ${todo.length}`)

  const out = await Deno.open(OUT_FILE, { create: true, append: true })
  let ok = 0, miss = 0
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    let hits: Map<string, Row> | null = null
    for (let attempt = 0; attempt < 3 && !hits; attempt++) {
      try { hits = await queryBatch(batch) }
      catch (e) {
        console.error(`  batch ${i} attempt ${attempt + 1}: ${(e as Error).message.slice(0, 100)}`)
        await sleep(15000 * (attempt + 1))
      }
    }
    if (!hits) { console.error(`  batch ${i}: giving up`); continue }
    for (const l of batch) {
      const r = hits.get(l.toLowerCase()) ?? { label: l, qid: "", parents: [] }
      if (r.qid) { r.label = l; ok++ } else { miss++ }
      await out.write(new TextEncoder().encode(JSON.stringify(r) + "\n"))
    }
    await sleep(2500) // be polite to WDQS
    if ((i / BATCH + 1) % 5 === 0) console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}  ok=${ok} miss=${miss}`)
  }
  out.close()
  console.log(`Done. ok=${ok} miss=${miss}`)
}

if (import.meta.main) main()
