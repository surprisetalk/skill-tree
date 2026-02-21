const DATA = "./data"

type Skill = {
  id: string
  ext_ids: string[]
  ext_urls: string[]
  label: string
  description: string
  tags: string[]
  grade_start: number | null
  grade_end: number | null
}
type Prereq = { skill_id: string; prereq_id: string; source: string }
type Level = { skill_id: string; lvl: Record<string, number> }
type Result = { skills: Skill[]; prereqs: Prereq[]; levels: Level[] }

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

function lastSeg(uri: string): string {
  return uri.split("/").pop()!
}

function parseGrade(s: string): number | null {
  if (!s) return null
  const up = s.toUpperCase().trim()
  if (up === "PK" || up === "PRE-K") return 0
  if (up === "KG" || up === "K") return 0
  if (up === "HS") return 9
  const n = parseInt(up)
  return isNaN(n) ? null : n
}

function parseTsvRows(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter(l => l.trim())
  if (!lines.length) return []
  const hdr = lines[0].split("\t")
  return lines.slice(1).map(l => {
    const vals = l.split("\t")
    const row: Record<string, string> = {}
    for (let i = 0; i < hdr.length; i++) row[hdr[i]] = vals[i] ?? ""
    return row
  })
}

// State-machine CSV parser handling quoted fields with commas and newlines
function parseCsvRows(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQ = false
      else field += c
    } else {
      if (c === '"') inQ = true
      else if (c === ",") { row.push(field); field = "" }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = [] }
      else if (c === "\r") { /* skip */ }
      else field += c
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  if (!rows.length) return []
  const hdr = rows[0]
  return rows.slice(1).filter(r => r.length >= hdr.length).map(r => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < hdr.length; i++) obj[hdr[i]] = r[i] ?? ""
    return obj
  })
}

function sanitize(s: string): string {
  // decode HTML entities first so encoded tags get stripped
  let t = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  t = t.replace(/<[^>]*>/g, " ")
  t = t.replace(/\[cite_start\]/g, "")
  t = t.replace(/\*\*/g, "")
  t = t.replace(/[\t\n\r]/g, " ")
  t = t.replace(/\s+/g, " ").trim()
  return t
}

function sanitizeId(s: string): string {
  return s.replace(/[\t\n\r; ]/g, "_").trim()
}

function isValidLabel(s: string): boolean {
  if (!s || !s.trim()) return false
  if (/^\(.*\)$/.test(s.trim())) return false
  if (s.length > 1500) return false
  return true
}

const NON_ENGLISH_JURISDICTIONS = new Set([
  "québec", "quebec", "québec (français)", "quebec (english)",
  "puerto rico", "guam", "american samoa",
  "ontario", "ontario (français)",
  "new brunswick (français)",
  "colombie-britannique / british columbia (français)",
  "alberta (français)",
])

const TAG_ALIASES: Record<string, string> = {
  psy: "psychology", cs: "computer science", ml: "machine learning",
  ai: "artificial intelligence", k12: "k-12", dl: "deep learning",
  cv: "computer vision", nlp: "natural language processing",
}

function normalizeTag(s: string): string {
  let t = s.toLowerCase().trim()
  t = t.replace(/^\[(?:archive|archived)\]\s*/i, "")
  t = t.replace(/\s*\(\d{4}(?:-\d{0,4})?\)\s*$/, "")
  t = t.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim()
  t = t.replace(/\bstandards?\b/g, "").replace(/\s+/g, " ").trim()
  return TAG_ALIASES[t] ?? t
}

function skill(id: string, label: string, opts?: Partial<Skill>): Skill {
  const tags = (opts?.tags ?? []).map(normalizeTag).filter(t => t.length > 0)
  return {
    id, ext_ids: [], ext_urls: [], label: sanitize(label), description: "",
    tags: [], grade_start: null, grade_end: null, ...opts,
    tags,
    ...(opts?.description ? { description: sanitize(opts.description) } : {}),
  }
}

// 1. Khan Academy
async function parseKhan(): Promise<Result> {
  const text = await Deno.readTextFile(`${DATA}/khanacademy/khandata.tsv`)
  const rows = parseTsvRows(text)
  const codeToSlug = new Map<string, string>()
  for (const r of rows) if (r["Code"] && r["Data Name"]) codeToSlug.set(r["Code"], r["Data Name"])

  const skills: Skill[] = []
  const prereqs: Prereq[] = []
  for (const r of rows) {
    const slug = r["Data Name"]
    if (!slug) continue
    const id = `khan.${slug}`
    skills.push(skill(id, r["Display Name"] || slug, { tags: ["math"] }))
    const pStr = r["Prereq(s)"] || ""
    for (const tok of pStr.split(";").map(s => s.trim()).filter(Boolean)) {
      if (tok === "root") continue
      const resolved = /^\d+$/.test(tok) ? codeToSlug.get(tok) : tok
      if (resolved) prereqs.push({ skill_id: id, prereq_id: `khan.${resolved}`, source: "khan" })
    }
  }
  return { skills, prereqs, levels: [] }
}

// 2. AL-CPL
async function parseAlcpl(): Promise<Result> {
  const domains = ["data_mining", "geometry", "physics", "precalculus"]
  const skills: Skill[] = []
  const prereqs: Prereq[] = []

  for (const domain of domains) {
    const pairsText = await Deno.readTextFile(`${DATA}/al-cpl/data/${domain}.pairs`)
    const concepts = new Set<string>()
    for (const line of pairsText.split("\n").filter(l => l.trim())) {
      const [a, b] = line.split(",")
      if (a) concepts.add(a.trim())
      if (b) concepts.add(b.trim())
    }

    const preqsText = await Deno.readTextFile(`${DATA}/al-cpl/data/${domain}.preqs`)
    for (const line of preqsText.split("\n").filter(l => l.trim())) {
      const [pre, tgt] = line.split(",")
      if (pre && tgt) {
        prereqs.push({
          skill_id: `alcpl.${domain}.${tgt.trim()}`,
          prereq_id: `alcpl.${domain}.${pre.trim()}`,
          source: "alcpl",
        })
      }
    }

    for (const c of concepts) {
      const id = `alcpl.${domain}.${c}`
      skills.push(skill(id, c.replace(/_/g, " "), {
        tags: [domain],
        ext_urls: [`https://en.wikipedia.org/wiki/${c}`],
      }))
    }
  }
  return { skills, prereqs, levels: [] }
}

// 3. Metacademy
async function parseMetacademy(): Promise<Result> {
  const base = `${DATA}/metacademy/metacademy-content/concepts`
  const skills: Skill[] = []
  const prereqs: Prereq[] = []

  for await (const entry of Deno.readDir(base)) {
    if (!entry.isDirectory) continue
    const name = entry.name
    const id = `metacademy.${name}`
    let label = name.replace(/_/g, " ")
    try { label = (await Deno.readTextFile(`${base}/${name}/title.txt`)).trim() || label } catch { /* ok */ }

    let description = ""
    try { description = (await Deno.readTextFile(`${base}/${name}/summary.txt`)).trim() } catch { /* ok */ }

    skills.push(skill(id, label, { tags: ["ml", "ai"], description }))

    try {
      const deps = await Deno.readTextFile(`${base}/${name}/dependencies.txt`)
      for (const line of deps.split("\n")) {
        const m = line.match(/^tag:\s*(.+)/)
        if (m) prereqs.push({ skill_id: id, prereq_id: `metacademy.${m[1].trim()}`, source: "metacademy" })
      }
    } catch { /* ok */ }
  }
  return { skills, prereqs, levels: [] }
}

// 4. O*NET (generic for Skills, Knowledge, Abilities)
async function parseOnet(file: string, category: string): Promise<Result> {
  const text = await Deno.readTextFile(`${DATA}/onet/${file}`)
  const rows = parseTsvRows(text)

  const groups = new Map<string, { name: string; lvVals: number[] }>()
  for (const r of rows) {
    const eid = r["Element ID"]
    const ename = r["Element Name"]
    if (!eid || !ename) continue
    if (!groups.has(eid)) groups.set(eid, { name: ename, lvVals: [] })
    if (r["Scale ID"] === "LV") {
      const v = parseFloat(r["Data Value"])
      if (!isNaN(v)) groups.get(eid)!.lvVals.push(v)
    }
  }

  const skills: Skill[] = []
  const levels: Level[] = []
  for (const [eid, g] of groups) {
    const id = `onet.${category}.${eid}`
    skills.push(skill(id, g.name, { tags: ["onet", category] }))
    if (g.lvVals.length) {
      const mean = g.lvVals.reduce((a, b) => a + b, 0) / g.lvVals.length
      levels.push({ skill_id: id, lvl: { [slug(g.name)]: mean } })
    }
  }
  return { skills, prereqs: [], levels }
}

// 5. ESCO
async function parseEsco(): Promise<Result> {
  const skillsText = await Deno.readTextFile(`${DATA}/esco/skills_en.csv`)
  const skillRows = parseCsvRows(skillsText)

  const skills: Skill[] = []
  const uriToId = new Map<string, string>()
  for (const r of skillRows) {
    const uri = r["conceptUri"]
    if (!uri) continue
    const id = `esco.${lastSeg(uri)}`
    uriToId.set(uri, id)
    skills.push(skill(id, r["preferredLabel"] || "", {
      tags: [r["skillType"] || "skill"].map(t => t.replace(/\//g, "-")),
      ext_urls: [uri],
      description: r["description"] || r["definition"] || "",
      ext_ids: [r["conceptUri"]],
    }))
  }

  const relsText = await Deno.readTextFile(`${DATA}/esco/skillSkillRelations_en.csv`)
  const relRows = parseCsvRows(relsText)
  const prereqs: Prereq[] = []
  for (const r of relRows) {
    if (r["relationType"] !== "essential") continue
    const origId = uriToId.get(r["originalSkillUri"])
    const relId = uriToId.get(r["relatedSkillUri"])
    if (origId && relId) prereqs.push({ skill_id: origId, prereq_id: relId, source: "esco" })
  }
  return { skills, prereqs, levels: [] }
}

// 6. Lightcast
async function parseLightcast(): Promise<Result> {
  const json = JSON.parse(await Deno.readTextFile(`${DATA}/lightcast/skills.json`))
  const skills: Skill[] = json.data.map((d: { id: string; name: string; infoUrl?: string; type?: { name: string } }) =>
    skill(`lightcast.${d.id}`, d.name, {
      tags: [slug(d.type?.name || "skill")],
      ext_ids: [d.id],
      ext_urls: d.infoUrl ? [d.infoUrl] : [],
    })
  )
  return { skills, prereqs: [], levels: [] }
}

async function loadTranslations(path: string): Promise<Map<string, string>> {
  try {
    const data = JSON.parse(await Deno.readTextFile(path)) as Record<string, string>
    return new Map(Object.entries(data))
  } catch {
    return new Map()
  }
}

// 7. MOOCCubeX
async function parseMooccubex(): Promise<Result> {
  const domains = ["cs", "math", "psy"]
  const skills: Skill[] = []
  const prereqs: Prereq[] = []
  const tr = await loadTranslations(`${DATA}/mooccubex/translations.json`)
  if (tr.size) console.log(`  Loaded ${tr.size} MOOCCubeX translations`)

  for (const domain of domains) {
    const path = `${DATA}/mooccubex/${domain}.json`
    try { await Deno.stat(path) } catch {
      console.error(`MOOCCubeX ${domain}.json not found (may be gzipped only), skipping`)
      continue
    }
    const text = await Deno.readTextFile(path)
    const concepts = new Map<string, string>() // concept name -> id
    const preqEdges: [string, string][] = []

    for (const line of text.split("\n").filter(l => l.trim())) {
      let obj: { c1: string; c2: string; ground_truth: number }
      try { obj = JSON.parse(line) } catch { continue }
      const c1 = obj.c1, c2 = obj.c2
      const id1 = `mooccubex.${domain}.${c1}`, id2 = `mooccubex.${domain}.${c2}`
      concepts.set(c1, id1)
      concepts.set(c2, id2)
      if (obj.ground_truth === 1) preqEdges.push([id2, id1]) // c1 prereq of c2
    }

    for (const [name, id] of concepts) {
      const label = tr.get(name) ?? name
      const ext_ids = label !== name ? [name] : []
      skills.push(skill(id, label, { tags: [domain], ext_ids }))
    }
    for (const [sid, pid] of preqEdges) {
      prereqs.push({ skill_id: sid, prereq_id: pid, source: "mooccubex" })
    }
  }
  return { skills, prereqs, levels: [] }
}

// 8. ASSISTments
async function parseAssistments(): Promise<Result> {
  const path = `${DATA}/assistments/skill_builder_data.csv`
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch {
    const proc = new Deno.Command("gunzip", { args: ["-c", `${path}.gz`], stdout: "piped", stderr: "piped" })
    const { stdout, success } = await proc.output()
    if (!success) throw new Error("Failed to decompress assistments data")
    text = new TextDecoder().decode(stdout)
  }
  const rows = parseCsvRows(text)
  const seen = new Map<string, string>()
  for (const r of rows) {
    const sid = r["skill_id"], sname = r["skill_name"]
    if (sid && sname && !seen.has(sid)) seen.set(sid, sname)
  }
  const skills = [...seen].map(([sid, sname]) =>
    skill(`assistments.${sid}`, sname, { tags: ["math", "k12"] })
  )
  return { skills, prereqs: [], levels: [] }
}

// 9. Junyi
async function parseJunyi(): Promise<Result> {
  const text = await Deno.readTextFile(`${DATA}/junyi/Info_Content.csv`)
  const rows = parseCsvRows(text)
  const tr = await loadTranslations(`${DATA}/junyi/translations.json`)
  if (tr.size) console.log(`  Loaded ${tr.size} Junyi translations`)
  const gradeMap: Record<string, [number, number]> = {
    elementary: [1, 6], junior: [7, 9], senior: [10, 12],
  }
  const skills = rows.map(r => {
    const grades = gradeMap[r["learning_stage"]] ?? [null, null]
    const origName = r["content_pretty_name"] || ""
    const label = tr.get(origName) ?? origName
    const ext_ids = label !== origName && origName ? [origName] : []
    return skill(`junyi.${r["ucid"]}`, label, {
      tags: [r["subject"], r["learning_stage"]].filter(Boolean),
      grade_start: grades[0], grade_end: grades[1],
      ext_ids,
    })
  }).filter(s => s.label)
  return { skills, prereqs: [], levels: [] }
}

// 10. Common Standards Project (all jurisdictions)
async function parseCsp(): Promise<Result> {
  const jText = await Deno.readTextFile(`${DATA}/common-standards-project/jurisdictions.json`)
  const jurisdictions: { id: string; title: string; type: string }[] = JSON.parse(jText)
  const skills: Skill[] = []

  for (const j of jurisdictions) {
    if (NON_ENGLISH_JURISDICTIONS.has(j.title.toLowerCase())) continue
    // deno-lint-ignore no-explicit-any
    let data: any
    try {
      data = JSON.parse(await Deno.readTextFile(`${DATA}/common-standards-project/${j.id}.json`))
    } catch { continue }

    // standardSets with actual standards are at the root level, not inside jurisdiction
    const sets: Array<{
      id: string; title: string; subject?: string; educationLevels?: string[]
      standards?: Record<string, {
        id: string; statementNotation?: string; description?: string
        asnIdentifier?: string; parentId?: string
      }>
    }> = data.standardSets ?? []

    for (const ss of sets) {
      if (!ss.standards) continue
      const gradeNums = (ss.educationLevels || []).map(parseGrade).filter((g): g is number => g !== null)
      const gStart = gradeNums.length ? Math.min(...gradeNums) : null
      const gEnd = gradeNums.length ? Math.max(...gradeNums) : null

      // Only emit leaf standards (those that are not parents of other standards)
      const parentIds = new Set(Object.values(ss.standards).map(s => s.parentId).filter(Boolean))

      for (const std of Object.values(ss.standards)) {
        if (parentIds.has(std.id)) continue
        const label = sanitize(std.description || std.statementNotation || "")
        if (!isValidLabel(label)) continue
        const notation = std.statementNotation ? sanitizeId(std.statementNotation) : ""
        const id = notation ? `csp.${notation}` : `csp.${sanitizeId(std.id)}`
        const extIds = [std.asnIdentifier, std.id].filter(Boolean) as string[]
        skills.push(skill(id, label, {
          ext_ids: extIds,
          tags: [ss.subject].filter(Boolean) as string[],
          grade_start: gStart, grade_end: gEnd,
        }))
      }
    }
  }
  return { skills, prereqs: [], levels: [] }
}

// 11. OpenSALT
async function parseOpensalt(): Promise<Result> {
  const idx: { identifier: string; title: string }[] = JSON.parse(
    await Deno.readTextFile(`${DATA}/opensalt/index.json`)
  )
  const skills: Skill[] = []
  const prereqs: Prereq[] = []

  for (const fw of idx) {
    let data: {
      CFItems?: Array<{
        identifier: string; fullStatement?: string; humanCodingScheme?: string
        CFItemType?: string; educationLevel?: string[]
      }>
      CFAssociations?: Array<{
        associationType: string
        originNodeURI: { identifier: string }
        destinationNodeURI: { identifier: string }
      }>
    }
    try {
      data = JSON.parse(await Deno.readTextFile(`${DATA}/opensalt/${fw.identifier}.json`))
    } catch { continue }

    // Collect parent identifiers from isChildOf associations (leaf-only filtering)
    const parentIdentifiers = new Set<string>()
    for (const assoc of data.CFAssociations ?? []) {
      if (assoc.associationType === "isChildOf")
        parentIdentifiers.add(assoc.destinationNodeURI.identifier)
    }

    const itemIdMap = new Map<string, string>() // opensalt identifier -> our id
    for (const item of data.CFItems ?? []) {
      if (parentIdentifiers.has(item.identifier)) continue
      const code = sanitizeId(item.humanCodingScheme || item.identifier)
      const id = `opensalt.${code}`
      itemIdMap.set(item.identifier, id)
      const label = sanitize(item.fullStatement || code)
      if (!isValidLabel(label)) continue
      const gradeNums = (item.educationLevel || []).map(parseGrade).filter((g): g is number => g !== null)
      skills.push(skill(id, label, {
        tags: [item.CFItemType].filter(Boolean) as string[],
        grade_start: gradeNums.length ? Math.min(...gradeNums) : null,
        grade_end: gradeNums.length ? Math.max(...gradeNums) : null,
      }))
    }

    for (const assoc of data.CFAssociations ?? []) {
      if (assoc.associationType !== "precedes") continue
      const originId = itemIdMap.get(assoc.originNodeURI?.identifier)
      const destId = itemIdMap.get(assoc.destinationNodeURI?.identifier)
      if (originId && destId) prereqs.push({ skill_id: destId, prereq_id: originId, source: "opensalt" })
    }
  }
  return { skills, prereqs, levels: [] }
}

// 12. ASN
async function parseAsn(): Promise<Result> {
  const files = [{ file: "ngss.json", tag: "ngss" }]
  const skills: Skill[] = []

  for (const { file, tag } of files) {
    let data: Record<string, Record<string, Array<{ value: string; type: string }>>>
    try {
      data = JSON.parse(await Deno.readTextFile(`${DATA}/asn/${file}`))
    } catch { continue }

    for (const [uri, props] of Object.entries(data)) {
      const types = props["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"] ?? []
      const isStatement = types.some(t => t.value.includes("Statement"))
      if (!isStatement) continue

      const id = `asn.${lastSeg(uri).replace(".xml", "")}`
      const desc = props["http://purl.org/dc/terms/description"]?.[0]?.value
        ?? props["http://purl.org/dc/elements/1.1/description"]?.[0]?.value ?? ""
      const label = props["http://purl.org/dc/elements/1.1/title"]?.[0]?.value ?? desc.slice(0, 200)
      skills.push(skill(id, label || id, { tags: [tag], description: desc, ext_urls: [uri] }))
    }
  }
  return { skills, prereqs: [], levels: [] }
}

// Merge skills with similar labels, accumulating ext_ids and rewriting prereqs

const ACRONYMS: Record<string, string> = {
  ml: "machine learning", nlp: "natural language processing", ai: "artificial intelligence",
  cs: "computer science", dl: "deep learning", cv: "computer vision", db: "database",
  os: "operating system", rl: "reinforcement learning", nn: "neural network",
  svm: "support vector machine", pca: "principal component analysis", oop: "object oriented programming",
  sql: "structured query language", api: "application programming interface",
  ux: "user experience", ui: "user interface", qa: "quality assurance",
  hr: "human resource", pr: "public relation", it: "information technology",
}

function normalizeLabel(s: string): string {
  let n = s.toLowerCase().trim()
  // strip difficulty-level prefixes from translations (e.g. "[Foundational] ...", "Basic: ...")
  n = n.replace(/^\[(foundational|basic|intermediate|advanced|general)\]\s*/i, "")
  n = n.replace(/^(foundational|basic|intermediate|advanced|general):\s*/i, "")
  // strip pedagogical boilerplate prefixes
  n = n.replace(/^(the )?student(s)? (will |is expected to |can )?(be able to )?/, "")
  n = n.replace(/^demonstrate (an )?understanding of /, "")
  // normalize common abbreviations before punctuation stripping
  n = n.replace(/\be\.?\s*g\.?\b/g, "eg")
  n = n.replace(/\bi\.?\s*e\.?\b/g, "ie")
  n = n.replace(/\bp\.?\s*ex\.?\b/g, "pex")
  // strip parentheticals at end: "repairing (manual/mechanical)" -> "repairing"
  n = n.replace(/\s*\([^)]*\)\s*$/, "")
  // strip all punctuation except internal apostrophes
  n = n.replace(/[^a-z0-9' ]/g, " ")
  // normalize whitespace
  n = n.replace(/\s+/g, " ").trim()
  // strip trailing 's for plurals: "square roots" -> "square root"
  // but not for short words or words where removing s changes meaning
  n = n.replace(/\b(\w{4,})s\b/g, "$1")
  // strip leading articles
  n = n.replace(/^(the |a |an )/, "")
  // expand known acronyms
  if (ACRONYMS[n]) return ACRONYMS[n]
  return n
}

// --- Fuzzy merge utilities ---

const STOPWORDS = new Set(["a","an","the","and","or","of","in","to","for","is","on","at","by","with","as","it","its","be","are","was","were","been","has","have","had","do","does","did","not","no","but","if","so","up","out","all","can","will","may","use","used","using","student","students","able","expected","demonstrate","understanding"])

function charBigrams(s: string): Set<string> {
  const bg = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2))
  return bg
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const x of a) if (b.has(x)) overlap++
  return (2 * overlap) / (a.size + b.size)
}

function sourcePrefix(id: string): string { return id.split(".")[0] }

function buildCandidatePairs(skills: Skill[]): [number, number][] {
  const labels = skills.map(s => normalizeLabel(s.label))
  // Index only short-label, non-CSP-sentence skills
  const eligible = new Set<number>()
  for (let i = 0; i < skills.length; i++) {
    if (labels[i].length > 60) continue
    if (labels[i].length < 3) continue
    eligible.add(i)
  }
  console.log(`  ${eligible.size} skills eligible for fuzzy matching (label <= 60 chars)`)

  // inverted index: token -> skill indices
  const index = new Map<string, number[]>()
  for (const i of eligible) {
    for (const tok of labels[i].split(" ")) {
      if (STOPWORDS.has(tok) || tok.length < 3) continue
      const arr = index.get(tok)
      if (arr) arr.push(i)
      else index.set(tok, [i])
    }
  }

  // Build source prefix index for fast cross-source check
  const srcPrefix = skills.map(s => sourcePrefix(s.id))

  const pairs: [number, number][] = []
  const seen = new Set<number>() // pack pair as single number for memory efficiency
  const MAX_PAIRS = 500_000
  for (const members of index.values()) {
    if (members.length > 100) continue // skip common tokens
    for (let i = 0; i < members.length && pairs.length < MAX_PAIRS; i++) {
      for (let j = i + 1; j < members.length && pairs.length < MAX_PAIRS; j++) {
        const a = members[i], b = members[j]
        // cross-source only
        if (srcPrefix[a] === srcPrefix[b]) continue
        // length ratio filter
        const la = labels[a].length, lb = labels[b].length
        if (Math.min(la, lb) < Math.max(la, lb) * 0.4) continue
        // dedup: pack two 20-bit indices into one number (supports up to 1M skills)
        const key = a < b ? a * 1048576 + b : b * 1048576 + a
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push([a, b])
      }
    }
  }
  return pairs
}

// TF-IDF on labels
function buildTfidf(labels: string[]): { vecs: Map<number, number>[]; vocab: Map<string, number> } {
  const vocab = new Map<string, number>()
  const df = new Map<string, number>()
  const docs: string[][] = []
  for (const l of labels) {
    const toks = l.split(" ").filter(t => !STOPWORDS.has(t) && t.length >= 2)
    docs.push(toks)
    const unique = new Set(toks)
    for (const t of unique) {
      if (!vocab.has(t)) vocab.set(t, vocab.size)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const N = labels.length
  const vecs: Map<number, number>[] = []
  for (const toks of docs) {
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    const vec = new Map<number, number>()
    let norm = 0
    for (const [t, count] of tf) {
      const w = (count / toks.length) * Math.log(N / (df.get(t) ?? 1))
      vec.set(vocab.get(t)!, w)
      norm += w * w
    }
    norm = Math.sqrt(norm)
    if (norm > 0) for (const [k, v] of vec) vec.set(k, v / norm)
    vecs.push(vec)
  }
  return { vecs, vocab }
}

function cosineSparse(a: Map<number, number>, b: Map<number, number>): number {
  let dot = 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of smaller) {
    const bv = larger.get(k)
    if (bv !== undefined) dot += v * bv
  }
  return dot // already L2-normalized
}

// Embedding support: shell out to python3 + sentence_transformers, with disk cache
const EMB_DIM = 384
const EMB_CACHE_DIR = ".cache/embeddings"

async function hashLabels(labels: string[]): Promise<string> {
  const data = new TextEncoder().encode(labels.join("\n"))
  const hash = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

function parseEmbeddingBin(buf: Uint8Array, count: number): Float32Array[] {
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const vecs: Float32Array[] = []
  for (let i = 0; i < count; i++) vecs.push(floats.slice(i * EMB_DIM, (i + 1) * EMB_DIM))
  return vecs
}

async function embedLabels(labels: string[]): Promise<Float32Array[] | null> {
  // Check cache
  const hash = await hashLabels(labels)
  const cachePath = `${EMB_CACHE_DIR}/${hash}.bin`
  try {
    const cached = await Deno.readFile(cachePath)
    const expected = labels.length * EMB_DIM * 4
    if (cached.byteLength === expected) {
      console.log(`  Embedding cache hit: ${cachePath}`)
      return parseEmbeddingBin(cached, labels.length)
    }
    console.log(`  Embedding cache stale (size mismatch), recomputing`)
  } catch { /* cache miss */ }

  const tmpIn = await Deno.makeTempFile({ suffix: ".txt" })
  try {
    await Deno.writeTextFile(tmpIn, labels.join("\n"))
    const script = `
import sys, numpy as np
from sentence_transformers import SentenceTransformer
m = SentenceTransformer('all-MiniLM-L6-v2')
with open(sys.argv[1]) as f: labels = [l.rstrip('\\n') for l in f]
vecs = m.encode(labels, normalize_embeddings=True, show_progress_bar=True).astype(np.float32)
with open(sys.argv[2], 'wb') as f: f.write(vecs.tobytes())
print(f'{len(labels)} labels, {vecs.shape[1]} dims', file=sys.stderr)
`
    const venvPy = `${Deno.cwd()}/.venv/bin/python3`
    let pyCmd = "python3"
    try { await Deno.stat(venvPy); pyCmd = venvPy } catch { /* use system python3 */ }
    await Deno.mkdir(EMB_CACHE_DIR, { recursive: true })
    const proc = new Deno.Command(pyCmd, {
      args: ["-c", script, tmpIn, cachePath],
      stdout: "piped", stderr: "piped",
    })
    const { success, stderr } = await proc.output()
    const errMsg = new TextDecoder().decode(stderr)
    if (!success) {
      console.error(`  Embedding failed: ${errMsg.slice(0, 200)}`)
      return null
    }
    console.log(`  Embedding: ${errMsg.trim()}`)
    const buf = await Deno.readFile(cachePath)
    return parseEmbeddingBin(buf, labels.length)
  } catch (e) {
    console.error(`  Embedding unavailable (python3/sentence_transformers not found): ${e}`)
    return null
  } finally {
    try { await Deno.remove(tmpIn) } catch { /* ok */ }
  }
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

function shouldMerge(diceScore: number, tfidfCos: number, embCos: number | null): boolean {
  if (diceScore >= 0.85) return true
  if (tfidfCos >= 0.75) return true
  if (embCos !== null && embCos >= 0.85) return true
  if (diceScore >= 0.70 && tfidfCos >= 0.55) return true
  if (embCos !== null && embCos >= 0.75 && diceScore >= 0.60) return true
  return false
}

// Union-Find
function ufInit(n: number): number[] { return Array.from({ length: n }, (_, i) => i) }
function ufFind(parent: number[], x: number): number {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
  return x
}
function ufUnion(parent: number[], a: number, b: number) {
  const ra = ufFind(parent, a), rb = ufFind(parent, b)
  if (ra !== rb) parent[ra] = rb
}

async function fuzzyMergePass(ungrouped: Skill[]): Promise<Map<string, string[]>> {
  console.log(`  Fuzzy merge: ${ungrouped.length} candidate skills`)
  const pairs = buildCandidatePairs(ungrouped)
  console.log(`  ${pairs.length} candidate pairs after blocking`)
  if (!pairs.length) return new Map()

  const labels = ungrouped.map(s => normalizeLabel(s.label))
  const bigrams = labels.map(charBigrams)

  // TF-IDF
  const { vecs: tfidfVecs } = buildTfidf(labels)

  // Embeddings (optional)
  console.log("  Computing embeddings...")
  const embVecs = await embedLabels(labels)

  // Score pairs
  const parent = ufInit(ungrouped.length)
  const mergeCounts = { dice: 0, tfidf: 0, embedding: 0, combined: 0 }
  for (const [a, b] of pairs) {
    const d = dice(bigrams[a], bigrams[b])
    const t = cosineSparse(tfidfVecs[a], tfidfVecs[b])
    const e = embVecs ? dotProduct(embVecs[a], embVecs[b]) : null
    if (shouldMerge(d, t, e)) {
      ufUnion(parent, a, b)
      if (d >= 0.95) mergeCounts.dice++
      else if (t >= 0.85) mergeCounts.tfidf++
      else if (e !== null && e >= 0.95) mergeCounts.embedding++
      else mergeCounts.combined++
    }
  }
  console.log(`  Fuzzy merges: ${JSON.stringify(mergeCounts)}`)

  // Collect groups (cap at 20)
  const groups = new Map<number, number[]>()
  for (let i = 0; i < ungrouped.length; i++) {
    const root = ufFind(parent, i)
    const arr = groups.get(root)
    if (arr) arr.push(i)
    else groups.set(root, [i])
  }

  const result = new Map<string, string[]>() // canonical id -> [other ids]
  for (const members of groups.values()) {
    if (members.length < 2) continue
    if (members.length > 20) continue // skip suspiciously large clusters
    const ids = members.map(i => ungrouped[i].id)
    result.set(ids[0], ids.slice(1))
  }
  return result
}

function mergeGroup(group: Skill[], idMap: Map<string, string>): Skill {
  group.sort((a, b) => {
    const aHex = /^csp\.[A-F0-9]{32}$/.test(a.id) ? 1 : 0
    const bHex = /^csp\.[A-F0-9]{32}$/.test(b.id) ? 1 : 0
    if (aHex !== bHex) return aHex - bHex
    return a.id.length - b.id.length
  })
  const canon = group[0]
  const allExtIds = new Set(canon.ext_ids)
  const allExtUrls = new Set(canon.ext_urls)
  const allTags = new Set(canon.tags)
  let gStart = canon.grade_start, gEnd = canon.grade_end
  let desc = canon.description

  for (let i = 1; i < group.length; i++) {
    const s = group[i]
    idMap.set(s.id, canon.id)
    allExtIds.add(s.id)
    for (const x of s.ext_ids) allExtIds.add(x)
    for (const u of s.ext_urls) allExtUrls.add(u)
    for (const t of s.tags) allTags.add(t)
    if (s.grade_start !== null && (gStart === null || s.grade_start < gStart)) gStart = s.grade_start
    if (s.grade_end !== null && (gEnd === null || s.grade_end > gEnd)) gEnd = s.grade_end
    if (!desc && s.description) desc = s.description
    if (!canon.label && s.label) canon.label = s.label
    if (s.label && s.label.length < canon.label.length && canon.label.length > 500 && s.label.length <= 500) canon.label = s.label
  }
  idMap.set(canon.id, canon.id)
  canon.ext_ids = [...allExtIds]
  canon.ext_urls = [...allExtUrls]
  canon.tags = [...allTags]
  canon.grade_start = gStart
  canon.grade_end = gEnd
  canon.description = desc
  return canon
}

async function mergeSkills(
  skills_in: Skill[], prereqs: Prereq[], levels: Level[]
): Promise<{ skills: Skill[]; prereqs: Prereq[]; levels: Level[]; idMap: Map<string, string> }> {
  let skills = skills_in
  // Pass 0: merge skills sharing ASN identifiers (catches CSP↔ASN duplicates)
  // CSP stores short asnIdentifier codes (e.g. "S1143545") in ext_ids
  // ASN stores full URIs (e.g. "http://asn.desire2learn.com/resources/S1143545") in ext_urls
  // Extract the short code from both and match
  const asnIndex = new Map<string, number>() // short ASN code -> index in skills array
  const asnParent = ufInit(skills.length)
  let asnMerges = 0
  for (let i = 0; i < skills.length; i++) {
    const codes: string[] = []
    // From ext_urls: extract short code from full ASN URIs
    for (const url of skills[i].ext_urls) {
      if (url.startsWith("http://asn.desire2learn.com/resources/")) {
        codes.push(lastSeg(url).replace(".xml", ""))
      }
    }
    // From ext_ids: short ASN identifier codes (CSP asnIdentifier, e.g. "S103E740", "D10002DE")
    for (const eid of skills[i].ext_ids) {
      if (/^[A-Z][0-9A-F]{5,}$/i.test(eid)) codes.push(eid)
    }
    for (const code of codes) {
      const existing = asnIndex.get(code)
      if (existing !== undefined && ufFind(asnParent, existing) !== ufFind(asnParent, i)) {
        ufUnion(asnParent, existing, i)
        asnMerges++
      } else if (existing === undefined) {
        asnIndex.set(code, i)
      }
    }
  }
  if (asnMerges) {
    console.log(`  ASN identifier merges: ${asnMerges}`)
    const asnGroups = new Map<number, number[]>()
    for (let i = 0; i < skills.length; i++) {
      const root = ufFind(asnParent, i)
      const arr = asnGroups.get(root)
      if (arr) arr.push(i)
      else asnGroups.set(root, [i])
    }
    const asnIdMap = new Map<string, string>()
    const deduped: Skill[] = []
    for (const members of asnGroups.values()) {
      if (members.length === 1) { deduped.push(skills[members[0]]); continue }
      const group = members.map(i => skills[i])
      deduped.push(mergeGroup(group, asnIdMap))
    }
    // Rewrite prereqs and levels through ASN id map
    for (let i = 0; i < prereqs.length; i++) {
      prereqs[i] = {
        skill_id: asnIdMap.get(prereqs[i].skill_id) ?? prereqs[i].skill_id,
        prereq_id: asnIdMap.get(prereqs[i].prereq_id) ?? prereqs[i].prereq_id,
        source: prereqs[i].source,
      }
    }
    for (let i = 0; i < levels.length; i++) {
      levels[i] = { skill_id: asnIdMap.get(levels[i].skill_id) ?? levels[i].skill_id, lvl: levels[i].lvl }
    }
    skills = deduped
    console.log(`  After ASN dedup: ${skills.length} skills`)
  }

  // Pass 1: exact normalized label grouping
  const byLabel = new Map<string, Skill[]>()
  for (const s of skills) {
    const key = normalizeLabel(s.label)
    if (key.length < 3) { byLabel.set(`__${s.id}`, [s]); continue }
    const arr = byLabel.get(key)
    if (arr) arr.push(s)
    else byLabel.set(key, [s])
  }

  const merged: Skill[] = []
  const idMap = new Map<string, string>()
  const ungrouped: Skill[] = [] // singletons eligible for fuzzy matching
  let exactMerges = 0
  for (const group of byLabel.values()) {
    if (group.length === 1) {
      merged.push(group[0])
      idMap.set(group[0].id, group[0].id)
      ungrouped.push(group[0])
      continue
    }
    exactMerges += group.length - 1
    merged.push(mergeGroup(group, idMap))
  }
  console.log(`  Exact label merges: ${exactMerges}`)

  // Pass 2: fuzzy merge on ungrouped skills
  const fuzzyGroups = await fuzzyMergePass(ungrouped)
  let fuzzyMergeCount = 0
  if (fuzzyGroups.size) {
    const byId = new Map<string, Skill>()
    for (const s of merged) byId.set(s.id, s)
    const toRemove = new Set<string>()
    for (const [canonId, otherIds] of fuzzyGroups) {
      const group = [byId.get(canonId)!, ...otherIds.map(id => byId.get(id)!).filter(Boolean)]
      if (group.length < 2) continue
      for (const id of otherIds) toRemove.add(id)
      const canon = mergeGroup(group, idMap)
      byId.set(canon.id, canon)
      fuzzyMergeCount += otherIds.length
    }
    // Rebuild merged array excluding removed skills
    merged.length = 0
    for (const s of byId.values()) {
      if (!toRemove.has(s.id)) merged.push(s)
    }
  }
  console.log(`  Fuzzy merges: ${fuzzyMergeCount}`)

  // Rewrite prereq IDs
  const mergedPrereqs = prereqs.map(p => ({
    skill_id: idMap.get(p.skill_id) ?? p.skill_id,
    prereq_id: idMap.get(p.prereq_id) ?? p.prereq_id,
    source: p.source,
  })).filter(p => p.skill_id !== p.prereq_id)

  // Dedup prereqs
  const seen = new Set<string>()
  const dedupedPrereqs = mergedPrereqs.filter(p => {
    const key = `${p.skill_id}|${p.prereq_id}|${p.source}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Rewrite level IDs
  const mergedLevels = levels.map(l => ({
    skill_id: idMap.get(l.skill_id) ?? l.skill_id,
    lvl: l.lvl,
  }))

  return { skills: merged, prereqs: dedupedPrereqs, levels: mergedLevels, idMap }
}

// Prereq inference

function inferJunyiHierarchyPrereqs(junyiRows: Record<string, string>[]): Prereq[] {
  const diffOrd: Record<string, number> = { easy: 1, normal: 2, hard: 3 }
  const groups = new Map<string, Array<{ id: string; diff: number }>>()
  for (const r of junyiRows) {
    const ucid = r["ucid"], lv3 = r["level3_id"], diff = r["difficulty"]
    if (!ucid || !lv3 || !diffOrd[diff]) continue
    const arr = groups.get(lv3)
    const entry = { id: `junyi.${ucid}`, diff: diffOrd[diff] }
    if (arr) arr.push(entry)
    else groups.set(lv3, [entry])
  }
  const prereqs: Prereq[] = []
  for (const members of groups.values()) {
    members.sort((a, b) => a.diff - b.diff)
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        if (members[j].diff > members[i].diff)
          prereqs.push({ skill_id: members[j].id, prereq_id: members[i].id, source: "junyi_hierarchy" })
  }
  return prereqs
}

async function inferJunyiLogPrereqs(): Promise<Prereq[]> {
  const path = `${DATA}/junyi/Log_Problem.csv`
  try { await Deno.stat(path) } catch {
    console.error("  Junyi Log_Problem.csv not found, skipping log inference")
    return []
  }

  // Stream 2.8GB file: build per-user first-correct timestamps
  const userMastery = new Map<string, Map<string, string>>() // user -> (exercise -> timestamp)
  const file = await Deno.open(path)
  const decoder = new TextDecoderStream()
  const stream = file.readable.pipeThrough(decoder)
  let buf = ""
  let header: string[] = []
  let lineNum = 0

  for await (const chunk of stream) {
    buf += chunk
    const lines = buf.split("\n")
    buf = lines.pop()! // keep incomplete last line
    for (const line of lines) {
      if (lineNum === 0) { header = line.split(","); lineNum++; continue }
      lineNum++
      const vals = line.split(",")
      const ts = vals[0]  // timestamp_TW
      const user = vals[1] // uuid
      const exercise = vals[2] // ucid
      const correct = vals[6] // is_correct
      if (correct !== "True" || !user || !exercise) continue
      let userMap = userMastery.get(user)
      if (!userMap) { userMap = new Map(); userMastery.set(user, userMap) }
      if (!userMap.has(exercise)) userMap.set(exercise, ts)
    }
  }
  console.log(`  Streamed ${lineNum} log rows, ${userMastery.size} users`)

  // Count directional mastery for exercise pairs
  // Only consider exercises that appear in our skills (junyi.*)
  const exercisePairs = new Map<string, { ab: number; ba: number }>() // "a|b" -> counts
  for (const userMap of userMastery.values()) {
    const entries = [...userMap.entries()] // [exercise, timestamp]
    if (entries.length < 2) continue
    entries.sort((a, b) => a[1] < b[1] ? -1 : 1)
    // Only check sequential pairs within window to avoid O(n^2) per user
    for (let i = 0; i < entries.length - 1 && i < 50; i++) {
      for (let j = i + 1; j < entries.length && j < i + 10; j++) {
        const [ea, _ta] = entries[i], [eb, _tb] = entries[j]
        if (ea === eb) continue
        const key = ea < eb ? `${ea}|${eb}` : `${eb}|${ea}`
        let pair = exercisePairs.get(key)
        if (!pair) { pair = { ab: 0, ba: 0 }; exercisePairs.set(key, pair) }
        if (ea < eb) pair.ab++; else pair.ba++
      }
    }
  }

  const prereqs: Prereq[] = []
  const MIN_STUDENTS = 20
  const THRESHOLD = 0.8
  for (const [key, counts] of exercisePairs) {
    const total = counts.ab + counts.ba
    if (total < MIN_STUDENTS) continue
    const [ea, eb] = key.split("|")
    if (counts.ab / total >= THRESHOLD) {
      prereqs.push({ skill_id: `junyi.${eb}`, prereq_id: `junyi.${ea}`, source: "junyi_logs" })
    } else if (counts.ba / total >= THRESHOLD) {
      prereqs.push({ skill_id: `junyi.${ea}`, prereq_id: `junyi.${eb}`, source: "junyi_logs" })
    }
  }
  return prereqs
}

async function inferAssistmentsPrereqs(): Promise<Prereq[]> {
  const path = `${DATA}/assistments/skill_builder_data.csv`
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch {
    const proc = new Deno.Command("gunzip", { args: ["-c", `${path}.gz`], stdout: "piped", stderr: "piped" })
    const { stdout, success } = await proc.output()
    if (!success) { console.error("  Failed to decompress assistments"); return [] }
    text = new TextDecoder().decode(stdout)
  }
  const rows = parseCsvRows(text)

  // Group by user, record first correct per skill by order_id
  const userSkills = new Map<string, Map<string, number>>() // user -> (skill_id -> first_correct_order)
  for (const r of rows) {
    if (r["correct"] !== "1") continue
    const user = r["user_id"], sid = r["skill_id"], order = parseInt(r["order_id"])
    if (!user || !sid || isNaN(order)) continue
    let umap = userSkills.get(user)
    if (!umap) { umap = new Map(); userSkills.set(user, umap) }
    const prev = umap.get(sid)
    if (prev === undefined || order < prev) umap.set(sid, order)
  }

  // Count directional mastery for skill pairs
  const skillPairs = new Map<string, { ab: number; ba: number }>()
  for (const umap of userSkills.values()) {
    const entries = [...umap.entries()].sort((a, b) => a[1] - b[1])
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [sa] = entries[i], [sb] = entries[j]
        const key = sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`
        let pair = skillPairs.get(key)
        if (!pair) { pair = { ab: 0, ba: 0 }; skillPairs.set(key, pair) }
        if (sa < sb) pair.ab++; else pair.ba++
      }
    }
  }

  const prereqs: Prereq[] = []
  const MIN_STUDENTS = 10
  const THRESHOLD = 0.8
  for (const [key, counts] of skillPairs) {
    const total = counts.ab + counts.ba
    if (total < MIN_STUDENTS) continue
    const [sa, sb] = key.split("|")
    if (counts.ab / total >= THRESHOLD) {
      prereqs.push({ skill_id: `assistments.${sb}`, prereq_id: `assistments.${sa}`, source: "assistments_logs" })
    } else if (counts.ba / total >= THRESHOLD) {
      prereqs.push({ skill_id: `assistments.${sa}`, prereq_id: `assistments.${sb}`, source: "assistments_logs" })
    }
  }
  return prereqs
}

// Writers

function writeTsv(path: string, header: string[], rows: string[][]): string {
  const lines = [header.join("\t"), ...rows.map(r => r.join("\t"))]
  const text = lines.join("\n") + "\n"
  Deno.writeTextFileSync(path, text)
  return path
}

function writeSkillsTsv(skills: Skill[]) {
  const header = ["id", "ext_ids", "label", "description", "tags", "grade_start", "grade_end"]
  const rows = skills.map(s => [
    s.id,
    s.ext_ids.map(id => id.replace(/[\t\n\r;]/g, "_")).join(";"),
    sanitize(s.label),
    sanitize(s.description),
    s.tags.join(";"),
    s.grade_start !== null ? s.grade_start.toFixed(1) : "",
    s.grade_end !== null ? s.grade_end.toFixed(1) : "",
  ])
  writeTsv("skills.tsv", header, rows)
}

function writePrereqsTsv(prereqs: Prereq[]) {
  const header = ["skill_id", "prereq_id", "source"]
  const rows = prereqs.map(p => [p.skill_id, p.prereq_id, p.source])
  writeTsv("prereqs.tsv", header, rows)
}

function writeLevelsTsv(levels: Level[]) {
  const allDims = new Set<string>()
  for (const l of levels) for (const k of Object.keys(l.lvl)) allDims.add(k)
  const dims = [...allDims].sort()
  const header = ["skill_id", ...dims.map(d => `lvl_${d}`)]
  const rows = levels.map(l => [
    l.skill_id,
    ...dims.map(d => l.lvl[d] !== undefined ? l.lvl[d].toFixed(2) : ""),
  ])
  writeTsv("levels.tsv", header, rows)
}

function writeVizJson(skills: Map<string, Skill>, prereqs: Prereq[]) {
  const involved = new Set<string>()
  for (const p of prereqs) { involved.add(p.skill_id); involved.add(p.prereq_id) }
  const vizSkills: Array<{ id: string; label: string; tags: string; gs: string; ge: string }> = []
  for (const id of involved) {
    const s = skills.get(id)
    if (s) vizSkills.push({ id: s.id, label: s.label, tags: s.tags.join(";"), gs: s.grade_start?.toFixed(1) ?? "", ge: s.grade_end?.toFixed(1) ?? "" })
    else vizSkills.push({ id, label: id, tags: "", gs: "", ge: "" })
  }
  const vizPrereqs = prereqs.map(p => [p.skill_id, p.prereq_id, p.source])
  Deno.writeTextFileSync("viz.json", JSON.stringify({ skills: vizSkills, prereqs: vizPrereqs }))
}

function writeDot(skills: Map<string, Skill>, prereqs: Prereq[]) {
  const involved = new Set<string>()
  for (const p of prereqs) { involved.add(p.skill_id); involved.add(p.prereq_id) }

  const lines = ['digraph skills {', '  rankdir=LR;']
  for (const id of involved) {
    const s = skills.get(id)
    const label = (s?.label || id).replace(/"/g, '\\"')
    lines.push(`  "${id}" [label="${label}"];`)
  }
  for (const p of prereqs) {
    lines.push(`  "${p.prereq_id}" -> "${p.skill_id}";`)
  }
  lines.push('}')
  Deno.writeTextFileSync("skills.dot", lines.join("\n") + "\n")
}

// Main
async function main() {
  const parsers: [string, () => Promise<Result>][] = [
    ["khan", parseKhan],
    ["alcpl", parseAlcpl],
    ["metacademy", parseMetacademy],
    ["onet-skills", () => parseOnet("Skills.txt", "skill")],
    ["onet-knowledge", () => parseOnet("Knowledge.txt", "knowledge")],
    ["onet-abilities", () => parseOnet("Abilities.txt", "ability")],
    ["esco", parseEsco],
    ["mooccubex", parseMooccubex],
    ["assistments", parseAssistments],
    ["junyi", parseJunyi],
    ["csp", parseCsp],
    ["opensalt", parseOpensalt],
    ["asn", parseAsn],
  ]

  const allSkills: Skill[] = []
  const allPrereqs: Prereq[] = []
  const allLevels: Level[] = []
  const byId = new Map<string, Skill>()

  for (const [name, parser] of parsers) {
    console.log(`Parsing ${name}...`)
    try {
      const r = await parser()
      let skipped = 0
      for (const s of r.skills) {
        if (!isValidLabel(s.label)) { skipped++; continue }
        if (byId.has(s.id)) {
          console.error(`  WARN: duplicate id ${s.id}, skipping`)
          continue
        }
        byId.set(s.id, s)
        allSkills.push(s)
      }
      if (skipped) console.log(`  Skipped ${skipped} skills with invalid labels`)
      allPrereqs.push(...r.prereqs)
      allLevels.push(...r.levels)
      console.log(`  ${r.skills.length} skills, ${r.prereqs.length} prereqs, ${r.levels.length} levels`)
    } catch (e) {
      console.error(`FATAL parsing ${name}: ${e}`)
      throw e
    }
  }

  console.log(`\nParsed: ${allSkills.length} skills, ${allPrereqs.length} prereqs, ${allLevels.length} levels`)

  // Prereq inference
  console.log("\nInferring prereqs...")

  console.log("  Junyi hierarchy...")
  const junyiRows = parseCsvRows(await Deno.readTextFile(`${DATA}/junyi/Info_Content.csv`))
  const junyiHierPrereqs = inferJunyiHierarchyPrereqs(junyiRows)
  allPrereqs.push(...junyiHierPrereqs)
  console.log(`  ${junyiHierPrereqs.length} junyi hierarchy prereqs`)

  console.log("  Junyi logs...")
  const junyiLogPrereqs = await inferJunyiLogPrereqs()
  allPrereqs.push(...junyiLogPrereqs)
  console.log(`  ${junyiLogPrereqs.length} junyi log prereqs`)

  console.log("  ASSISTments logs...")
  const assistPrereqs = await inferAssistmentsPrereqs()
  allPrereqs.push(...assistPrereqs)
  console.log(`  ${assistPrereqs.length} assistments prereqs`)

  // Merge duplicate skills by label
  console.log("\nMerging skills by label...")
  const mergeResult = await mergeSkills(allSkills, allPrereqs, allLevels)
  console.log(`  ${allSkills.length} -> ${mergeResult.skills.length} skills (${allSkills.length - mergeResult.skills.length} merged)`)
  console.log(`  ${allPrereqs.length} -> ${mergeResult.prereqs.length} prereqs after rewrite`)

  // Post-merge label filter (merge can pick a long label)
  const finalSkills = mergeResult.skills.filter(s => isValidLabel(s.label))

  const mergedById = new Map<string, Skill>()
  for (const s of finalSkills) mergedById.set(s.id, s)

  console.log(`\nTotals: ${finalSkills.length} skills, ${mergeResult.prereqs.length} prereqs, ${mergeResult.levels.length} levels`)

  writeSkillsTsv(finalSkills)
  console.log("Wrote skills.tsv")
  const gz = new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] })
  const gzr = await gz.output()
  if (gzr.success) console.log("Wrote skills.tsv.gz")
  else console.error("Failed to gzip skills.tsv")
  writePrereqsTsv(mergeResult.prereqs)
  console.log("Wrote prereqs.tsv")
  writeLevelsTsv(mergeResult.levels)
  console.log("Wrote levels.tsv")
  writeDot(mergedById, mergeResult.prereqs)
  console.log("Wrote skills.dot")
  writeVizJson(mergedById, mergeResult.prereqs)
  console.log("Wrote viz.json")
}

main()
