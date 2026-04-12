// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write csp_hierarchy.ts
// Re-parses CSP JSONs, emits parent→child "broader" edges, and adds missing parent skills.
// Appends to skills.tsv and prereqs.tsv.

const DATA = "data/common-standards-project";
const NON_ENGLISH = new Set([
  "québec", "quebec", "québec (français)", "quebec (english)",
  "puerto rico", "guam", "american samoa",
  "ontario", "ontario (français)",
  "new brunswick (français)",
  "colombie-britannique / british columbia (français)",
  "alberta (français)",
]);

function sanitize(s: string): string {
  let t = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/<[^>]*>/g, " ").replace(/\[cite_start\]/g, "").replace(/\*\*/g, "").replace(/[\t\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return t;
}
function sanitizeId(s: string): string { return s.replace(/[\t\n\r; ]/g, "_").trim(); }
function isValidLabel(s: string): boolean {
  if (!s || !s.trim()) return false;
  if (/^\(.*\)$/.test(s.trim())) return false;
  if (s.length > 1500) return false;
  return true;
}
function parseGrade(s: string): number | null {
  if (!s) return null;
  const up = s.toUpperCase().trim();
  if (up === "PK" || up === "PRE-K" || up === "KG" || up === "K") return 0;
  if (up === "HS") return 9;
  const n = parseInt(up);
  return isNaN(n) ? null : n;
}

function cspId(std: { id: string; statementNotation?: string }): string {
  const notation = std.statementNotation ? sanitizeId(std.statementNotation) : "";
  return notation ? `csp.${notation}` : `csp.${sanitizeId(std.id)}`;
}

// --- load existing skills.tsv to know which IDs are already present
console.log("loading skills.tsv…");
const skillsText = await Deno.readTextFile("skills.tsv");
const lines = skillsText.split("\n");
const header = lines[0];
const cols = header.split("\t");
const iId = cols.indexOf("id");
const existing = new Set<string>();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const tab = lines[i].indexOf("\t");
  if (tab > 0) existing.add(lines[i].slice(0, tab));
}
console.log(`  ${existing.size} existing skills`);

// --- walk CSP
const jurisdictions: { id: string; title: string }[] = JSON.parse(await Deno.readTextFile(`${DATA}/jurisdictions.json`));
type Std = { id: string; statementNotation?: string; description?: string; asnIdentifier?: string; parentId?: string };

const newSkillRows: string[] = [];
const newEdges: string[] = [];
const addedNewSkill = new Set<string>();
let emittedEdges = 0;
let newParentSkills = 0;

for (const j of jurisdictions) {
  if (NON_ENGLISH.has(j.title.toLowerCase())) continue;
  // deno-lint-ignore no-explicit-any
  let data: any;
  try {
    data = JSON.parse(await Deno.readTextFile(`${DATA}/${j.id}.json`));
  } catch { continue; }
  const sets: Array<{
    id: string; title: string; subject?: string; educationLevels?: string[];
    standards?: Record<string, Std>;
  }> = data.standardSets ?? [];

  for (const ss of sets) {
    if (!ss.standards) continue;
    const gradeNums = (ss.educationLevels || []).map(parseGrade).filter((g): g is number => g !== null);
    const gStart = gradeNums.length ? Math.min(...gradeNums) : "";
    const gEnd = gradeNums.length ? Math.max(...gradeNums) : "";
    const subject = ss.subject ? ss.subject.toLowerCase().trim() : "";

    const byId = ss.standards;
    for (const std of Object.values(byId)) {
      if (!std.parentId) continue;
      const parent = byId[std.parentId];
      if (!parent) continue;
      const childIdCanon = cspId(std);
      const parentIdCanon = cspId(parent);
      if (childIdCanon === parentIdCanon) continue;
      // emit parent as new skill if missing AND it has a valid label
      if (!existing.has(parentIdCanon) && !addedNewSkill.has(parentIdCanon)) {
        const plabel = sanitize(parent.description || parent.statementNotation || "");
        if (!isValidLabel(plabel)) continue;
        // skills.tsv columns: id,ext_ids,ext_urls,label,description,tags,source,grade_start,grade_end
        const extIds = [parent.asnIdentifier, parent.id].filter(Boolean).join(";");
        const tags = [subject, "csp-parent"].filter(Boolean).join(";");
        newSkillRows.push([
          parentIdCanon, extIds, "", plabel, "", tags, "csp",
          String(gStart), String(gEnd),
        ].join("\t"));
        addedNewSkill.add(parentIdCanon);
        newParentSkills++;
      }
      // emit edge only if both ends will exist
      const parentExists = existing.has(parentIdCanon) || addedNewSkill.has(parentIdCanon);
      const childExists = existing.has(childIdCanon) || addedNewSkill.has(childIdCanon);
      if (!parentExists || !childExists) continue;
      // child broader-than parent: skill_id=child, prereq_id=parent, type=broader
      newEdges.push([childIdCanon, parentIdCanon, "csp_parent", "broader", "1.00"].join("\t"));
      emittedEdges++;
    }
  }
}
console.log(`  emitted ${emittedEdges} edges, ${newParentSkills} new parent skills`);

// --- append to skills.tsv
if (newSkillRows.length) {
  const existingText = await Deno.readTextFile("skills.tsv");
  const needsNewline = !existingText.endsWith("\n");
  await Deno.writeTextFile("skills.tsv", (needsNewline ? existingText + "\n" : existingText) + newSkillRows.join("\n") + "\n");
  console.log(`  appended ${newSkillRows.length} skills`);
}

// --- append to prereqs.tsv (dedup against existing)
if (newEdges.length) {
  const prereqText = await Deno.readTextFile("prereqs.tsv");
  const seenEdges = new Set<string>();
  const pLines = prereqText.split("\n");
  for (let i = 1; i < pLines.length; i++) {
    if (!pLines[i]) continue;
    const parts = pLines[i].split("\t");
    seenEdges.add(`${parts[0]}\t${parts[1]}`);
  }
  const addLines: string[] = [];
  for (const e of newEdges) {
    const parts = e.split("\t");
    const k = `${parts[0]}\t${parts[1]}`;
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    addLines.push(e);
  }
  const needsNewline = !prereqText.endsWith("\n");
  await Deno.writeTextFile("prereqs.tsv", (needsNewline ? prereqText + "\n" : prereqText) + addLines.join("\n") + "\n");
  console.log(`  appended ${addLines.length} edges (${newEdges.length - addLines.length} dups skipped)`);
}
