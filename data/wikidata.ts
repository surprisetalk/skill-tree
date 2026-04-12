// Wikidata P279 (subclass-of) downloader.
// Reads curated skill labels from skills.tsv, queries Wikidata for matching items,
// and fetches P279 chains. Writes to data/wikidata/p279.jsonl (resumable).
//
// Usage:
//   deno run --allow-read --allow-write --allow-net data/wikidata.ts [MAX_LABELS]
//
// Rate limit: 1 req/sec on wbsearchentities + batched EntityData fetches.
// Run in chunks — cache is incremental, re-running resumes from last position.

const SKILLS_TSV = "skills.tsv"
const OUT_DIR = "data/wikidata"
const OUT_FILE = `${OUT_DIR}/p279.jsonl`
const WBSEARCH = "https://www.wikidata.org/w/api.php"
const ENTITY_DATA = "https://www.wikidata.org/wiki/Special:EntityData"

type Row = { label: string; qid: string; parents: Array<{ qid: string; label: string }> }

async function loadDone(): Promise<Set<string>> {
  const done = new Set<string>()
  try {
    const text = await Deno.readTextFile(OUT_FILE)
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      const r = JSON.parse(line) as Row
      done.add(r.label)
    }
  } catch { /* no cache yet */ }
  return done
}

async function loadLabels(): Promise<string[]> {
  const text = await Deno.readTextFile(SKILLS_TSV)
  const lines = text.split("\n")
  const labels = new Set<string>()
  const TECHNICAL_TAG = /\b(math|science|engineering|computer|physics|chemistry|biology|stem|technology)\b/
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t")
    if (parts.length < 6) continue
    const label = parts[3]?.trim()
    const tags = parts[5] ?? ""
    if (!label) continue
    if (label.length < 4 || label.length > 80) continue
    if (label.split(/\s+/).length > 10) continue // skip full-sentence standards
    if (!TECHNICAL_TAG.test(tags)) continue
    labels.add(label)
  }
  return [...labels].sort()
}

async function searchLabel(label: string): Promise<string | null> {
  const url = `${WBSEARCH}?action=wbsearchentities&search=${encodeURIComponent(label)}&language=en&format=json&limit=1&type=item`
  const res = await fetch(url, { headers: { "User-Agent": "skill-tree/1.0" } })
  if (!res.ok) return null
  const j = await res.json() as { search?: Array<{ id: string; match?: { type: string; text: string } }> }
  const hit = j.search?.[0]
  if (!hit) return null
  // Require exact label match (case-insensitive) to avoid false positives
  if (hit.match?.text?.toLowerCase() !== label.toLowerCase()) return null
  return hit.id
}

async function fetchP279(qid: string): Promise<Array<{ qid: string; label: string }>> {
  const url = `${ENTITY_DATA}/${qid}.json`
  const res = await fetch(url, { headers: { "User-Agent": "skill-tree/1.0" } })
  if (!res.ok) return []
  const j = await res.json() as {
    entities?: Record<string, {
      claims?: { P279?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> }
    }>
  }
  const ent = j.entities?.[qid]
  const parents: string[] = []
  for (const c of ent?.claims?.P279 ?? []) {
    const pid = c.mainsnak?.datavalue?.value?.id
    if (pid) parents.push(pid)
  }
  if (!parents.length) return []
  // Batch-fetch parent labels
  const labelsUrl = `${WBSEARCH}?action=wbgetentities&ids=${parents.join("|")}&props=labels&languages=en&format=json`
  const lr = await fetch(labelsUrl, { headers: { "User-Agent": "skill-tree/1.0" } })
  if (!lr.ok) return parents.map(q => ({ qid: q, label: "" }))
  const lj = await lr.json() as { entities?: Record<string, { labels?: { en?: { value: string } } }> }
  return parents.map(q => ({ qid: q, label: lj.entities?.[q]?.labels?.en?.value ?? "" }))
}

async function sleep(ms: number) { await new Promise(r => setTimeout(r, ms)) }

async function main() {
  const maxArg = parseInt(Deno.args[0] ?? "1000")
  await Deno.mkdir(OUT_DIR, { recursive: true })
  const done = await loadDone()
  const labels = await loadLabels()
  const todo = labels.filter(l => !done.has(l)).slice(0, maxArg)
  console.log(`${labels.length} candidate labels, ${done.size} done, processing ${todo.length}`)

  const out = await Deno.open(OUT_FILE, { create: true, append: true })
  let ok = 0, miss = 0
  for (let i = 0; i < todo.length; i++) {
    const label = todo[i]
    try {
      const qid = await searchLabel(label)
      await sleep(1000)
      if (!qid) {
        await out.write(new TextEncoder().encode(JSON.stringify({ label, qid: "", parents: [] }) + "\n"))
        miss++; continue
      }
      const parents = await fetchP279(qid)
      await sleep(1000)
      await out.write(new TextEncoder().encode(JSON.stringify({ label, qid, parents } as Row) + "\n"))
      ok++
    } catch (e) {
      console.error(`  ${label}: ${e}`)
      await sleep(5000)
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${todo.length}  ok=${ok} miss=${miss}`)
  }
  out.close()
  console.log(`Done. ok=${ok} miss=${miss}`)
}

if (import.meta.main) main()
