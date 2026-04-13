// deno run --env=.env --allow-env --allow-read --allow-write --allow-net eval_edges.ts
// Stratified Haiku eval of spine_prereqs.tsv precision by source.
// Samples N edges per source, asks Claude if B is a genuine prereq of A,
// caches results in data/eval_edges.json, writes eval_report.tsv with Wilson 95% CI.

const SKILLS = "spine_skills.tsv"
const EDGES = "spine_prereqs.tsv"
const CACHE = "data/eval_edges.json"
const REPORT = "eval_report.tsv"

const N_PER_SOURCE = 50
const CALIB_N = 30
const BATCH_SIZE = 50

// Sources to evaluate. Curated sources included for calibration (should score ≥0.9).
const TARGET_SOURCES = [
  "semantic_bridge", "llm", "junyi_logs", "assistments_logs", "mooccubex",
  "course_skill_atlas", "esco_optional", "wikidata_p279", "opensalt",
]
const CALIBRATION_SOURCES = ["khan", "alcpl", "metacademy", "esco"]

type Sample = { key: string; skill_id: string; prereq_id: string; source: string; skill_label: string; prereq_label: string }
type Cache = { results: Record<string, { verdict: "yes" | "no" | "unclear" }> }

const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
if (!apiKey) { console.error("ANTHROPIC_API_KEY required"); Deno.exit(1) }

// ---- load skills for labels ----
const labelOf = new Map<string, string>()
{
  const text = await Deno.readTextFile(SKILLS)
  const lines = text.split("\n")
  const h = lines[0].split("\t")
  const iId = h.indexOf("id"), iLbl = h.indexOf("label")
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t"); if (!p[iId]) continue
    labelOf.set(p[iId], p[iLbl] ?? "")
  }
}

// ---- stratified sample from spine_prereqs.tsv ----
function sampleBySource(path: string, sources: string[], n: number): Sample[] {
  const bySrc = new Map<string, Sample[]>()
  for (const s of sources) bySrc.set(s, [])
  const text = Deno.readTextFileSync(path)
  const lines = text.split("\n")
  const h = lines[0].split("\t")
  const iS = h.indexOf("skill_id"), iP = h.indexOf("prereq_id"), iSrc = h.indexOf("source")
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t"); if (p.length < 3) continue
    const src = p[iSrc]
    if (!bySrc.has(src)) continue
    const sl = labelOf.get(p[iS]) ?? ""
    const pl = labelOf.get(p[iP]) ?? ""
    if (!sl || !pl) continue
    bySrc.get(src)!.push({
      key: `${p[iS]}|${p[iP]}`, skill_id: p[iS], prereq_id: p[iP], source: src,
      skill_label: sl, prereq_label: pl,
    })
  }
  const out: Sample[] = []
  for (const [src, rows] of bySrc) {
    // deterministic shuffle by hash on key
    rows.sort((a, b) => (a.key < b.key ? -1 : 1))
    // Fisher-Yates with fixed seed
    let seed = 42
    for (let i = rows.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const j = seed % (i + 1)
      ;[rows[i], rows[j]] = [rows[j], rows[i]]
    }
    for (const r of rows.slice(0, n)) out.push(r)
    console.log(`  ${src}: sampled ${Math.min(n, rows.length)}/${rows.length}`)
  }
  return out
}

console.log("Sampling edges...")
const target = sampleBySource(EDGES, TARGET_SOURCES, N_PER_SOURCE)
const calib = sampleBySource(EDGES, CALIBRATION_SOURCES, CALIB_N)
const all = [...target, ...calib]
console.log(`total samples: ${all.length}`)

// ---- load cache ----
let cache: Cache = { results: {} }
try { cache = JSON.parse(await Deno.readTextFile(CACHE)) } catch { /* fresh */ }
const todo = all.filter(s => !cache.results[s.key])
console.log(`cached: ${all.length - todo.length}, todo: ${todo.length}`)

// ---- Batches API ----
async function apiFetch(path: string, opts: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`https://api.anthropic.com/v1${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01",
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  })
  if (!r.ok) throw new Error(`${opts.method ?? "GET"} ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

function makePrompt(batch: Sample[]): string {
  const listing = batch.map((s, i) => `${i + 1}. Skill: "${s.skill_label}"\n   Claimed prereq: "${s.prereq_label}"`).join("\n")
  return `You are auditing a prerequisite graph. For each numbered pair, decide whether the claimed prereq is a genuine learning prerequisite of the skill — i.e., a learner should meaningfully master the prereq before the skill. Use your judgment for borderline cases (broader concepts that aren't strictly sequenced count as "unclear", not "yes").

Respond with ONLY a JSON array of verdicts, one per pair, each one of: "yes", "no", "unclear".

${listing}`
}

function parseVerdicts(text: string, batch: Sample[]): Record<string, "yes" | "no" | "unclear"> {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) throw new Error(`no JSON array: ${text.slice(0, 200)}`)
  const arr = JSON.parse(m[0]) as string[]
  const out: Record<string, "yes" | "no" | "unclear"> = {}
  for (let i = 0; i < batch.length && i < arr.length; i++) {
    const v = (arr[i] ?? "").toLowerCase().trim()
    out[batch[i].key] = (v === "yes" || v === "no" || v === "unclear") ? v : "unclear"
  }
  return out
}

if (todo.length) {
  const reqBatches: Sample[][] = []
  for (let i = 0; i < todo.length; i += BATCH_SIZE) reqBatches.push(todo.slice(i, i + BATCH_SIZE))
  console.log(`submitting ${reqBatches.length} requests...`)

  const requests = reqBatches.map((b, idx) => ({
    custom_id: `eval_${idx}`,
    params: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: makePrompt(b) }],
    },
  }))
  const submit = await apiFetch("/messages/batches", { method: "POST", body: { requests } })
  const batchId = submit.id as string
  console.log(`batch id: ${batchId}`)

  while (true) {
    const s = await apiFetch(`/messages/batches/${batchId}`)
    const c = s.request_counts ?? {}
    console.log(`  ${c.succeeded ?? 0}/${(c.processing ?? 0) + (c.succeeded ?? 0) + (c.errored ?? 0)} done`)
    if (s.processing_status === "ended") break
    await new Promise(r => setTimeout(r, 15000))
  }

  const resp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  })
  const text = await resp.text()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const item = JSON.parse(line) as { custom_id: string; result: { type: string; message?: { content: Array<{ type: string; text: string }> } } }
    if (item.result.type !== "succeeded" || !item.result.message) continue
    const txt = item.result.message.content.find(c => c.type === "text")?.text ?? ""
    const idx = parseInt(item.custom_id.replace("eval_", ""))
    const b = reqBatches[idx]
    try {
      const verdicts = parseVerdicts(txt, b)
      for (const [key, v] of Object.entries(verdicts)) cache.results[key] = { verdict: v }
    } catch (e) { console.error(`  batch ${idx}: ${(e as Error).message}`) }
  }
  await Deno.writeTextFile(CACHE, JSON.stringify(cache, null, 2) + "\n")
  console.log(`wrote cache (${Object.keys(cache.results).length} results)`)
}

// ---- tally ----
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0]
  const p = k / n, d = 1 + z * z / n
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return [(c - m) / d, (c + m) / d]
}

const bySrc = new Map<string, { yes: number; no: number; unclear: number; total: number; fps: Sample[] }>()
for (const s of all) {
  const r = cache.results[s.key]; if (!r) continue
  const b = bySrc.get(s.source) ?? { yes: 0, no: 0, unclear: 0, total: 0, fps: [] }
  b.total++; b[r.verdict]++
  if (r.verdict === "no") b.fps.push(s)
  bySrc.set(s.source, b)
}

const report: string[] = ["source\tn\tprecision\tci_low\tci_high\tyes\tno\tunclear"]
for (const [src, b] of [...bySrc.entries()].sort()) {
  const p = b.total ? b.yes / b.total : 0
  const [lo, hi] = wilson(b.yes, b.total)
  report.push(`${src}\t${b.total}\t${p.toFixed(3)}\t${lo.toFixed(3)}\t${hi.toFixed(3)}\t${b.yes}\t${b.no}\t${b.unclear}`)
}
await Deno.writeTextFile(REPORT, report.join("\n") + "\n")
console.log("\n=== PRECISION BY SOURCE ===")
for (const l of report) console.log(l)

console.log("\n=== SAMPLE FALSE POSITIVES (up to 5 per source) ===")
for (const [src, b] of bySrc) {
  if (!b.fps.length) continue
  console.log(`\n${src} (${b.fps.length} flagged):`)
  for (const s of b.fps.slice(0, 5)) {
    console.log(`  "${s.skill_label}" <- "${s.prereq_label}"`)
  }
}
