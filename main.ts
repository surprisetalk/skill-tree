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
type Prereq = { skill_id: string; prereq_id: string; source: string; type: "prerequisite" | "broader"; confidence?: number }

const SOURCE_CONFIDENCE: Record<string, number> = {
  khan: 1.0, alcpl: 1.0, metacademy: 1.0, opensalt: 1.0, asn: 1.0,
  esco: 1.0, csp_grade: 1.0,
  esco_optional: 0.9, junyi_hierarchy: 0.9, ngss_progression: 0.9, hess_progression: 0.9,
  junyi_logs: 0.8, assistments_logs: 0.8, mooccubex: 0.8,
  course_skill_atlas: 0.6, csa_distance: 0.6, lcsh_broader: 0.5, dbpedia_broader: 0.5, wikidata_p279: 0.7,
  llm: 0.8,
}
function confidenceFor(p: Prereq): number {
  return p.confidence ?? SOURCE_CONFIDENCE[p.source] ?? 0.5
}
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
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim())
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

const DOMAIN_KEYWORDS: [string, RegExp][] = [
  ["math", /\b(math|algebra|geometry|calculus|trigonometr|arithmetic|topolog|statistic|probabilit|number theor|linear algebra|differential equation|analysis \(math|numerical)\b/i],
  ["science", /\b(physic|chemistr|biolog|astronom|geolog|ecolog|anatom|zoolog|botan|microbiolog|genetic|biochem|neurosci|meteorolog|earth science|natural science|scientific)\b/i],
  ["history", /\b(histor|ancient|medieval|renaissance|civilization|empire|dynasty|revolution|war of|century |historical)\b/i],
  ["language", /\b(language|linguistic|grammar|syntax|phoneti|literatur|poetry|rhetoric|writing|reading|vocabulary|translation|etymolog)\b/i],
  ["technology", /\b(comput|software|programming|algorithm|data structure|machine learning|artificial intelligence|network|cryptograph|database|engineering|electron|robotic|digital|internet|web )\b/i],
  ["social studies", /\b(politic|government|sociolog|anthropolog|psycholog|economic|geograph|civic|cultur|philosoph|ethic|law|international relations)\b/i],
  ["art", /\b(art|music|paint|sculptur|drawing|design|theater|theatre|film|cinema|photograph|danc|architect|craft)\b/i],
  ["business", /\b(business|finance|account|marketing|manage|entrepreneur|commerce|trade|investment|econom|industry)\b/i],
  ["health", /\b(health|medic|nurs|dental|pharmac|therap|clinical|disease|diagnos|patient|surger|hospital|public health|nutrition|fitness)\b/i],
]

function domainTags(label: string): string[] {
  const tags: string[] = []
  for (const [tag, re] of DOMAIN_KEYWORDS) if (re.test(label)) tags.push(tag)
  return tags
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
      if (resolved) prereqs.push({ skill_id: id, prereq_id: `khan.${resolved}`, source: "khan", type: "prerequisite" })
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
          type: "prerequisite",
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
        if (m) prereqs.push({ skill_id: id, prereq_id: `metacademy.${m[1].trim()}`, source: "metacademy", type: "prerequisite" })
      }
    } catch { /* ok */ }
  }
  return { skills, prereqs, levels: [] }
}

// 4. O*NET (generic for Skills, Knowledge, Abilities)
async function parseOnet(file: string, category: string): Promise<Result> {
  const text = await Deno.readTextFile(`${DATA}/onet/${file}`)
  const rows = parseTsvRows(text)

  const dimNames = new Map<string, string>() // Element ID -> Element Name
  // Per-occupation, per-dimension LV scores
  const occDims = new Map<string, Map<string, number>>() // SOC code -> (Element ID -> LV value)
  for (const r of rows) {
    const eid = r["Element ID"], ename = r["Element Name"], soc = r["O*NET-SOC Code"]
    if (!eid || !ename || !soc) continue
    dimNames.set(eid, ename)
    if (r["Scale ID"] === "LV") {
      const v = parseFloat(r["Data Value"])
      if (isNaN(v)) continue
      let dims = occDims.get(soc)
      if (!dims) { dims = new Map(); occDims.set(soc, dims) }
      dims.set(eid, v)
    }
  }

  const skills: Skill[] = []
  const levels: Level[] = []
  for (const [eid, name] of dimNames) {
    skills.push(skill(`onet.${category}.${eid}`, name, {
      tags: ["onet", category],
      ext_urls: [`https://www.onetonline.org/find/descriptor/result/${eid}`],
      ext_ids: [eid],
    }))
  }
  // One level row per occupation with all dimensions
  for (const [soc, dims] of occDims) {
    const lvl: Record<string, number> = {}
    for (const [eid, v] of dims) lvl[slug(dimNames.get(eid)!)] = v
    levels.push({ skill_id: soc, lvl })
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
    const rel = r["relationType"]
    if (rel !== "essential" && rel !== "optional") continue
    const origId = uriToId.get(r["originalSkillUri"])
    const relId = uriToId.get(r["relatedSkillUri"])
    if (origId && relId) prereqs.push({ skill_id: origId, prereq_id: relId, source: rel === "essential" ? "esco" : "esco_optional", type: "prerequisite" })
  }

  // Occupations as skills + essential/optional skills as prereqs of the occupation
  try {
    const occText = await Deno.readTextFile(`${DATA}/esco/occupations_en.csv`)
    for (const r of parseCsvRows(occText)) {
      const uri = r["conceptUri"]
      if (!uri) continue
      const id = `esco.occ.${lastSeg(uri)}`
      uriToId.set(uri, id)
      skills.push(skill(id, r["preferredLabel"] || "", {
        tags: ["occupation", "esco", ...domainTags(r["preferredLabel"] || "")],
        ext_urls: [uri],
        description: r["description"] || r["definition"] || "",
        ext_ids: [uri],
      }))
    }
    const occRelText = await Deno.readTextFile(`${DATA}/esco/occupationSkillRelations_en.csv`)
    for (const r of parseCsvRows(occRelText)) {
      const occId = uriToId.get(r["occupationUri"])
      const skId = uriToId.get(r["skillUri"])
      if (!occId || !skId) continue
      const rel = r["relationType"]
      prereqs.push({
        skill_id: occId, prereq_id: skId,
        source: rel === "essential" ? "esco" : "esco_optional",
        type: "prerequisite",
      })
    }
  } catch (e) {
    console.error(`  ESCO occupations skipped: ${e}`)
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
      prereqs.push({ skill_id: sid, prereq_id: pid, source: "mooccubex", type: "prerequisite" })
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

    const itemIdMap = new Map<string, string>() // opensalt identifier -> our id
    for (const item of data.CFItems ?? []) {
      const uid = sanitizeId(item.identifier)
      if (!uid) continue // skip items without a UUID — would produce empty-ID orphans
      const id = `opensalt.${uid}`
      itemIdMap.set(item.identifier, id)
      const label = sanitize(item.fullStatement || item.humanCodingScheme || "")
      if (!isValidLabel(label)) continue
      const gradeNums = (item.educationLevel || []).map(parseGrade).filter((g): g is number => g !== null)
      const hcs = sanitizeId(item.humanCodingScheme || "")
      skills.push(skill(id, label, {
        ext_ids: hcs ? [`opensalt.${hcs}`] : [],
        tags: [item.CFItemType].filter(Boolean) as string[],
        grade_start: gradeNums.length ? Math.min(...gradeNums) : null,
        grade_end: gradeNums.length ? Math.max(...gradeNums) : null,
      }))
    }

    for (const assoc of data.CFAssociations ?? []) {
      const originId = itemIdMap.get(assoc.originNodeURI?.identifier)
      const destId = itemIdMap.get(assoc.destinationNodeURI?.identifier)
      if (!originId || !destId) continue
      if (assoc.associationType === "precedes") {
        prereqs.push({ skill_id: destId, prereq_id: originId, source: "opensalt", type: "prerequisite" })
      } else if (assoc.associationType === "isChildOf") {
        prereqs.push({ skill_id: originId, prereq_id: destId, source: "opensalt", type: "broader" })
      }
    }
  }
  return { skills, prereqs, levels: [] }
}

async function parseWikidata(): Promise<Result> {
  const skills: Skill[] = []
  const prereqs: Prereq[] = []
  const path = `${DATA}/wikidata/p279.jsonl`
  let text: string
  try { text = await Deno.readTextFile(path) } catch { return { skills, prereqs, levels: [] } }

  const seen = new Set<string>()
  const addSkill = (qid: string, label: string) => {
    if (!qid || !label || seen.has(qid)) return
    seen.add(qid)
    skills.push(skill(`wikidata.${qid}`, label, { tags: ["wikidata"], ext_urls: [`https://www.wikidata.org/wiki/${qid}`] }))
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let r: { label: string; qid: string; parents?: Array<{ qid: string; label: string }> }
    try { r = JSON.parse(line) } catch { continue }
    if (!r.qid) continue
    addSkill(r.qid, r.label)
    for (const p of r.parents ?? []) {
      addSkill(p.qid, p.label)
      prereqs.push({ skill_id: `wikidata.${r.qid}`, prereq_id: `wikidata.${p.qid}`, source: "wikidata_p279", type: "broader" })
    }
  }
  return { skills, prereqs, levels: [] }
}

async function parseNgss(): Promise<Result> {
  // Extract Disciplinary Core Idea codes (e.g. ESS1.A, LS2.B) from Appendix E.
  // For each DCI code, emit 4 grade-band skills and a prereq chain between them.
  const skills: Skill[] = []
  const prereqs: Prereq[] = []
  const path = `${DATA}/ngss/AppendixE-Progressions.pdf`
  try { await Deno.stat(path) } catch { return { skills, prereqs, levels: [] } }

  const proc = new Deno.Command("pdftotext", { args: [path, "-"], stdout: "piped" })
  const { success, stdout } = await proc.output()
  if (!success) return { skills, prereqs, levels: [] }
  const text = new TextDecoder().decode(stdout)

  const dciSet = new Set<string>()
  for (const m of text.matchAll(/\b([A-Z]{2,4}\d+\.[A-Z])\b/g)) dciSet.add(m[1])

  const bands: Array<{ suffix: string; label: string; gs: number; ge: number }> = [
    { suffix: "k2", label: "K–2", gs: 0, ge: 2 },
    { suffix: "35", label: "3–5", gs: 3, ge: 5 },
    { suffix: "68", label: "6–8", gs: 6, ge: 8 },
    { suffix: "912", label: "9–12", gs: 9, ge: 12 },
  ]
  for (const dci of dciSet) {
    const ids: string[] = []
    for (const b of bands) {
      const id = `ngss.${dci}.${b.suffix}`
      ids.push(id)
      skills.push(skill(id, `NGSS ${dci} grades ${b.label}`, {
        tags: ["ngss", "science"],
        grade_start: b.gs, grade_end: b.ge,
      }))
    }
    for (let i = 1; i < ids.length; i++) {
      prereqs.push({ skill_id: ids[i], prereq_id: ids[i - 1], source: "ngss_progression", type: "prerequisite" })
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

// 13. LCSH (Library of Congress Subject Headings)
async function parseLcsh(): Promise<Result> {
  const path = `${DATA}/lcsh/subjects.skosrdf.nt.gz`
  try { await Deno.stat(path) } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error("  LCSH file not found, skipping")
      return { skills: [], prereqs: [], levels: [] }
    }
    throw e
  }

  const SKOS = "http://www.w3.org/2004/02/skos/core#"
  const PREDS = new Set([`${SKOS}prefLabel`, `${SKOS}altLabel`, `${SKOS}broader`])
  const SUBJ_PREFIX = "http://id.loc.gov/authorities/subjects/"

  const labels = new Map<string, string>()       // shortCode -> prefLabel
  const altLabels = new Map<string, string[]>()   // shortCode -> alt labels
  const broaderEdges: [string, string][] = []     // [child, parent]

  const file = await Deno.open(path)
  const stream = file.readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
  let buf = ""
  let lineNum = 0

  for await (const chunk of stream) {
    buf += chunk
    const lines = buf.split("\n")
    buf = lines.pop()!
    for (const line of lines) {
      lineNum++
      if (!line || line[0] === "#" || line[0] === "_") continue

      const m = line.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)\s+\.\s*$/)
      if (!m) continue
      const [, subj, pred, obj] = m
      if (!PREDS.has(pred) || !subj.startsWith(SUBJ_PREFIX)) continue

      const code = subj.slice(SUBJ_PREFIX.length)

      if (pred === `${SKOS}prefLabel` || pred === `${SKOS}altLabel`) {
        if (!obj.endsWith('@en')) continue
        const label = obj.replace(/^"/, "").replace(/"@en$/, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        if (!label) continue
        if (pred === `${SKOS}prefLabel`) {
          labels.set(code, label)
        } else {
          const arr = altLabels.get(code)
          if (arr) arr.push(label)
          else altLabels.set(code, [label])
        }
      } else {
        // broader: code is narrower than objCode
        const objMatch = obj.match(/^<([^>]+)>$/)
        if (!objMatch || !objMatch[1].startsWith(SUBJ_PREFIX)) continue
        broaderEdges.push([code, objMatch[1].slice(SUBJ_PREFIX.length)])
      }
    }
  }
  console.log(`  Streamed ${lineNum} lines, ${labels.size} subjects, ${broaderEdges.length} broader edges`)

  const skills: Skill[] = []
  for (const [code, label] of labels) {
    const alts = altLabels.get(code)
    skills.push(skill(`lcsh.${code}`, label, {
      tags: ["lcsh", ...domainTags(label)],
      description: alts ? alts.join("; ") : "",
      ext_urls: [`${SUBJ_PREFIX}${code}`],
    }))
  }

  // broader = prereq: to learn narrow topic, know the broad one first
  const prereqs: Prereq[] = []
  for (const [child, parent] of broaderEdges) {
    if (!labels.has(child) || !labels.has(parent)) continue
    prereqs.push({ skill_id: `lcsh.${child}`, prereq_id: `lcsh.${parent}`, source: "lcsh_broader", type: "broader" })
  }

  return { skills, prereqs, levels: [] }
}

// 14. DBpedia SKOS categories
async function parseDbpedia(): Promise<Result> {
  const path = `${DATA}/dbpedia/skos_categories_en.ttl.bz2`
  try { await Deno.stat(path) } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error("  DBpedia file not found, skipping")
      return { skills: [], prereqs: [], levels: [] }
    }
    throw e
  }

  const SKOS = "http://www.w3.org/2004/02/skos/core#"
  const PREFLABEL = `${SKOS}prefLabel`
  const BROADER = `${SKOS}broader`
  const CAT_PREFIX = "http://dbpedia.org/resource/Category:"

  const labels = new Map<string, string>()
  const broaderEdges: [string, string][] = []

  const proc = new Deno.Command("bzcat", { args: [path], stdout: "piped", stderr: "null" }).spawn()
  const stream = proc.stdout.pipeThrough(new TextDecoderStream())
  let buf = ""
  let lineNum = 0

  for await (const chunk of stream) {
    buf += chunk
    const lines = buf.split("\n")
    buf = lines.pop()!
    for (const line of lines) {
      lineNum++
      if (!line || line[0] === "#") continue
      const m = line.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)\s+\.\s*$/)
      if (!m) continue
      const [, subj, pred, obj] = m
      if (!subj.startsWith(CAT_PREFIX)) continue
      const code = subj.slice(CAT_PREFIX.length)
      if (pred === PREFLABEL) {
        if (!obj.endsWith('@en')) continue
        const label = obj.replace(/^"/, "").replace(/"@en$/, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        if (label) labels.set(code, label)
      } else if (pred === BROADER) {
        const objMatch = obj.match(/^<([^>]+)>$/)
        if (!objMatch || !objMatch[1].startsWith(CAT_PREFIX)) continue
        broaderEdges.push([code, objMatch[1].slice(CAT_PREFIX.length)])
      }
    }
  }
  await proc.status
  console.log(`  Streamed ${lineNum} lines, ${labels.size} categories, ${broaderEdges.length} broader edges`)

  const skills: Skill[] = []
  for (const [code, label] of labels) {
    // Filter administrative Wikipedia categories (heavily noise-inducing)
    if (/^Wikipedia_|^Articles_|^CS1_|^Pages_|^Hidden_categor|^Disambiguation/.test(code)) continue
    skills.push(skill(`dbpedia.${code}`, label, {
      tags: ["dbpedia", ...domainTags(label)],
      ext_urls: [`${CAT_PREFIX}${code}`],
    }))
  }
  const validCodes = new Set(skills.map(s => s.id.slice("dbpedia.".length)))

  const prereqs: Prereq[] = []
  for (const [child, parent] of broaderEdges) {
    if (!validCodes.has(child) || !validCodes.has(parent)) continue
    prereqs.push({ skill_id: `dbpedia.${child}`, prereq_id: `dbpedia.${parent}`, source: "dbpedia_broader", type: "broader" })
  }

  return { skills, prereqs, levels: [] }
}

// 15. Course-Skill Atlas: Field of Study -> top 10 DWAs
async function parseCourseSkillAtlas(): Promise<Result> {
  const fosPath = `${DATA}/course-skill-atlas/top10_DWA_per_FOS.csv`
  const dwaPath = `${DATA}/onet/DWA Reference.txt`
  try { await Deno.stat(fosPath); await Deno.stat(dwaPath) } catch {
    console.error("  Course-Skill Atlas or DWA Reference not found, skipping")
    return { skills: [], prereqs: [], levels: [] }
  }

  // DWA title (normalized) -> DWA ID
  const dwaByTitle = new Map<string, string>()
  for (const r of parseTsvRows(await Deno.readTextFile(dwaPath))) {
    const id = r["DWA ID"], title = r["DWA Title"]
    if (id && title) dwaByTitle.set(title.trim().toLowerCase(), id)
  }

  const skills: Skill[] = []
  const prereqs: Prereq[] = []
  const seenDwas = new Set<string>()
  const seenFos = new Set<string>()

  const rows = parseCsvRows(await Deno.readTextFile(fosPath))
  let currentFos: string | null = null
  for (const r of rows) {
    const first = r["Detailed Work Activity (DWA)"]?.trim()
    const rank = r["Rank"]?.trim()
    if (!first) continue
    if (!rank) {
      currentFos = first
      const fid = `fos.${slug(currentFos)}`
      if (!seenFos.has(fid)) {
        skills.push(skill(fid, currentFos, { tags: ["field_of_study", ...domainTags(currentFos)] }))
        seenFos.add(fid)
      }
      continue
    }
    if (!currentFos) continue
    const dwaId = dwaByTitle.get(first.toLowerCase())
    if (!dwaId) continue
    const dwaSkillId = `onet.dwa.${dwaId}`
    if (!seenDwas.has(dwaSkillId)) {
      skills.push(skill(dwaSkillId, first, { tags: ["onet", "dwa", ...domainTags(first)] }))
      seenDwas.add(dwaSkillId)
    }
    // DWA is a narrower learning outcome within the field of study
    prereqs.push({ skill_id: dwaSkillId, prereq_id: `fos.${slug(currentFos)}`, source: "course_skill_atlas", type: "broader" })
  }
  console.log(`  ${seenFos.size} fields of study, ${seenDwas.size} DWAs, ${prereqs.length} FoS→DWA edges`)
  return { skills, prereqs, levels: [] }
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
    const aTax = (a.id.startsWith("lcsh.") || a.id.startsWith("dbpedia.")) ? 1 : 0
    const bTax = (b.id.startsWith("lcsh.") || b.id.startsWith("dbpedia.")) ? 1 : 0
    if (aTax !== bTax) return aTax - bTax
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
        type: prereqs[i].type,
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
      if (!group[0].id.startsWith("lcsh.") && !group[0].id.startsWith("dbpedia.")) ungrouped.push(group[0])
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
    type: p.type,
  })).filter(p => p.skill_id !== p.prereq_id)

  // Dedup prereqs
  const seen = new Set<string>()
  const dedupedPrereqs = mergedPrereqs.filter(p => {
    const key = `${p.skill_id}|${p.prereq_id}|${p.source}|${p.type}`
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
          prereqs.push({ skill_id: members[j].id, prereq_id: members[i].id, source: "junyi_hierarchy", type: "prerequisite" })
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
    for (let i = 0; i < entries.length - 1 && i < 100; i++) {
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
  const MIN_STUDENTS = 10
  const THRESHOLD = 0.8
  for (const [key, counts] of exercisePairs) {
    const total = counts.ab + counts.ba
    if (total < MIN_STUDENTS) continue
    const [ea, eb] = key.split("|")
    if (counts.ab / total >= THRESHOLD) {
      prereqs.push({ skill_id: `junyi.${eb}`, prereq_id: `junyi.${ea}`, source: "junyi_logs", type: "prerequisite" })
    } else if (counts.ba / total >= THRESHOLD) {
      prereqs.push({ skill_id: `junyi.${ea}`, prereq_id: `junyi.${eb}`, source: "junyi_logs", type: "prerequisite" })
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
  const MIN_STUDENTS = 5
  const THRESHOLD = 0.8
  for (const [key, counts] of skillPairs) {
    const total = counts.ab + counts.ba
    if (total < MIN_STUDENTS) continue
    const [sa, sb] = key.split("|")
    if (counts.ab / total >= THRESHOLD) {
      prereqs.push({ skill_id: `assistments.${sb}`, prereq_id: `assistments.${sa}`, source: "assistments_logs", type: "prerequisite" })
    } else if (counts.ba / total >= THRESHOLD) {
      prereqs.push({ skill_id: `assistments.${sa}`, prereq_id: `assistments.${sb}`, source: "assistments_logs", type: "prerequisite" })
    }
  }
  return prereqs
}

function inferCspGradePrereqs(skills: Skill[]): Prereq[] {
  const DICE_THRESHOLD = 0.3
  const MAX_EDGES_PER_GRADE_PAIR = 1000

  // Group CSP skills by (subject tag, integer grade)
  const csp = skills.filter(s => s.id.startsWith("csp.") && s.grade_start !== null)
  const bySubjectGrade = new Map<string, Map<number, Skill[]>>()
  for (const s of csp) {
    const grade = Math.round(s.grade_start!)
    for (const tag of s.tags) {
      let grades = bySubjectGrade.get(tag)
      if (!grades) { grades = new Map(); bySubjectGrade.set(tag, grades) }
      let arr = grades.get(grade)
      if (!arr) { arr = []; grades.set(grade, arr) }
      arr.push(s)
    }
  }

  const prereqs: Prereq[] = []
  for (const [tag, grades] of bySubjectGrade) {
    const sortedGrades = [...grades.keys()].sort((a, b) => a - b)
    for (let gi = 0; gi < sortedGrades.length - 1; gi++) {
      const gLow = sortedGrades[gi], gHigh = sortedGrades[gi + 1]
      if (gHigh - gLow > 3) continue // skip distant grades
      const lo = grades.get(gLow)!, hi = grades.get(gHigh)!
      if (lo.length > 500 || hi.length > 500) continue // skip huge groups

      const loBigrams = lo.map(s => ({ s, bg: charBigrams(normalizeLabel(s.label)) }))
      const hiBigrams = hi.map(s => ({ s, bg: charBigrams(normalizeLabel(s.label)) }))

      let edgeCount = 0
      for (const a of loBigrams) {
        if (edgeCount >= MAX_EDGES_PER_GRADE_PAIR) break
        let bestScore = 0, bestTarget: Skill | null = null
        for (const b of hiBigrams) {
          const d = dice(a.bg, b.bg)
          if (d > bestScore) { bestScore = d; bestTarget = b.s }
        }
        if (bestScore >= DICE_THRESHOLD && bestTarget) {
          prereqs.push({ skill_id: bestTarget.id, prereq_id: a.s.id, source: "csp_grade", type: "prerequisite" })
          edgeCount++
        }
      }
    }
  }
  console.log(`  ${prereqs.length} CSP grade-sequential prereqs across ${bySubjectGrade.size} subject groups`)
  return prereqs
}

// Writers

function writeTsv(path: string, header: string[], rows: string[][]): string {
  const lines = [header.join("\t"), ...rows.map(r => r.join("\t"))]
  const text = lines.join("\n") + "\n"
  Deno.writeTextFileSync(path, text)
  return path
}

function writeSkillsTsv(skills: Skill[], path = "skills.tsv") {
  const header = ["id", "ext_ids", "ext_urls", "label", "description", "tags", "source", "grade_start", "grade_end"]
  const rows = skills.map(s => [
    s.id,
    s.ext_ids.map(id => id.replace(/[\t\n\r;]/g, "_")).join(";"),
    s.ext_urls.map(u => u.replace(/[\t\n\r;]/g, "_")).join(";"),
    sanitize(s.label),
    sanitize(s.description),
    s.tags.join(";"),
    s.id.split(".")[0],
    s.grade_start !== null ? s.grade_start.toFixed(1) : "",
    s.grade_end !== null ? s.grade_end.toFixed(1) : "",
  ])
  writeTsv(path, header, rows)
}

function writePrereqsTsv(prereqs: Prereq[], path = "prereqs.tsv") {
  const header = ["skill_id", "prereq_id", "source", "type", "confidence"]
  const rows = prereqs.map(p => [p.skill_id, p.prereq_id, p.source, p.type, confidenceFor(p).toFixed(2)])
  writeTsv(path, header, rows)
}

function isTaxonomyId(id: string): boolean {
  return id.startsWith("lcsh.") || id.startsWith("dbpedia.")
}

async function writeEmbeddings(skills: Skill[]) {
  const labels = skills.map(s => s.label)
  const vecs = await embedLabels(labels)
  if (!vecs) { console.error("  Skipping embeddings output (python unavailable)"); return }
  const buf = new Uint8Array(4 + skills.length * EMB_DIM * 4)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, skills.length, true)
  for (let i = 0; i < skills.length; i++) {
    const f = new Float32Array(buf.buffer, 4 + i * EMB_DIM * 4, EMB_DIM)
    f.set(vecs[i])
  }
  await Deno.writeFile("embeddings.bin", buf)
  const idsTsv = "id\n" + skills.map(s => s.id).join("\n") + "\n"
  await Deno.writeTextFile("embeddings_ids.tsv", idsTsv)
}

function writeSkillsSourcesTsv(skills: Skill[]) {
  const header = ["canonical_id", "source_id", "source_url"]
  const rows: string[][] = []
  for (const s of skills) {
    const maxLen = Math.max(s.ext_ids.length, s.ext_urls.length, 1)
    for (let i = 0; i < maxLen; i++) {
      const sid = s.ext_ids[i] ?? ""
      const surl = s.ext_urls[i] ?? ""
      if (!sid && !surl) continue
      rows.push([s.id, sid, surl])
    }
  }
  writeTsv("skills_sources.tsv", header, rows)
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
  const vizPrereqs = prereqs.map(p => [p.skill_id, p.prereq_id, p.source, p.type])
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
    const style = p.type === "broader" ? ' [style=dashed]' : ""
    lines.push(`  "${p.prereq_id}" -> "${p.skill_id}"${style};`)
  }
  lines.push('}')
  Deno.writeTextFileSync("skills.dot", lines.join("\n") + "\n")
}

async function loadLlmPrereqs(): Promise<Prereq[]> {
  let text: string
  try { text = await Deno.readTextFile(`${DATA}/llm_prereqs.json`) }
  catch { return [] }
  const data = JSON.parse(text) as { pairs: Record<string, { direction: string; confidence?: number }> }
  if (!data.pairs) throw new Error("llm_prereqs.json missing 'pairs' field")
  const prereqs: Prereq[] = []
  for (const [key, val] of Object.entries(data.pairs)) {
    const [a, b] = key.split("|")
    const confidence = val.confidence ?? 0.8
    if (val.direction === "a->b") prereqs.push({ skill_id: b, prereq_id: a, source: "llm", type: "prerequisite", confidence })
    else if (val.direction === "b->a") prereqs.push({ skill_id: a, prereq_id: b, source: "llm", type: "prerequisite", confidence })
  }
  return prereqs
}

function cleanPrereqs(prereqs: Prereq[], skills: Map<string, Skill>): Prereq[] {
  const before = prereqs.length

  // 1. Drop dangling refs (either side doesn't exist) and self-loops
  let cleaned = prereqs.filter(p => skills.has(p.skill_id) && skills.has(p.prereq_id))
  const dangling = before - cleaned.length
  const beforeSelf = cleaned.length
  cleaned = cleaned.filter(p => p.skill_id !== p.prereq_id)
  const selfLoops = beforeSelf - cleaned.length

  // 2. Break A<->B cycles
  // "depCount" = how many skills depend on this node (appears as prereq_id)
  const depCount = new Map<string, number>()
  for (const p of cleaned) depCount.set(p.prereq_id, (depCount.get(p.prereq_id) ?? 0) + 1)

  const SOURCE_PRIORITY: Record<string, number> = {
    khan: 5, alcpl: 5, metacademy: 5, opensalt: 5, asn: 5,
    esco: 4, esco_optional: 2, junyi_hierarchy: 3, csp_grade: 3,
    junyi_logs: 2, assistments_logs: 2,
    llm: 1, lcsh_broader: 1, dbpedia_broader: 1, course_skill_atlas: 3,
  }

  // Edge semantics: edgeKey(skill_id, prereq_id) = "skill_id depends on prereq_id"
  const edgeKey = (a: string, b: string) => `${a}|${b}`
  const edgeMap = new Map<string, Prereq>()
  for (const p of cleaned) edgeMap.set(edgeKey(p.skill_id, p.prereq_id), p)
  const cyclePairs = new Set<string>()
  const dropSet = new Set<string>()

  for (const p of cleaned) {
    if (!edgeMap.has(edgeKey(p.prereq_id, p.skill_id))) continue
    const pairKey = [p.skill_id, p.prereq_id].sort().join("|")
    if (cyclePairs.has(pairKey)) continue
    cyclePairs.add(pairKey)

    const fwd = edgeMap.get(edgeKey(p.skill_id, p.prereq_id))!
    const bwd = edgeMap.get(edgeKey(p.prereq_id, p.skill_id))!

    // Resolve: higher source priority wins — drop the lower-priority edge
    const fwdPri = SOURCE_PRIORITY[fwd.source] ?? 0
    const bwdPri = SOURCE_PRIORITY[bwd.source] ?? 0
    if (fwdPri !== bwdPri) {
      const loser = fwdPri < bwdPri ? fwd : bwd
      dropSet.add(edgeKey(loser.skill_id, loser.prereq_id))
      continue
    }

    // Grade heuristic: lower grade = more foundational = should be prereq, not dependent
    const sA = skills.get(p.skill_id)!, sB = skills.get(p.prereq_id)!
    if (sA.grade_start !== null && sB.grade_start !== null && sA.grade_start !== sB.grade_start) {
      // A.grade < B.grade => A is foundational. Drop "A depends on B", keep "B depends on A"
      if (sA.grade_start < sB.grade_start) dropSet.add(edgeKey(p.skill_id, p.prereq_id))
      else dropSet.add(edgeKey(p.prereq_id, p.skill_id))
      continue
    }

    // depCount: more dependents = more foundational = should be prereq, not dependent
    const dA = depCount.get(p.skill_id) ?? 0, dB = depCount.get(p.prereq_id) ?? 0
    if (dA !== dB) {
      // If A has more dependents, A is foundational. Drop "A depends on B" (fwd), keep "B depends on A" (bwd)
      if (dA > dB) dropSet.add(edgeKey(p.skill_id, p.prereq_id))
      else dropSet.add(edgeKey(p.prereq_id, p.skill_id))
      continue
    }

    // No signal: drop both
    dropSet.add(edgeKey(p.skill_id, p.prereq_id))
    dropSet.add(edgeKey(p.prereq_id, p.skill_id))
  }

  cleaned = cleaned.filter(p => !dropSet.has(edgeKey(p.skill_id, p.prereq_id)))
  const cyclesDropped = dropSet.size

  // 3. Break longer cycles (SCCs > 1) among prerequisite-type edges only.
  // Taxonomic "broader" edges form a near-DAG naturally and are too numerous to process repeatedly.
  const sccBroken = { iters: 0, edgesDropped: 0 }
  const MAX_SCC_ITERS = 5
  while (sccBroken.iters < MAX_SCC_ITERS) {
    const adj = new Map<string, Prereq[]>()
    const nodeSet = new Set<string>()
    for (const p of cleaned) {
      if (p.type !== "prerequisite") continue
      nodeSet.add(p.skill_id); nodeSet.add(p.prereq_id)
      let a = adj.get(p.skill_id)
      if (!a) { a = []; adj.set(p.skill_id, a) }
      a.push(p)
    }
    const nodes = [...nodeSet]

    // Tarjan's SCC
    const idxOf = new Map<string, number>()
    const low = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    let counter = 0
    const sccs: string[][] = []
    const strongConnect = (v: string) => {
      const work: Array<{ v: string; iter: Iterator<Prereq> }> = []
      idxOf.set(v, counter); low.set(v, counter); counter++
      stack.push(v); onStack.add(v)
      work.push({ v, iter: (adj.get(v) ?? [])[Symbol.iterator]() })
      while (work.length) {
        const top = work[work.length - 1]
        const n = top.iter.next()
        if (n.done) {
          if (low.get(top.v) === idxOf.get(top.v)) {
            const scc: string[] = []
            while (true) {
              const w = stack.pop()!
              onStack.delete(w)
              scc.push(w)
              if (w === top.v) break
            }
            sccs.push(scc)
          }
          work.pop()
          if (work.length) {
            const parent = work[work.length - 1].v
            low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!))
          }
        } else {
          const w = n.value.prereq_id
          if (!idxOf.has(w)) {
            idxOf.set(w, counter); low.set(w, counter); counter++
            stack.push(w); onStack.add(w)
            work.push({ v: w, iter: (adj.get(w) ?? [])[Symbol.iterator]() })
          } else if (onStack.has(w)) {
            low.set(top.v, Math.min(low.get(top.v)!, idxOf.get(w)!))
          }
        }
      }
    }
    for (const v of nodes) if (!idxOf.has(v)) strongConnect(v)

    const bigSccs = sccs.filter(s => s.length > 1)
    if (!bigSccs.length) break

    // Index node->SCC for O(1) lookup
    const nodeToScc = new Map<string, number>()
    for (let i = 0; i < bigSccs.length; i++) for (const n of bigSccs[i]) nodeToScc.set(n, i)
    // Per-SCC worst edge (lowest priority, keyed by edge-string to drop)
    const worstPerScc: Array<{ key: string; pri: number }> = bigSccs.map(() => ({ key: "", pri: Infinity }))
    for (const p of cleaned) {
      if (p.type !== "prerequisite") continue
      const si = nodeToScc.get(p.skill_id)
      if (si === undefined || nodeToScc.get(p.prereq_id) !== si) continue
      const pri = SOURCE_PRIORITY[p.source] ?? 0
      if (pri < worstPerScc[si].pri) {
        worstPerScc[si] = { key: edgeKey(p.skill_id, p.prereq_id), pri }
      }
    }
    const sccEdgesToDrop = new Set(worstPerScc.map(w => w.key).filter(k => k))
    cleaned = cleaned.filter(p => !sccEdgesToDrop.has(edgeKey(p.skill_id, p.prereq_id)))
    sccBroken.iters++
    sccBroken.edgesDropped += sccEdgesToDrop.size
  }

  console.log(`\n=== Prereq Cleanup ===`)
  console.log(`  Dangling removed: ${dangling}`)
  console.log(`  Self-loops removed: ${selfLoops}`)
  console.log(`  Cycle pairs found: ${cyclePairs.size}, edges dropped: ${cyclesDropped}`)
  console.log(`  SCC cycles broken: ${sccBroken.iters} iters, ${sccBroken.edgesDropped} edges dropped`)
  console.log(`  ${before} -> ${cleaned.length} prereqs`)
  return cleaned
}

function assertInvariants(prereqs: Prereq[]) {
  const emptyTail = (id: string) => {
    const tail = id.split(".").slice(1).join(".")
    return !tail
  }
  let selfLoops = 0, emptyIds = 0
  for (const p of prereqs) {
    if (p.skill_id === p.prereq_id) selfLoops++
    if (emptyTail(p.skill_id) || emptyTail(p.prereq_id)) emptyIds++
  }
  // DAG check (prerequisite edges only — broader taxonomy edges allowed cycles)
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  const nodes = new Set<string>()
  for (const p of prereqs) {
    if (p.type !== "prerequisite") continue
    nodes.add(p.skill_id); nodes.add(p.prereq_id)
    let a = adj.get(p.skill_id); if (!a) { a = []; adj.set(p.skill_id, a) }
    a.push(p.prereq_id)
    indeg.set(p.prereq_id, (indeg.get(p.prereq_id) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const n of nodes) if (!indeg.get(n)) queue.push(n)
  let processed = 0
  while (queue.length) {
    const v = queue.shift()!
    processed++
    for (const w of adj.get(v) ?? []) {
      const d = (indeg.get(w) ?? 0) - 1
      indeg.set(w, d)
      if (!d) queue.push(w)
    }
  }
  const cyclicNodes = nodes.size - processed
  const errs: string[] = []
  if (selfLoops) errs.push(`${selfLoops} self-loops`)
  if (emptyIds) errs.push(`${emptyIds} edges with empty-ID endpoint`)
  if (errs.length) throw new Error(`Invariant violations: ${errs.join("; ")}`)
  if (cyclicNodes) console.warn(`  WARN: ${cyclicNodes} nodes still in prereq cycles after cleanup`)
  console.log(`  Invariants OK (no self-loops, no empty-ID endpoints; ${cyclicNodes} cyclic nodes)`)
}

function printGraphStats(skills: Skill[], prereqs: Prereq[]) {
  console.log("\n=== Graph Quality ===")

  const byType = new Map<string, number>()
  const bySource = new Map<string, number>()
  for (const p of prereqs) {
    byType.set(p.type, (byType.get(p.type) ?? 0) + 1)
    bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1)
  }
  console.log("Edges by type:", [...byType].map(([k, v]) => `${k}=${v}`).join(", "))
  console.log("Edges by source:", [...bySource].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "))

  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const p of prereqs) {
    inDeg.set(p.skill_id, (inDeg.get(p.skill_id) ?? 0) + 1)
    outDeg.set(p.prereq_id, (outDeg.get(p.prereq_id) ?? 0) + 1)
  }
  const connected = new Set([...inDeg.keys(), ...outDeg.keys()])
  const orphans = skills.length - connected.size
  console.log(`Nodes: ${skills.length}, Edges: ${prereqs.length}`)
  console.log(`Connected: ${connected.size} (${(100 * connected.size / skills.length).toFixed(1)}%), Orphans: ${orphans} (${(100 * orphans / skills.length).toFixed(1)}%)`)
  const avgIn = [...inDeg.values()].reduce((a, b) => a + b, 0) / (connected.size || 1)
  const avgOut = [...outDeg.values()].reduce((a, b) => a + b, 0) / (connected.size || 1)
  console.log(`Avg in-degree: ${avgIn.toFixed(2)}, avg out-degree: ${avgOut.toFixed(2)}`)

  const edgeSet = new Set(prereqs.map(p => `${p.skill_id}|${p.prereq_id}`))
  let cycles = 0
  for (const p of prereqs) if (edgeSet.has(`${p.prereq_id}|${p.skill_id}`)) cycles++
  console.log(`Direct A<->B cycles: ${cycles / 2}`)

  const nodeArr = [...connected]
  const idx = new Map<string, number>()
  for (let i = 0; i < nodeArr.length; i++) idx.set(nodeArr[i], i)
  const parent = new Int32Array(nodeArr.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (const p of prereqs) {
    const a = idx.get(p.skill_id), b = idx.get(p.prereq_id)
    if (a !== undefined && b !== undefined) parent[find(a)] = find(b)
  }
  const roots = new Set<number>()
  for (let i = 0; i < nodeArr.length; i++) roots.add(find(i))
  console.log(`Connected components: ${roots.size} (among ${connected.size} connected nodes)`)
}

async function validateAgainstAlcpl(prereqs: Prereq[], idMap: Map<string, string>) {
  const domains = ["data_mining", "geometry", "physics", "precalculus"]
  console.log("\n=== AL-CPL Ground Truth Validation ===")

  // Build set of all prereq edges (using canonical IDs)
  const edgeSet = new Set<string>()
  for (const p of prereqs) edgeSet.add(`${p.prereq_id}|${p.skill_id}`)

  // Build reverse map: canonical ID -> set of original alcpl IDs that merged into it
  const canonToAlcpl = new Map<string, Set<string>>()
  for (const [oldId, canonId] of idMap) {
    if (oldId.startsWith("alcpl.")) {
      let s = canonToAlcpl.get(canonId)
      if (!s) { s = new Set(); canonToAlcpl.set(canonId, s) }
      s.add(oldId)
    }
  }

  for (const domain of domains) {
    let text: string
    try { text = await Deno.readTextFile(`${DATA}/al-cpl/data/${domain}.preqs`) } catch { continue }
    const groundTruth: Array<[string, string]> = []
    for (const line of text.split("\n").filter(l => l.trim())) {
      const [pre, tgt] = line.split(",")
      if (pre && tgt) groundTruth.push([pre.trim(), tgt.trim()])
    }

    let tp = 0, fn = 0
    for (const [pre, tgt] of groundTruth) {
      const preId = idMap.get(`alcpl.${domain}.${pre}`) ?? `alcpl.${domain}.${pre}`
      const tgtId = idMap.get(`alcpl.${domain}.${tgt}`) ?? `alcpl.${domain}.${tgt}`
      if (edgeSet.has(`${preId}|${tgtId}`)) tp++
      else fn++
    }

    // Count edges where both endpoints trace back to this domain's alcpl skills
    const domainPrefix = `alcpl.${domain}.`
    const domainCanonIds = new Set<string>()
    for (const [canonId, origIds] of canonToAlcpl) {
      for (const oid of origIds) if (oid.startsWith(domainPrefix)) { domainCanonIds.add(canonId); break }
    }
    // Also include alcpl IDs that weren't remapped
    for (const p of prereqs) {
      if (p.skill_id.startsWith(domainPrefix)) domainCanonIds.add(p.skill_id)
      if (p.prereq_id.startsWith(domainPrefix)) domainCanonIds.add(p.prereq_id)
    }
    let predicted = 0
    for (const p of prereqs) {
      if (domainCanonIds.has(p.skill_id) && domainCanonIds.has(p.prereq_id)) predicted++
    }
    const fp = Math.max(0, predicted - tp)
    const precision = predicted > 0 ? tp / predicted : 0
    const recall = groundTruth.length > 0 ? tp / groundTruth.length : 0
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0
    console.log(`  ${domain}: P=${precision.toFixed(3)} R=${recall.toFixed(3)} F1=${f1.toFixed(3)} (TP=${tp} FP=${fp} FN=${fn} gold=${groundTruth.length} predicted=${predicted})`)
  }
}

function auditLlmEdges(prereqs: Prereq[], skills: Map<string, Skill>, n = 20) {
  const llm = prereqs.filter(p => p.source === "llm")
  if (!llm.length) return
  for (let i = llm.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [llm[i], llm[j]] = [llm[j], llm[i]]
  }
  console.log(`\n=== LLM Edge Audit (${n} of ${llm.length}) ===`)
  for (const p of llm.slice(0, n)) {
    const sLabel = skills.get(p.skill_id)?.label ?? p.skill_id
    const rLabel = skills.get(p.prereq_id)?.label ?? p.prereq_id
    console.log(`  ${rLabel} -> ${sLabel}`)
  }
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
    ["ngss", parseNgss],
    ["wikidata", parseWikidata],
    ["lightcast", parseLightcast],
    ["lcsh", parseLcsh],
    ["dbpedia", parseDbpedia],
    ["course-skill-atlas", parseCourseSkillAtlas],
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
      for (const p of r.prereqs) allPrereqs.push(p)
      for (const l of r.levels) allLevels.push(l)
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

  console.log("  CSP grade sequencing...")
  const cspPrereqs = inferCspGradePrereqs(allSkills)
  allPrereqs.push(...cspPrereqs)

  console.log("  LLM prereqs...")
  const llmPrereqs = await loadLlmPrereqs()
  allPrereqs.push(...llmPrereqs)
  console.log(`  ${llmPrereqs.length} LLM prereqs`)

  // Merge duplicate skills by label
  console.log("\nMerging skills by label...")
  const mergeResult = await mergeSkills(allSkills, allPrereqs, allLevels)
  console.log(`  ${allSkills.length} -> ${mergeResult.skills.length} skills (${allSkills.length - mergeResult.skills.length} merged)`)
  console.log(`  ${allPrereqs.length} -> ${mergeResult.prereqs.length} prereqs after rewrite`)

  // Post-merge label filter (merge can pick a long label)
  const finalSkills = mergeResult.skills.filter(s => isValidLabel(s.label))

  const mergedById = new Map<string, Skill>()
  for (const s of finalSkills) mergedById.set(s.id, s)

  const cleanedPrereqs = cleanPrereqs(mergeResult.prereqs, mergedById)
  assertInvariants(cleanedPrereqs)

  console.log(`\nTotals: ${finalSkills.length} skills, ${cleanedPrereqs.length} prereqs, ${mergeResult.levels.length} levels`)

  const curatedSkills = finalSkills.filter(s => !isTaxonomyId(s.id))
  const taxonomySkills = finalSkills.filter(s => isTaxonomyId(s.id))
  const curatedPrereqs = cleanedPrereqs.filter(p => !isTaxonomyId(p.skill_id) && !isTaxonomyId(p.prereq_id))
  const taxonomyEdges = cleanedPrereqs.filter(p => isTaxonomyId(p.skill_id) || isTaxonomyId(p.prereq_id))

  writeSkillsTsv(curatedSkills)
  console.log(`Wrote skills.tsv (${curatedSkills.length} curated)`)
  const gz = new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] })
  const gzr = await gz.output()
  if (gzr.success) console.log("Wrote skills.tsv.gz")
  else console.error("Failed to gzip skills.tsv")

  writeSkillsTsv(taxonomySkills, "taxonomy.tsv")
  console.log(`Wrote taxonomy.tsv (${taxonomySkills.length} taxonomy)`)
  const gz2 = new Deno.Command("gzip", { args: ["-kf", "taxonomy.tsv"] })
  await gz2.output()

  writePrereqsTsv(curatedPrereqs)
  console.log(`Wrote prereqs.tsv (${curatedPrereqs.length} curated edges)`)
  writePrereqsTsv(taxonomyEdges, "taxonomy_edges.tsv")
  console.log(`Wrote taxonomy_edges.tsv (${taxonomyEdges.length} taxonomy edges)`)
  writeLevelsTsv(mergeResult.levels)
  console.log("Wrote levels.tsv")
  writeSkillsSourcesTsv(curatedSkills)
  console.log("Wrote skills_sources.tsv")
  await writeEmbeddings(curatedSkills)
  console.log("Wrote embeddings.bin + embeddings_ids.tsv")
  writeDot(mergedById, curatedPrereqs)
  console.log("Wrote skills.dot")
  writeVizJson(mergedById, curatedPrereqs)
  console.log("Wrote viz.json")

  printGraphStats(finalSkills, cleanedPrereqs)
  await validateAgainstAlcpl(cleanedPrereqs, mergeResult.idMap)
  auditLlmEdges(cleanedPrereqs, mergedById)
}

main()
