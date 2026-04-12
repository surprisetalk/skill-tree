const DATA = "./data"
const CACHE_PATH = `${DATA}/llm_prereqs.json`
const BATCH_SIZE = 100 // pairs per API request
const API_BATCH_SIZE = 10_000 // requests per Batches API submission

type CacheEntry = { direction: string; confidence: number }
type Cache = { pairs: Record<string, CacheEntry>; version: number }

function parseTsvRows(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter(l => l.trim())
  if (!lines.length) return []
  const hdr = lines[0].split("\t")
  return lines.slice(1).map(line => {
    const vals = line.split("\t")
    const obj: Record<string, string> = {}
    for (let i = 0; i < hdr.length; i++) obj[hdr[i]] = vals[i] ?? ""
    return obj
  })
}

function bigrams(s: string): Set<string> {
  const low = s.toLowerCase()
  const bg = new Set<string>()
  for (let i = 0; i < low.length - 1; i++) bg.add(low.slice(i, i + 2))
  return bg
}

function dice(a: string, b: string): number {
  const ba = bigrams(a), bb = bigrams(b)
  if (!ba.size || !bb.size) return 0
  let overlap = 0
  for (const g of ba) if (bb.has(g)) overlap++
  return (2 * overlap) / (ba.size + bb.size)
}

function canonicalKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function makePrompt(pairs: [string, string, string, string][]): string {
  const listing = pairs.map(([, la, , lb], i) => `${i + 1}. "${la}" vs "${lb}"`).join("\n")
  return `For each pair of skills/concepts, determine prerequisite relationships. A prerequisite means you should learn concept A before concept B.

Respond with ONLY a JSON array where each element is one of: "a->b", "b->a", "none". Use "a->b" if the first concept is prerequisite to the second. Use "b->a" for the reverse. Use "none" if neither is a clear prerequisite.

Pairs:
${listing}`
}

function parseDirections(text: string, pairs: [string, string, string, string][]): Record<string, CacheEntry> {
  const arrMatch = text.match(/\[[\s\S]*\]/)
  if (!arrMatch) throw new Error(`No JSON array in response: ${text.slice(0, 200)}`)
  const directions = JSON.parse(arrMatch[0]) as string[]
  if (directions.length < pairs.length)
    console.error(`  WARNING: got ${directions.length}/${pairs.length} results`)
  const results: Record<string, CacheEntry> = {}
  for (let i = 0; i < pairs.length && i < directions.length; i++) {
    const [idA, , idB] = pairs[i]
    const dir = directions[i]?.toLowerCase()?.trim()
    const key = canonicalKey(idA, idB)
    if (dir === "a->b" || dir === "b->a") {
      const flipped = idA > idB
      let mapped = dir
      if (flipped) mapped = dir === "a->b" ? "b->a" : "a->b"
      results[key] = { direction: mapped, confidence: 0.8 }
    } else {
      results[key] = { direction: "none", confidence: 0.8 }
    }
  }
  return results
}

type BatchRequest = {
  custom_id: string
  params: {
    model: string
    max_tokens: number
    messages: Array<{ role: string; content: string }>
  }
}

async function apiFetch(path: string, apiKey: string, opts: { method?: string; body?: unknown } = {}) {
  const resp = await fetch(`https://api.anthropic.com/v1${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`API ${opts.method ?? "GET"} ${path} failed (${resp.status}): ${err}`)
  }
  return resp.json()
}

async function submitBatch(
  batches: Array<{ idx: number; pairs: [string, string, string, string][] }>,
  apiKey: string,
): Promise<string> {
  const requests: BatchRequest[] = batches.map(b => ({
    custom_id: `batch_${b.idx}`,
    params: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: makePrompt(b.pairs) }],
    },
  }))

  const result = await apiFetch("/messages/batches", apiKey, {
    method: "POST",
    body: { requests },
  })
  return result.id as string
}

async function pollBatch(batchId: string, apiKey: string): Promise<void> {
  while (true) {
    const status = await apiFetch(`/messages/batches/${batchId}`, apiKey)
    const counts = status.request_counts ?? {}
    const total = counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired
    const done = counts.succeeded + counts.errored + counts.canceled + counts.expired
    console.log(`  Batch ${batchId}: ${done}/${total} done (${counts.succeeded} ok, ${counts.errored} err)`)
    if (status.processing_status === "ended") return
    await new Promise(r => setTimeout(r, 30_000))
  }
}

async function* streamResults(batchId: string, apiKey: string): AsyncGenerator<{ custom_id: string; result: { type: string; message?: { content: Array<{ type: string; text: string }> } } }> {
  const resp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  })
  if (!resp.ok) throw new Error(`Failed to fetch results: ${resp.status}`)
  const text = await resp.text()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    yield JSON.parse(line)
  }
}

async function main() {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY required. Run with: deno run --env=.env --allow-read --allow-write --allow-net --allow-env --allow-run infer_prereqs.ts")
    Deno.exit(1)
  }

  console.log("Loading skills.tsv + taxonomy.tsv...")
  const skillRows = parseTsvRows(await Deno.readTextFile("skills.tsv"))
  let taxLen = 0
  try {
    const taxRows = parseTsvRows(await Deno.readTextFile("taxonomy.tsv"))
    for (const r of taxRows) skillRows.push(r)
    taxLen = taxRows.length
  } catch { /* ok */ }
  console.log(`  ${skillRows.length} skills (${taxLen} from taxonomy)`)

  console.log("Loading prereqs.tsv + taxonomy_edges.tsv...")
  const prereqRows = parseTsvRows(await Deno.readTextFile("prereqs.tsv"))
  try {
    const tax = parseTsvRows(await Deno.readTextFile("taxonomy_edges.tsv"))
    for (const r of tax) prereqRows.push(r)
  } catch { /* ok */ }
  const existingEdges = new Set(prereqRows.map(r => canonicalKey(r.skill_id, r.prereq_id)))
  console.log(`  ${prereqRows.length} existing edges`)

  let cache: Cache = { pairs: {}, version: 1 }
  try {
    const raw = JSON.parse(await Deno.readTextFile(CACHE_PATH))
    if (!raw.pairs || typeof raw.pairs !== "object") throw new Error("Cache missing 'pairs' object")
    cache = raw
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) console.log("  No existing cache, starting fresh")
    else throw new Error(`Failed to load cache at ${CACHE_PATH}: ${e}`)
  }
  console.log(`  ${Object.keys(cache.pairs).length} cached LLM results`)

  // Group skills by tag
  const tagGroups = new Map<string, Array<{ id: string; label: string }>>()
  for (const row of skillRows) {
    if (!row.tags || !row.label) continue
    for (const tag of row.tags.split(";").map(t => t.trim()).filter(Boolean)) {
      let group = tagGroups.get(tag)
      if (!group) { group = []; tagGroups.set(tag, group) }
      group.push({ id: row.id, label: row.label })
    }
  }

  // Find candidate pairs: cross-source pairs within each tag group
  console.log("\nFinding candidate pairs...")
  const candidates: [string, string, string, string][] = []
  const seen = new Set<string>()
  let groupsProcessed = 0
  const MAX_TOTAL = 100_000
  const MAX_PER_GROUP = 5_000

  // Skip the bulk-source tags themselves (lcsh, dbpedia) — only domain tags enable cross-source pairing
  const SKIP_TAGS = new Set(["lcsh", "dbpedia"])
  const eligibleGroups = [...tagGroups.entries()]
    .filter(([t, m]) => !SKIP_TAGS.has(t) && m.length >= 5 && m.length <= 200_000)
    .sort((a, b) => a[1].length - b[1].length)

  for (const [tag, members] of eligibleGroups) {
    if (candidates.length >= MAX_TOTAL) break
    groupsProcessed++
    let groupCount = 0

    // Shuffle so cross-source pairs are reached without iterating all same-source pairs first
    const shuffled = [...members]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    for (let i = 0; i < shuffled.length && groupCount < MAX_PER_GROUP; i++) {
      const srcA = shuffled[i].id.split(".")[0]
      for (let j = i + 1; j < shuffled.length && groupCount < MAX_PER_GROUP; j++) {
        const srcB = shuffled[j].id.split(".")[0]
        if (srcA === srcB) continue
        const a = shuffled[i], b = shuffled[j]
        const key = canonicalKey(a.id, b.id)
        if (seen.has(key) || existingEdges.has(key) || cache.pairs[key]) continue

        const d = dice(a.label, b.label)
        if (d >= 0.3 && d <= 0.8) {
          seen.add(key)
          candidates.push([a.id, a.label, b.id, b.label])
          groupCount++
        }
      }
    }
    if (groupCount) console.log(`  ${tag}: ${groupCount} pairs`)
  }
  console.log(`  ${groupsProcessed} tag groups, ${candidates.length} candidate pairs`)

  if (!candidates.length) {
    console.log("No new candidates to process.")
    return
  }

  // Split candidates into batches of BATCH_SIZE pairs each
  const requestBatches: Array<{ idx: number; pairs: [string, string, string, string][] }> = []
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    requestBatches.push({ idx: requestBatches.length, pairs: candidates.slice(i, i + BATCH_SIZE) })
  }
  console.log(`\n${requestBatches.length} requests (${BATCH_SIZE} pairs each)`)

  // Submit in chunks of API_BATCH_SIZE via Batches API
  const batchIds: Array<{ id: string; startIdx: number; endIdx: number }> = []
  for (let i = 0; i < requestBatches.length; i += API_BATCH_SIZE) {
    const chunk = requestBatches.slice(i, i + API_BATCH_SIZE)
    console.log(`\nSubmitting batch ${batchIds.length + 1} (${chunk.length} requests)...`)
    const id = await submitBatch(chunk, apiKey)
    batchIds.push({ id, startIdx: i, endIdx: i + chunk.length })
    console.log(`  Batch ID: ${id}`)
  }

  // Poll until all complete
  for (const { id } of batchIds) {
    console.log(`\nPolling batch ${id}...`)
    await pollBatch(id, apiKey)
  }

  // Collect results
  let newPrereqs = 0
  let errors = 0
  for (const { id, startIdx } of batchIds) {
    console.log(`\nCollecting results from ${id}...`)
    for await (const item of streamResults(id, apiKey)) {
      if (item.result.type !== "succeeded" || !item.result.message) {
        errors++
        continue
      }
      const textBlock = item.result.message.content.find(c => c.type === "text")
      if (!textBlock?.text) { errors++; continue }

      const batchIdx = parseInt(item.custom_id.replace("batch_", ""))
      const pairs = requestBatches[startIdx + batchIdx]?.pairs
      if (!pairs) { errors++; continue }

      try {
        const results = parseDirections(textBlock.text, pairs)
        for (const [key, entry] of Object.entries(results)) {
          cache.pairs[key] = entry
          if (entry.direction !== "none") newPrereqs++
        }
      } catch (e) {
        errors++
        console.error(`  Failed to parse batch_${batchIdx}: ${e}`)
      }
    }
  }

  await Deno.writeTextFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n")

  const totalPrereqs = Object.values(cache.pairs).filter(p => p.direction !== "none").length
  if (errors) console.error(`\nWARNING: ${errors} requests failed`)
  console.log(`\nDone. ${totalPrereqs} total prereqs in cache (${newPrereqs} new this run).`)
  console.log(`Cache written to ${CACHE_PATH}`)
  console.log(`\nNext: run main.ts to integrate LLM prereqs into the pipeline.`)
}

main()
