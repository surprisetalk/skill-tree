const DATA = "./data"

async function extractMooccubexLabels(): Promise<Set<string>> {
  const domains = ["cs", "math", "psy"]
  const labels = new Set<string>()
  for (const domain of domains) {
    const path = `${DATA}/mooccubex/${domain}.json`
    let text: string
    try {
      text = await Deno.readTextFile(path)
    } catch {
      const proc = new Deno.Command("gunzip", { args: ["-k", `${path}.gz`], stdout: "piped", stderr: "piped" })
      const { success } = await proc.output()
      if (!success) { console.error(`Failed to decompress ${domain}.json.gz`); continue }
      text = await Deno.readTextFile(path)
    }
    for (const line of text.split("\n").filter(l => l.trim())) {
      try {
        const obj = JSON.parse(line) as { c1: string; c2: string }
        if (obj.c1) labels.add(obj.c1)
        if (obj.c2) labels.add(obj.c2)
      } catch { /* skip */ }
    }
  }
  return labels
}

async function translateBatch(labels: string[], apiKey: string): Promise<Record<string, string>> {
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `Translate each Chinese term/phrase to English. These are academic skill/concept names from education datasets. Return ONLY a JSON object mapping each input to its English translation. Be concise and precise — use standard English terminology (e.g. "virtual memory", "convolution", not verbose descriptions).

Terms:
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    }],
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  })

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get("retry-after") || "60")
    console.log(`  Rate limited, waiting ${retryAfter}s...`)
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return translateBatch(labels, apiKey)
  }
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`API error ${resp.status}: ${err}`)
  }

  const apiResult = await resp.json() as { content: Array<{ type: string; text: string }> }
  const text = apiResult.content.find(c => c.type === "text")?.text ?? ""

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`)

  const raw = JSON.parse(jsonMatch[0]) as Record<string, string>

  // Normalize keys: API may return numbered keys like "1. 鉴别力" or just the number "1"
  const out: Record<string, string> = {}
  const byIndex = new Map<number, string>()
  for (const [k, v] of Object.entries(raw)) {
    if (labels.includes(k)) { out[k] = v; continue }
    const stripped = k.replace(/^\d+[\.\)\]:：、\s]+\s*/, "").trim()
    if (labels.includes(stripped)) { out[stripped] = v; continue }
    const idx = parseInt(k)
    if (!isNaN(idx) && idx >= 1 && idx <= labels.length) byIndex.set(idx, v)
  }
  for (const [idx, v] of byIndex) {
    const label = labels[idx - 1]
    if (label && !(label in out)) out[label] = v
  }
  return out
}

async function translateAndWrite(labels: Set<string>, outputPath: string, apiKey: string) {
  // Load existing translations if present
  let existing: Record<string, string> = {}
  try {
    existing = JSON.parse(await Deno.readTextFile(outputPath))
  } catch { /* no cache */ }

  const missing = [...labels].filter(l => !(l in existing))
  if (!missing.length) {
    console.log(`${outputPath}: all ${labels.size} labels already translated`)
    return
  }
  console.log(`${outputPath}: ${missing.length} labels to translate (${Object.keys(existing).length} cached)`)

  const BATCH_SIZE = 100
  const translations: Record<string, string> = { ...existing }

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(missing.length / BATCH_SIZE)} (${batch.length} terms)...`)
    const result = await translateBatch(batch, apiKey)

    let matched = 0
    for (const label of batch) {
      if (label in result) {
        translations[label] = result[label]
        matched++
      } else {
        // Try to find it — API might have slightly reformatted the key
        for (const [k, v] of Object.entries(result)) {
          if (k.trim() === label.trim()) { translations[label] = v as string; matched++; break }
        }
      }
    }
    if (matched < batch.length) {
      console.error(`  WARNING: only ${matched}/${batch.length} translations matched`)
      // Fill missing with original label
      for (const label of batch) {
        if (!(label in translations)) translations[label] = label
      }
    }

    // Write after each batch for crash recovery
    await Deno.writeTextFile(outputPath, JSON.stringify(translations, null, 2) + "\n")
  }

  console.log(`${outputPath}: ${Object.keys(translations).length} total translations`)
}

async function main() {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY environment variable required")
    Deno.exit(1)
  }

  console.log("Extracting MOOCCubeX labels...")
  const moocLabels = await extractMooccubexLabels()
  console.log(`  ${moocLabels.size} unique labels`)

  await translateAndWrite(moocLabels, `${DATA}/mooccubex/translations.json`, apiKey)

  console.log("Done.")
}

main()
