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
  return s.replace(/[\t\n\r]/g, " ").trim()
}

function skill(id: string, label: string, opts?: Partial<Skill>): Skill {
  return {
    id, ext_ids: [], ext_urls: [], label: sanitize(label), description: "",
    tags: [], grade_start: null, grade_end: null, ...opts,
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

// 7. MOOCCubeX
async function parseMooccubex(): Promise<Result> {
  const domains = ["cs", "math", "psy"]
  const skills: Skill[] = []
  const prereqs: Prereq[] = []

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
      skills.push(skill(id, name, { tags: [domain] }))
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
  const gradeMap: Record<string, [number, number]> = {
    elementary: [1, 6], junior: [7, 9], senior: [10, 12],
  }
  const skills = rows.map(r => {
    const grades = gradeMap[r["learning_stage"]] ?? [null, null]
    return skill(`junyi.${r["ucid"]}`, r["content_pretty_name"] || "", {
      tags: [r["subject"], r["learning_stage"]].filter(Boolean),
      grade_start: grades[0], grade_end: grades[1],
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

      for (const std of Object.values(ss.standards)) {
        const id = std.statementNotation ? `csp.${std.statementNotation}` : `csp.${std.id}`
        const extIds = [std.asnIdentifier, std.id].filter(Boolean) as string[]
        skills.push(skill(id, std.description || "", {
          ext_ids: extIds,
          tags: [ss.subject?.toLowerCase(), j.title.toLowerCase()].filter(Boolean) as string[],
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
      const code = item.humanCodingScheme || item.identifier
      const id = `opensalt.${code}`
      itemIdMap.set(item.identifier, id)
      const gradeNums = (item.educationLevel || []).map(parseGrade).filter((g): g is number => g !== null)
      skills.push(skill(id, item.fullStatement || code, {
        tags: [item.CFItemType?.toLowerCase(), fw.title.toLowerCase()].filter(Boolean) as string[],
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

// Merge skills with identical labels, accumulating ext_ids and rewriting prereqs

function mergeSkills(
  skills: Skill[], prereqs: Prereq[], levels: Level[]
): { skills: Skill[]; prereqs: Prereq[]; levels: Level[]; idMap: Map<string, string> } {
  // Group by lowercase label
  const byLabel = new Map<string, Skill[]>()
  for (const s of skills) {
    const key = s.label.toLowerCase().trim()
    if (!key) { byLabel.set(s.id, [s]); continue } // empty label: keep as-is
    const arr = byLabel.get(key)
    if (arr) arr.push(s)
    else byLabel.set(key, [s])
  }

  const merged: Skill[] = []
  const idMap = new Map<string, string>() // old id -> canonical id
  for (const group of byLabel.values()) {
    if (group.length === 1) {
      merged.push(group[0])
      idMap.set(group[0].id, group[0].id)
      continue
    }
    // Pick canonical: prefer shortest ID with a dot-separated notation (not a hex hash)
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
      allExtIds.add(s.id) // old id becomes an ext_id
      for (const x of s.ext_ids) allExtIds.add(x)
      for (const u of s.ext_urls) allExtUrls.add(u)
      for (const t of s.tags) allTags.add(t)
      if (s.grade_start !== null && (gStart === null || s.grade_start < gStart)) gStart = s.grade_start
      if (s.grade_end !== null && (gEnd === null || s.grade_end > gEnd)) gEnd = s.grade_end
      if (!desc && s.description) desc = s.description
    }
    idMap.set(canon.id, canon.id)
    canon.ext_ids = [...allExtIds]
    canon.ext_urls = [...allExtUrls]
    canon.tags = [...allTags]
    canon.grade_start = gStart
    canon.grade_end = gEnd
    canon.description = desc
    merged.push(canon)
  }

  // Rewrite prereq IDs
  const mergedPrereqs = prereqs.map(p => ({
    skill_id: idMap.get(p.skill_id) ?? p.skill_id,
    prereq_id: idMap.get(p.prereq_id) ?? p.prereq_id,
    source: p.source,
  })).filter(p => p.skill_id !== p.prereq_id) // drop self-loops from merging

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
    s.ext_ids.join(";"),
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
    ["lightcast", parseLightcast],
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
      for (const s of r.skills) {
        if (byId.has(s.id)) {
          console.error(`  WARN: duplicate id ${s.id}, skipping`)
          continue
        }
        byId.set(s.id, s)
        allSkills.push(s)
      }
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
  const mergeResult = mergeSkills(allSkills, allPrereqs, allLevels)
  console.log(`  ${allSkills.length} -> ${mergeResult.skills.length} skills (${allSkills.length - mergeResult.skills.length} merged)`)
  console.log(`  ${allPrereqs.length} -> ${mergeResult.prereqs.length} prereqs after rewrite`)

  const mergedById = new Map<string, Skill>()
  for (const s of mergeResult.skills) mergedById.set(s.id, s)

  console.log(`\nTotals: ${mergeResult.skills.length} skills, ${mergeResult.prereqs.length} prereqs, ${mergeResult.levels.length} levels`)

  writeSkillsTsv(mergeResult.skills)
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
}

main()
