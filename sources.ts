import { DOMParser, type Element } from "@b-fuze/deno-dom";
import { TextLineStream } from "@std/streams/text-line-stream";
import {
  ALIASES,
  BUILD,
  cleanDef,
  col,
  decodeEntities,
  embeddingFallback,
  h32,
  HAN_RE,
  isTranslation,
  LC_EXTRACT,
  LC_IDS,
  loadTsvCache,
  readCoursePairs,
  readCsv,
  readJson,
  readLearningCommons,
  readMoocPairs,
  readTable,
  readTsv,
  resolveConcept,
  resumableClaude,
  SEEDS,
  Skill,
  SKILL_LIST,
  skillIndex,
  slugBase,
  slugify,
  STOPWORDS,
  stronglyConnected,
  TAGGED_DEDUPED,
  TOPIC_REFS,
  TRANSLATE_CACHE,
  writeStats,
  writeTable,
} from "./lib.ts";

// ---------- stage list ----------

// textContent glues blocks: "<p>variable.</p><p>Use" reads "variable.Use".
const BLOCKS =
  "br, p, div, li, ul, ol, tr, td, th, table, blockquote, h1, h2, h3, h4, h5, h6";
const DOM = new DOMParser();
const htmlText = (s: string, where: string): string => {
  // Without `<` or `&` the parse changes nothing, and parsing all ~200k fields
  // multiplies the stage's time by 5.
  if (!/[<&]/.test(s)) return s;
  const doc = DOM.parseFromString(s, "text/html");
  // Head elements drop their text from body; script and style leak code into it.
  const bad = doc.querySelector("script, style, title, meta, link, base");
  if (bad) {
    throw new Error(
      `${where}: expected statement markup, received a <${bad.tagName.toLowerCase()}> element in ${
        JSON.stringify(s.slice(0, 120))
      }. Drop the item from the framework file, or teach htmlText to read the element.`,
    );
  }
  for (const b of doc.querySelectorAll(BLOCKS)) (b as Element).before(" ");
  return doc.body.textContent;
};

const normalizeText = (s: string, decode = true): string => {
  if (!s) return "";
  let t = decode ? decodeEntities(s) : s;
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(
    /[\u201C\u201D\u201E\u201F]/g,
    '"',
  );
  t = t.replace(/[\u2010\u2011\u2012\u2013\u2014]/g, "-");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

const denoiseTitle = (s: string): string => {
  if (!s) return "";
  let t = s;
  t = t.replace(/\s*\((?:e\.g\.|i\.e\.)[^)]*\)/gi, "");
  t = t.replace(/\s*\([^)]{60,}\)/g, "");
  t = t.replace(/,?\s+such as\b[^.]*\.?$/i, ".");
  t = t.replace(
    /^(perform|conduct|provide|ensure|coordinate)\s+(the|an?|of)\s+/i,
    "$1 ",
  );
  t = t.replace(/[\s:;\-–—]+$/g, "");
  t = t.replace(/^[•▪►■◆]\s*/, "");
  t = t.replace(/^\d+\.\s+/, "");
  t = t.replace(/\s+\([A-Z]\)$/g, "");
  t = t.replace(/\s+\(Supplemental\)$/gi, "");
  t = t.replace(/\.$/g, "");
  t = t.replace(/;?\s+and$/i, "");
  t = t.replace(/\$([^$]+)\$/g, "$1");
  t = t.replace(/\\bmod\b/g, "mod").replace(/\\small\b\s*/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

const sentenceCase = (s: string): string => {
  if (!s) return s;
  if (s[0] === s[0].toUpperCase() && s[0] !== s[0].toLowerCase()) return s;
  return s[0].toUpperCase() + s.slice(1);
};

const stripStudentPrefix = (s: string): string => {
  if (!s) return s;
  const t = s.replace(/^(the\s+)?students?\s+will\s+(be\s+able\s+to\s+)?/i, "")
    .replace(/^students?\s+can\s+/i, "")
    .replace(/^by\s+the\s+end\s+of[^,.]+,\s*/i, "")
    .replace(/^upon\s+completion[^,.]+,\s*/i, "")
    .replace(/^(tswbat|swbat)[:\s]+/i, "")
    .trim();
  if (!t) return s;
  return t[0].toUpperCase() + t.slice(1);
};

// Deno.readDirSync order is the filesystem's; sort so builds match across hosts.
const readDirSorted = (path: string): Deno.DirEntry[] =>
  [...Deno.readDirSync(path)].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

const INFILL_CACHE = `${BUILD}/1b_infill.tsv`;
// The model's answer for a Lightcast name it cannot define.
const INFILL_SKIP = "SKIP";
const SUMMARIZE_CACHE = `${BUILD}/1c_summarize.tsv`;
// The prompt asks for 3-7 words. Past 15, the model thinks out loud ("Wait,
// that exceeds 7 words. Shortened version: ...").
// A summary exists to give an id without a hex suffix, so its slug fits 80.
const isSummary = (t: string) =>
  t.split(/\s+/).filter(Boolean).length <= 15 && slugBase(t).length <= 80;
const ONET_DESC_CACHE = `${BUILD}/1d_onet_desc.tsv`;
const OPENSALT_DESC_CACHE = `${BUILD}/1e_opensalt_desc.tsv`;

// ---------- BNCC (Brazil's national curriculum) ----------

const BNCC_TRANSLATE_CACHE = `${BUILD}/1g_bncc_translate.tsv`;
// A Portuguese function word means the model echoed or half-translated.
const PORTUGUESE_RE = /\b(?:não|para|uma|pelos?|pelas?|dos|das)\b|ções\b/i;
const isBnccTranslation = (t: string | undefined): t is string =>
  !!t?.trim() && !PORTUGUESE_RE.test(t) && !/[\t\r\n]/.test(t);

const BNCC_SUBJECTS: Record<string, string> = {
  AR: "Art",
  CI: "Science",
  EF: "Physical education",
  ER: "Religious education",
  GE: "Geography",
  HI: "History",
  LI: "English language",
  LP: "Portuguese language",
  MA: "Mathematics",
  LGG: "Languages",
  MAT: "Mathematics",
  CNT: "Natural sciences",
  CHS: "Human and social sciences",
};
// Early-childhood fields of experience: EI01CG01 is field CG.
const BNCC_FIELDS: Record<string, string> = {
  CG: "Body, gestures, and movement",
  EO: "The self, the other, and us",
  TS: "Traces, sounds, colors, and shapes",
  EF: "Listening, speaking, thinking, and imagination",
  ET: "Spaces, times, quantities, relations, and transformations",
};

type BnccRow = {
  code: string;
  text: string;
  grades: string[];
  subject: string;
};

// The code carries grade and subject: EF67LP08 is grades 6–7, Portuguese.
// EI01–EI03 are age bands from babies to 5-year-olds; all three map to PK.
// EM13 spans the three upper-secondary years, grades 10–12.
function readBncc(): BnccRow[] {
  const rows: BnccRow[] = [];
  const seen = new Map<string, string>();
  const fix = "Re-download it: rm -r data/bncc; deno run -A data/download.ts";
  for (
    const [file, key] of [
      ["educacao-infantil", "objetivos"],
      ["ensino-fundamental", "habilidades"],
      ["ensino-medio", "habilidades"],
    ]
  ) {
    const path = `data/bncc/${file}.json.gz`;
    const out = new Deno.Command("gzip", {
      args: ["-dc", path],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    let doc: Record<string, unknown>;
    try {
      if (out.code !== 0) throw new Error(`gzip exit ${out.code}`);
      doc = JSON.parse(new TextDecoder().decode(out.stdout));
    } catch (e) {
      throw new Error(
        `${path}: expected gzipped JSON, received ${(e as Error).message}: ${
          new TextDecoder().decode(out.stderr).trim()
        }. ${fix}`,
      );
    }
    const list = doc[key];
    if (!Array.isArray(list) || !list.length) {
      throw new Error(
        `${path}: expected a non-empty "${key}" array, received ${
          JSON.stringify(list)?.slice(0, 80)
        }. ${fix}`,
      );
    }
    for (const r of list as Record<string, unknown>[]) {
      const where = `${path} ${JSON.stringify(r.codigo)}`;
      const code = String(r.codigo);
      const text = typeof r.texto === "string" ? r.texto.trim() : "";
      const status = (r.vigencia as { status?: unknown } | undefined)?.status;
      if (!text || status !== "vigente") {
        throw new Error(
          `${where}: expected a non-empty texto and vigencia.status "vigente", received ${
            JSON.stringify([r.texto, status]).slice(0, 120)
          }. A revoked row needs a filter here. ${fix}`,
        );
      }
      const ei = code.match(/^EI0([1-3])(CG|EO|TS|EF|ET)\d{2}$/);
      const ef = code.match(/^EF(\d)(\d)(AR|CI|EF|ER|GE|HI|LI|LP|MA)\d{2}$/);
      // Areas number with 3 digits (EM13MAT101), Portuguese with 2 (EM13LP01).
      const em = code.match(/^EM13(?:(LGG|MAT|CNT|CHS)\d{3}|(LP)\d{2})$/);
      let row: BnccRow | undefined;
      if (ei && r.grupo_etario === `ei-grupo-0${ei[1]}`) {
        row = { code, text, grades: ["PK"], subject: BNCC_FIELDS[ei[2]] };
      } else if (ef) {
        const [lo, hi] = ef[1] === "0" ? [+ef[2], +ef[2]] : [+ef[1], +ef[2]];
        const anos = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        if (JSON.stringify(anos) === JSON.stringify(r.anos)) {
          row = {
            code,
            text,
            grades: anos.map(String),
            subject: BNCC_SUBJECTS[ef[3]],
          };
        }
      } else if (em) {
        row = {
          code,
          text,
          grades: ["10", "11", "12"],
          subject: BNCC_SUBJECTS[em[1] ?? em[2]],
        };
      }
      if (!row) {
        throw new Error(
          `${where}: expected a code EI0[1-3]<field>NN with its age group, EF<years><subject>NN with matching anos, EM13<area>NNN, or EM13LPNN, received ${
            JSON.stringify([code, r.grupo_etario ?? r.anos])
          }. ${fix}`,
        );
      }
      const first = seen.get(code);
      if (first) {
        throw new Error(
          `${where}: expected a unique code, received a second "${code}" (first in ${first}). ${fix}`,
        );
      }
      seen.set(code, path);
      rows.push(row);
    }
  }
  return rows;
}

const SHORT_TECH_WHITELIST = new Set([
  "r",
  "go",
  "c#",
  "c++",
  "ada",
  "apl",
  "awk",
  "css",
  "db2",
  "git",
  "ios",
  "jet",
  "lua",
  "mdx",
  "mmx",
  "php",
  "qml",
  "sql",
  "tcl",
  "xml",
  "yml",
  "vim",
  "tex",
  "rsa",
]);

type Foundations = {
  foundations: {
    id: string;
    title: string;
    description: string;
    grade_start?: number;
    grade_end?: number;
  }[];
  seed_edges: {
    prereq: string;
    dependent?: string;
    dependent_pattern?: string;
  }[];
};

const FOUNDATIONS_PATH = "data/_foundations.json";

function readFoundations(): Foundations {
  const f = readJson(FOUNDATIONS_PATH) as Foundations;
  const bad = (expected: string, received: unknown) =>
    new Error(
      `${FOUNDATIONS_PATH}: expected ${expected}.\n  received: ${
        JSON.stringify(received)
      }\n  Fix that record.`,
    );
  if (!Array.isArray(f.foundations) || !Array.isArray(f.seed_edges)) {
    throw bad("{foundations: [...], seed_edges: [...]}", Object.keys(f));
  }
  const ids = new Set<string>();
  for (const fd of f.foundations) {
    if (ids.has(fd.id)) throw bad("unique ids", fd);
    if (
      typeof fd.title !== "string" || typeof fd.description !== "string" ||
      !fd.description
    ) {
      throw bad("a title and a non-empty description", fd);
    }
    if (fd.id !== slugify(fd.title)) {
      throw bad(`id "${slugify(fd.title)}", the slug of the title`, fd);
    }
    for (const g of [fd.grade_start, fd.grade_end]) {
      if (g !== undefined && !(Number.isInteger(g) && g >= -1 && g <= 12)) {
        throw bad("grades as integers from -1 (PK) to 12", fd);
      }
    }
    if ((fd.grade_start ?? -1) > (fd.grade_end ?? 12)) {
      throw bad("grade_start at or below grade_end", fd);
    }
    ids.add(fd.id);
  }
  for (const e of f.seed_edges) {
    const dep = e.dependent, pat = e.dependent_pattern;
    const depOk = typeof dep === "string" && ids.has(dep) && dep !== e.prereq &&
      pat === undefined;
    const patOk = typeof pat === "string" && pat !== "" && dep === undefined;
    if (!ids.has(e.prereq) || !(depOk || patOk)) {
      throw bad(
        "a foundation prereq plus exactly one of another foundation as dependent or a non-empty dependent_pattern",
        e,
      );
    }
    if (patOk) {
      try {
        new RegExp(pat);
      } catch (err) {
        throw bad(`a valid regex (${(err as Error).message})`, e);
      }
    }
  }
  return f;
}

const SCAFFOLDING_TYPES = new Set([
  "Grade Level",
  "Domain",
  "Strand",
  "Course",
  "Topic",
  "Cluster",
  "Component",
  "Section",
  "Module",
  "Chapter",
  "Unit",
  "Sub-Domain",
  "Category",
  "Connection",
  "Grade",
  "Grade Band",
  "Quarter",
  "Section Heading",
  "Pathway",
  "Subject",
  "Dimension",
  "Cognitive Complexity",
  "Performance Level",
  "Assignment",
  "Lesson",
  "Job Role",
  "Employee",
  "Team Leader",
  "People Leader",
  "Senior Leader",
  // Kentucky social studies: "E: Microeconomics" heads a kindergarten strand.
  "Concepts and Practices",
]);
const SCAFFOLDING_RE =
  /^(\s*)?(grade|kindergarten|pre-?k|elementary|middle school|high school|[0-9]+(st|nd|rd|th)\s+grade|unit\s+\d|chapter\s+\d|section\s+\d|module\s+\d|standard\s+\d|topic\s+\d|strand|domain)\b/i;
const SCAFFOLDING_SIMPLE_RE = new RegExp(
  [
    /^DEPRECATED\b/,
    /^(?:Use the (?:clock|timer)|Click the|Press the|Drag the|Open the app)/,
    /^(?:Constructed Response|Hook Activity|Background Information|Vocabulary Activity|Document Analysis)\s*:/,
    /^(?:Sample Problem|Example)\s*:/,
    /^Particular Topics in /,
    /^(?:CFItemType|Course|Subject)\s*:/,
    /\?\s*(?:Hook Activity|Background Information|Vocabulary Activity|Document Analysis|Writing)$/,
    /\s+(?:Hook Activity|Writing Activity|Vocabulary Activity|Assessment Activity)$/,
    /^(?:Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]*/,
    /^with\s+(?:prompting|guidance|support)\b/,
    /^by\s+(?:date|the\s+end\s+of)\b/,
    /^(?:train|instruct|teach)\s+\w+s?\s+to\b/,
  ].map((r) => r.source).join("|"),
  "i",
);
// Learning Commons statements carry Markdown emphasis ("Encode words with
// _or_ after _w_") and a scaffold lead ("*With modeling, prompting, and
// support* ask and answer questions"). The skill is the text after the lead.
// A lead with no comma or marker after it names no skill, and stays.
const LEAD_WORD =
  "(?:verbal\\s+)?(?:modeling|prompting|prompts|guidance|support)\\b";
const SCAFFOLD_LEAD = new RegExp(
  `^[*_]*with\\s+${LEAD_WORD}(?:(?:\\s*,\\s*|\\s+)(?:(?:and|or)\\s+)?${LEAD_WORD})*` +
    `[^,*_]*[,*_][,*_\\s]*`,
  "i",
);
const EMPHASIS =
  /(^|[\s("'“])[*_]+([^*_\s](?:[^*_]*[^*_\s])?)[*_]+(?=[\s,.;:)!?"'”]|$)/g;
// "* recognize own name in print" leads with a bullet.
const unmark = (t: string) =>
  t.replace(/^\*\s+/, "").replace(SCAFFOLD_LEAD, "").replace(EMPHASIS, "$1$2");
// CASE educationLevel uses "KG" and "TK"; stage difficulty expects "K".
const normGrade = (g: string): string => {
  const u = g.trim().toUpperCase();
  if (u === "KG" || u === "TK") return "K";
  if (u === "PR" || u === "PRE-K" || u === "PRE-KINDERGARTEN") return "PK";
  return u;
};
const truncTitle = (t: string, cap: number): string => {
  if (t.length <= cap) return t;
  const head = t.slice(0, cap);
  const lastDot = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
  );
  if (lastDot > cap * 0.5) return head.slice(0, lastDot + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > cap * 0.5 ? head.slice(0, lastSpace) : head).trim() +
    "…";
};
type Standard = {
  title: string;
  description: string;
  stuPrefix: boolean;
  truncated: boolean;
};

// The OpenSALT and Learning Commons statements share these filters. A bare
// statement has no abbreviation or notes; typed means the source gave a type.
function cleanStandard(
  fullStmt: string,
  abbrev: string,
  notes: string,
  typed: boolean,
): Standard | "scaffPat" | "pureVerb" {
  if (!fullStmt && !abbrev) {
    return "scaffPat";
  }
  const CODE_RE = /^[A-Z0-9\u2013\u2014–-][\w.\u2013\u2014–-]*$/;
  let title: string, description: string;
  if (
    abbrev && (!fullStmt || abbrev.length < fullStmt.length) &&
    !(abbrev.length <= 20 && CODE_RE.test(abbrev))
  ) {
    title = abbrev;
    description = fullStmt && fullStmt !== abbrev ? fullStmt : notes;
  } else {
    title = fullStmt;
    description = notes && notes !== fullStmt ? notes : "";
  }
  title = unmark(
    title.replace(/^[•▪►■◆]\s*/, "").replace(/^\d+\.\s+/, ""),
  );
  const before = title;
  title = stripStudentPrefix(title);
  title = title.replace(
    /^(Can|Could|Should|How to|What is|Why does)\s+/i,
    (_m, _g, _off, _s) => "",
  );
  if (title && title[0] === title[0].toLowerCase()) {
    title = title[0].toUpperCase() + title.slice(1);
  }
  const stuPrefix = title !== before;
  title = title.replace(
    /^(Benchmark|Standard|Indicator)\s+[\d.]+\s*:\s*/i,
    "",
  ).trim();
  let truncated = false;
  if (title.length > 300) {
    title = truncTitle(title, 300);
    truncated = true;
  }
  if (title.length <= 2 || (title.length <= 20 && CODE_RE.test(title))) {
    return "scaffPat";
  }
  if (SCAFFOLDING_SIMPLE_RE.test(title)) {
    return "scaffPat";
  }
  if (
    /^(Essential|Proficient|Advanced|Intermediate|Beginning|Emerging|Developing|Extending|Exceeding|Level)\s+[IVX0-9]+/i
      .test(title) && title.length < 30
  ) {
    return "scaffPat";
  }
  if (/^You\s+[a-z]/i.test(title) && title.length > 20) {
    return "scaffPat";
  }
  // A bare acronym ("WCAG", "IoT") is a label, not a standard.
  if (!/\s/.test(title) && title.length < 30) {
    return "scaffPat";
  }
  if (SCAFFOLDING_RE.test(title) && title.length < 50 && !typed) {
    return "scaffPat";
  }
  if (
    /^(understand|recognize|demonstrate|apply|identify|know|explain|describe)\s+(the|how|that|what|why|when|where|a|an)\s/i
      .test(title) &&
    title.length < 60 && !typed
  ) {
    return "pureVerb";
  }
  description = description.replace(
    /^(Students?\s+(will|demonstrate)|The student|This unit|Module \d+|The course|Courses)\s[^.]*?\.\s+/i,
    "",
  );
  return { title, description, stuPrefix, truncated };
}

// Stage finalize shows a code:* tag as a display title, so a sub-item label
// like "a" must not become one.
const codeTag = (raw: string): string | null => {
  const code = raw.trim().replace(/^Khan\s+/i, "");
  return code.length >= 4 && (/[A-Z]/.test(code) || /\./.test(code))
    ? `code:${code}`
    : null;
};

export function stageList() {
  const foundations = readFoundations();
  console.log("[list] reading sources…");
  const infill = loadTsvCache(INFILL_CACHE);
  const summarize = loadTsvCache(SUMMARIZE_CACHE);
  const onetDesc = loadTsvCache(ONET_DESC_CACHE);
  const opensaltDesc = loadTsvCache(OPENSALT_DESC_CACHE);
  console.log(
    `[list] caches: infill=${infill.size} summarize=${summarize.size} onet_desc=${onetDesc.size} opensalt_desc=${opensaltDesc.size}`,
  );
  const raw: Skill[] = [];

  // ESCO
  {
    const rows = readCsv("data/esco/skills_en.csv");
    const iLabel = col(rows, "preferredLabel", "data/esco/skills_en.csv"),
      iDesc = col(rows, "description", "data/esco/skills_en.csv"),
      iDef = col(rows, "definition", "data/esco/skills_en.csv"),
      iType = col(rows, "skillType", "data/esco/skills_en.csv");
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[iLabel]) continue;
      raw.push({
        id: "",
        title: sentenceCase(r[iLabel].trim()),
        description: (r[iDesc] || r[iDef] || "").trim(),
        sources: ["esco"],
        tags: r[iType] ? [`esco:${r[iType]}`] : ["esco"],
      });
      n++;
    }
    console.log(`  esco: ${n}`);
  }

  // O*NET Skills/Knowledge/Abilities
  {
    const cmrRows = readTsv("data/onet/Content Model Reference.txt");
    const ci = col(
        cmrRows,
        "Element ID",
        "data/onet/Content Model Reference.txt",
      ),
      cn = col(
        cmrRows,
        "Element Name",
        "data/onet/Content Model Reference.txt",
      ),
      cd = col(cmrRows, "Description", "data/onet/Content Model Reference.txt");
    const cmr = new Map<string, { name: string; desc: string }>();
    for (let i = 1; i < cmrRows.length; i++) {
      const r = cmrRows[i];
      cmr.set(r[ci], { name: r[cn], desc: r[cd] || "" });
    }
    for (
      const { path, tag } of [
        { path: "data/onet/Skills.txt", tag: "onet:skill" },
        { path: "data/onet/Knowledge.txt", tag: "onet:knowledge" },
        { path: "data/onet/Abilities.txt", tag: "onet:ability" },
      ]
    ) {
      const rows = readTsv(path);
      const idI = col(rows, "Element ID", path);
      const seen = new Set<string>();
      let n = 0;
      for (let i = 1; i < rows.length; i++) {
        const eid = rows[i][idI];
        if (!eid || seen.has(eid)) continue;
        seen.add(eid);
        const m = cmr.get(eid);
        if (!m) {
          throw new Error(
            `${path}:${
              i + 1
            }: expected element "${eid}" in data/onet/Content Model Reference.txt, received none. Re-download both files.`,
          );
        }
        raw.push({
          id: "",
          title: m.name.trim(),
          description: m.desc.trim(),
          sources: ["onet"],
          tags: [tag],
        });
        n++;
      }
      console.log(`  ${path}: ${n}`);
    }
  }

  // O*NET Tasks
  {
    const rows = readTsv("data/onet/Task Statements.txt");
    const iTask = col(rows, "Task", "data/onet/Task Statements.txt"),
      iType = col(rows, "Task Type", "data/onet/Task Statements.txt");
    const seen = new Set<string>();
    let n = 0, dup = 0, naDropped = 0;
    for (let i = 1; i < rows.length; i++) {
      const task = rows[i][iTask]?.trim();
      if (!task) continue;
      const taskType = rows[i][iType]?.trim() || "";
      if (!taskType) {
        naDropped++;
        continue;
      }
      const key = task.toLowerCase();
      if (seen.has(key)) {
        dup++;
        continue;
      }
      seen.add(key);
      raw.push({
        id: "",
        title: task,
        description: "",
        sources: ["onet"],
        tags: ["onet:task", `onet:${taskType.toLowerCase()}`],
      });
      n++;
    }
    console.log(`  onet tasks: ${n} (dup=${dup}, n/a=${naDropped})`);
  }

  // O*NET DWAs
  {
    const rows = readTsv("data/onet/DWA Reference.txt");
    const iTitle = col(rows, "DWA Title", "data/onet/DWA Reference.txt");
    const seen = new Set<string>();
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const title = rows[i][iTitle]?.trim();
      if (!title) continue;
      const k = title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      raw.push({
        id: "",
        title,
        description: "",
        sources: ["onet"],
        tags: ["onet:dwa"],
      });
      n++;
    }
    console.log(`  onet dwas: ${n}`);
  }

  // O*NET Tech
  {
    const BRAND_RE =
      /^[!\d]|\b(Inc|LLC|Corp|Corporation|Ltd|GmbH|Co\.)\b|\bSoftware\s+\d/;
    const rows = readTsv("data/onet/Technology Skills.txt");
    const iEx = col(rows, "Example", "data/onet/Technology Skills.txt"),
      iCat = col(rows, "Commodity Title", "data/onet/Technology Skills.txt"),
      iHot = col(rows, "Hot Technology", "data/onet/Technology Skills.txt");
    const seen = new Map<
      string,
      { orig: string; desc: string; hot: boolean }
    >();
    for (let i = 1; i < rows.length; i++) {
      const ex = rows[i][iEx]?.trim();
      if (!ex) continue;
      const cat = rows[i][iCat]?.trim() || "";
      const hot = rows[i][iHot] === "Y";
      const key = ex.toLowerCase();
      const prev = seen.get(key);
      if (!prev || (hot && !prev.hot)) {
        seen.set(key, { orig: ex, desc: cat, hot });
      }
    }
    let n = 0, notHot = 0, brandDropped = 0;
    for (const { orig, desc, hot } of seen.values()) {
      if (!hot) {
        notHot++;
        continue;
      }
      if (BRAND_RE.test(orig)) {
        brandDropped++;
        continue;
      }
      raw.push({
        id: "",
        title: orig,
        description: desc ? `${orig} — ${desc}` : "",
        sources: ["onet"],
        tags: ["onet:tech", ...(desc ? [`onet:tech:${slugify(desc)}`] : [])],
      });
      n++;
    }
    console.log(
      `  onet tech: ${n} (not_hot=${notHot}, brand_dropped=${brandDropped})`,
    );
  }

  // Lightcast
  {
    const path = "data/lightcast/skills.json";
    // deno-lint-ignore no-explicit-any -- checked field by field below
    const j = readJson(path) as any;
    if (!Array.isArray(j?.data) || !j.data.length) {
      throw new Error(
        `${path}: expected {"data": [skill, …]}, received keys ${
          JSON.stringify(Object.keys(j ?? {}))
        }. Re-download the file.`,
      );
    }
    let n = 0, infilled = 0, placeholdered = 0, certsDropped = 0;
    for (const s of j.data) {
      if (typeof s.name !== "string" || !s.name.trim()) {
        throw new Error(
          `${path}: expected every skill to have a name, received ${
            JSON.stringify(s).slice(0, 120)
          }. Re-download the file.`,
        );
      }
      const title = s.name.trim();
      const id = slugify(title);
      const typeName = s.type?.name ?? "";
      const category = s.category?.name ?? s.subcategory?.name ?? "";
      if (typeName === "Certification") {
        certsDropped++;
        continue;
      }
      let desc = infill.get(id) ?? "";
      if (desc === INFILL_SKIP) desc = "";
      const tags = typeName ? [`lightcast:${typeName}`] : ["lightcast"];
      if (desc && desc.trim() !== typeName) infilled++;
      else {
        desc = "";
        if (category) {
          desc = `${title} — ${category}`;
          placeholdered++;
        }
        tags.push("desc:placeholder");
      }
      raw.push({
        id: "",
        title,
        description: desc,
        sources: ["lightcast"],
        tags,
      });
      n++;
    }
    console.log(
      `  lightcast: ${n} (infilled=${infilled}, placeholder=${placeholdered}, certs=${certsDropped})`,
    );
  }

  // OpenSALT splits hub concepts (addition, fractions, loops) into many grade
  // variants and emits no hub, so data/_foundations.json supplies them.
  {
    const f = foundations;
    const gradeTag = (g: number) =>
      `grade:${g === 0 ? "K" : g === -1 ? "PK" : String(g)}`;
    for (const fd of f.foundations) {
      const grades = new Set(
        [fd.grade_start, fd.grade_end].filter((g) => g !== undefined),
      );
      raw.push({
        id: "",
        title: fd.title,
        description: fd.description,
        sources: ["foundation"],
        tags: [
          "foundation",
          `foundation:${fd.id}`,
          ...[...grades].map(gradeTag),
        ],
      });
    }
    console.log(`  foundations: ${f.foundations.length}`);
  }

  // OpenSALT CFItems
  {
    // Test, template, and duplicate frameworks.
    const FRAMEWORK_BLOCKLIST = new Set([
      "pcg-georgia-s-k-12-mathematics-standards-implementation-sy2023-2024-2",
      "florida-math-scope-and-sequence",
      "florida-science-scope-and-sequence-grade-3",
      "florida-social-studies-scope-and-sequence",
      "al-ela-alabama-ela-test",
      "al-mth-alabama-math-test",
      "al-sc-alabama-science-test",
      "al-ss-alabama-social-studies-test",
      "normalized-data-schema",
      "scope-and-sequence-framework-template",
      "norm-webb-s-depth-of-knowledge-dok-levels-of-cognitive-difficulty",
      "florida-ela-standards-best-3rd-grade",
      "florida-ela-standards-lafs-3rd-grade",
      "florida-science-standards-grade-3",
      "florida-social-studies-standards-grade-3",
      "gcps-aks-language-arts-2021-2022",
      "gcps-aks-mathematics-2022-2023",
      "indiana-academic-standards-for-mathematics-2020",
      "mathematics-b-e-s-t",
    ]);
    let n = 0,
      scaffType = 0,
      scaffPat = 0,
      truncated = 0,
      perFrameDup = 0,
      stuPrefix = 0,
      pureVerb = 0,
      frameDropped = 0,
      danglingParent = 0;
    for (const e of readDirSorted("data/opensalt")) {
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const path = `data/opensalt/${e.name}`;
      // deno-lint-ignore no-explicit-any -- CASE items, read field by field
      const j = readJson(path) as any;
      if (!Array.isArray(j?.CFItems) || !j.CFItems.length) {
        throw new Error(
          `${path}: expected a CASE package with CFItems, received keys ${
            JSON.stringify(Object.keys(j ?? {}))
          }. Re-download it: deno run -A data/download.ts`,
        );
      }
      const items = j.CFItems;
      const docSlug = slugify(j.CFDocument?.title || "opensalt");
      if (FRAMEWORK_BLOCKLIST.has(docSlug)) {
        frameDropped += items.length;
        continue;
      }
      const isSced = docSlug.startsWith("sced-");
      // An item with no educationLevel takes its nearest isChildOf ancestors'.
      const byId = new Map(items.map((it: { identifier: string }) => [
        it.identifier,
        it,
      ]));
      const docId = j.CFDocument?.identifier;
      const parentsOf = new Map<string, string[]>();
      for (const [k, a] of (j.CFAssociations ?? []).entries()) {
        if (a?.associationType !== "isChildOf") continue;
        const child = a.originNodeURI?.identifier;
        const parent = a.destinationNodeURI?.identifier;
        if (typeof child !== "string" || typeof parent !== "string") {
          throw new Error(
            `${path} CFAssociations[${k}]: expected an isChildOf association with string originNodeURI.identifier and destinationNodeURI.identifier, received ${
              JSON.stringify(a).slice(0, 120)
            }. Re-download it: deno run -A data/download.ts`,
          );
        }
        // A top-level item is a child of the CFDocument: it is a root.
        if (parent === docId) continue;
        if (!byId.has(parent)) {
          danglingParent++;
          continue;
        }
        parentsOf.set(child, [...parentsOf.get(child) ?? [], parent]);
      }
      // CASE trees run under 20 deep; a longer chain is an isChildOf cycle.
      // deno-lint-ignore no-explicit-any -- CASE items, read field by field
      const levels = (it: any, depth = 0): string[] => {
        if (depth >= 50) {
          throw new Error(
            `${path}: expected an isChildOf chain under 50 deep from item ${it.identifier}, received 50 or more. The framework has an isChildOf cycle: fix it, or re-download it.`,
          );
        }
        if (Array.isArray(it.educationLevel) && it.educationLevel.length) {
          return it.educationLevel.map(String);
        }
        const found = [
          ...new Set(
            (parentsOf.get(it.identifier) ?? []).map((p) =>
              levels(byId.get(p), depth + 1).join(",")
            ).filter(Boolean),
          ),
        ];
        if (found.length > 1) {
          throw new Error(
            `${path} item ${it.identifier}: expected its isChildOf parents to give one educationLevel, received ${
              found.map((f) => `[${f}]`).join(" and ")
            }. Give the item its own educationLevel, or pick one parent here.`,
          );
        }
        return found[0] ? found[0].split(",") : [];
      };
      // REVIEW: Tag the items of a framework that grades no item (SCED course
      // codes, Praxis, nursing courses). Stage status leaves them out of the
      // grade-tag share. Alternative: tag SCED 9-12 (its codes 01-24 are
      // secondary) and the rest grade:UG. Stage difficulty anchors at the
      // lowest grade, so AP Calculus would anchor at 9: an anchor the source
      // does not give.
      const ungraded =
        // deno-lint-ignore no-explicit-any -- CASE items
        !items.some((it: any) =>
          Array.isArray(it.educationLevel) && it.educationLevel.length
        );
      const seenInFrame = new Set<string>();
      for (const it of items) {
        if (it.CFItemType && SCAFFOLDING_TYPES.has(it.CFItemType)) {
          scaffType++;
          continue;
        }
        const where = `${path} item ${it.identifier}`;
        const cleaned = cleanStandard(
          htmlText(it.fullStatement || "", where).trim(),
          htmlText(it.abbreviatedStatement || "", where).trim(),
          htmlText(it.notes || "", where).trim(),
          Boolean(it.CFItemType),
        );
        if (cleaned === "scaffPat") {
          scaffPat++;
          continue;
        }
        if (cleaned === "pureVerb") {
          pureVerb++;
          continue;
        }
        const { title, description } = cleaned;
        if (cleaned.stuPrefix) stuPrefix++;
        if (cleaned.truncated) truncated++;
        const localKey = title.toLowerCase();
        if (seenInFrame.has(localKey)) {
          perFrameDup++;
          continue;
        }
        seenInFrame.add(localKey);

        // Stage prereq keeps sced:catalog entries out of candidate pools.
        const tags: string[] = ["opensalt"];
        if (isSced) tags.push("sced:catalog");
        if (ungraded) tags.push("opensalt:ungraded-framework");
        for (const g of levels(it)) {
          const gv = normGrade(String(g));
          if (gv) tags.push(`grade:${gv}`);
        }
        if (Array.isArray(it.conceptKeywords)) {
          for (const kw of it.conceptKeywords) {
            const kwSlug = slugify(String(kw));
            if (kwSlug) tags.push(`topic:${kwSlug}`);
          }
        }
        if (it.humanCodingScheme) {
          const t = codeTag(String(it.humanCodingScheme));
          if (t) tags.push(t);
        }
        if (it.CFItemType) tags.push(`opensalt:${slugify(it.CFItemType)}`);
        // khandata.tsv names an exercise by this slug, and its display name
        // can differ from the title here ("Subtract decimals like 0.9-0.7" vs
        // "Subtract tenths like 0.9-0.7"). Stage seed-edges resolves by it.
        const khan = (it.notes || "").match(/khanacademy\.org\/e\/([\w.-]+)/);
        if (khan) tags.push(`khan:${khan[1]}`);

        raw.push({ id: "", title, description, sources: ["opensalt"], tags });
        n++;
      }
    }
    console.log(
      `  opensalt: ${n} (scaff_type=${scaffType}, scaff_pat=${scaffPat}, pure_verb=${pureVerb}, stu_prefix=${stuPrefix}, trunc=${truncated}, dup=${perFrameDup}, framework_dropped=${frameDropped}, dangling_parent=${danglingParent})`,
    );
  }

  // Learning Commons: learning components and the standards of current
  // frameworks. One skill per distinct statement; lcNodes keeps every node id.
  const lcNodes = new Map<Skill, string[]>();
  {
    const lc = readLearningCommons();
    const gradeTags = (grades: string[]) =>
      grades.map((g) => `grade:${normGrade(g)}`);
    for (const c of lc.components) {
      // "With support from adults, share a feeling" names the skill after the comma.
      const text = unmark(
        htmlText(c.text, `${LC_EXTRACT} component ${c.id}`).trim(),
      );
      const skill: Skill = {
        id: "",
        title: text.charAt(0).toUpperCase() + text.slice(1),
        description: "",
        sources: ["learningcommons"],
        // REVIEW: A component that names over 4 grades (more than 9-12) gets
        // no grade tag. Its grades are the union of every standard it
        // supports, often K-8, and a merge hands them to a grade-8 standard,
        // which then anchors at K. Alternative: keep them. 149 seed pairs
        // then invert around a K anchor.
        tags: [
          "learningcommons:component",
          ...(c.grades.length <= 4 ? gradeTags(c.grades) : []),
        ],
      };
      raw.push(skill);
      lcNodes.set(skill, [c.id]);
    }
    // A buildsTowards endpoint skips the long-title drop below, so its
    // seed edge can resolve. Alternative: keep the drop and let stage enrich
    // summarize them. Only 14 of 757 edges resolve without this, and a summary
    // costs an Ollama run and loses the exact statement.
    const coherence = new Set(
      lc.edges.filter((e) => e.rel === "buildsTowards").flatMap((
        e,
      ) => [e.from, e.to]),
    );
    const byText = new Map<string, Skill>();
    let scaffType = 0, scaffPat = 0, pureVerb = 0, nStd = 0;
    for (const it of lc.items) {
      if (it.type && SCAFFOLDING_TYPES.has(it.type)) {
        scaffType++;
        continue;
      }
      const text = htmlText(it.text, `${LC_EXTRACT} item ${it.id}`).trim();
      // "(Begins in grade 3.)" and "(Not applicable to literature)" are notes.
      const cleaned = /^\*?\([^)]*\)\*?$/.test(text)
        ? "scaffPat"
        : cleanStandard(text, "", "", Boolean(it.type));
      if (cleaned === "scaffPat") {
        scaffPat++;
        continue;
      }
      if (cleaned === "pureVerb") {
        pureVerb++;
        continue;
      }
      // Fifty states repeat one statement; one skill holds all their nodes.
      const tags = [
        "learningcommons:standard",
        ...(coherence.has(it.id) ? ["learningcommons:coherence"] : []),
        // A standard that one framework tags K-8 is no grade-K skill, and a
        // merge would pin its twin at K, as for a component above.
        ...(it.grades.length <= 4 ? gradeTags(it.grades) : []),
        ...(it.code ? [codeTag(it.code)].filter((t) => t !== null) : []),
      ];
      const seen = byText.get(cleaned.title);
      if (seen) {
        lcNodes.get(seen)!.push(it.id);
        for (const t of tags) if (!seen.tags.includes(t)) seen.tags.push(t);
        continue;
      }
      const skill: Skill = {
        id: "",
        title: cleaned.title,
        description: cleaned.description,
        sources: ["learningcommons"],
        tags,
      };
      byText.set(cleaned.title, skill);
      lcNodes.set(skill, [it.id]);
      raw.push(skill);
      nStd++;
    }
    console.log(
      `  learningcommons: ${lc.components.length} components, ${nStd} standards from ${lc.items.length} items (scaff_type=${scaffType}, scaff_pat=${scaffPat}, pure_verb=${pureVerb})`,
    );
  }

  // DigComp 3.0: one skill per LearningOutcome, tagged with area, competence,
  // and proficiency level. Stage difficulty reads the level tag.
  // Read LearningOutcome nodes only. Alternative: also read the 362
  // CompetenceStatement nodes. Each repeats an outcome's sentence, so they
  // would add no skills and cost a join.
  {
    const path = "data/digcomp/digcomp3.jsonld";
    const j = readJson<{ "@graph": Record<string, unknown>[] }>(path);
    if (!Array.isArray(j["@graph"])) {
      throw new Error(
        `${path}: expected a JSON-LD object with an @graph array, received keys ${
          Object.keys(j)
        }. Fetch the file again with data/download.ts.`,
      );
    }
    const str = (n: Record<string, unknown>, k: string): string => {
      const v = n[k];
      if (typeof v !== "string" || !v.trim()) {
        throw new Error(
          `${path} ${n["@id"]}: expected ${k} as a non-empty string, received ${
            JSON.stringify(v)
          }. Fetch the file again with data/download.ts.`,
        );
      }
      return v;
    };
    const byType = (t: string) => j["@graph"].filter((n) => n["@type"] === t);
    const names = (t: string) =>
      new Map(byType(t).map((n) => [str(n, "@id"), str(n, "name")]));
    const areas = names("CompetenceArea"), comps = names("Competence");
    const levels = new Set(
      byType("ProficiencyLevel").map((n) => str(n, "four_levels_name")),
    );
    let nDig = 0;
    for (const n of byType("LearningOutcome")) {
      const where = `${path} ${n["@id"]}`;
      const area = areas.get(str(n, "competence_area_id")),
        comp = comps.get(str(n, "competence_id"));
      const level = str(n, "four_levels_proficiency_name").replace(
        /^ProficiencyLevel\//,
        "",
      );
      if (!area || !comp || !levels.has(level)) {
        throw new Error(
          `${where}: expected a known area, competence, and level, received ${
            JSON.stringify([n.competence_area_id, n.competence_id, level])
          }. Fetch the file again with data/download.ts.`,
        );
      }
      raw.push({
        id: "",
        title: str(n, "description"),
        description: "",
        sources: ["digcomp"],
        tags: [
          "digcomp:outcome",
          `digcomp:area:${slugify(area)}`,
          `digcomp:competence:${slugify(comp)}`,
          `digcomp:level:${slugify(level)}`,
        ],
      });
      nDig++;
    }
    console.log(`  digcomp: ${nDig} outcomes`);
  }

  // Cert Atlas: one skill per exam objective. The description names the exam,
  // its certifying body, and the domain, so stage tag can match occupations.
  // No tags. Stage tag matches occupations by embedding, as for every
  // other source. Alternative: a certatlas:exam:<id> tag per objective. It
  // keeps the exam, but a title that fifty exams repeat (Overview) would hit the
  // tag cap, and nothing reads the tag.
  // A domain with no objectives yields no skill. Alternative: make the
  // domain a skill. Its names are exam sections (Reading, Writing), not skills.
  {
    const path = "data/certatlas/exams.json.gz";
    const fix =
      "Re-download it: rm data/certatlas/exams.json.gz; deno run -A data/download.ts";
    const out = new Deno.Command("gzip", {
      args: ["-dc", path],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (out.code !== 0) {
      throw new Error(
        `${path}: expected a gzip file, received gzip exit ${out.code}: ${
          new TextDecoder().decode(out.stderr).trim()
        }. ${fix}`,
      );
    }
    const bad = (where: string, expected: string, got: unknown): never => {
      throw new Error(
        `${path} ${where}: expected ${expected}, received ${
          JSON.stringify(got)?.slice(0, 80)
        }. ${fix}`,
      );
    };
    const field = (o: unknown, k: string, where: string): unknown => {
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        bad(where, "an object", o);
      }
      return (o as Record<string, unknown>)[k];
    };
    const text = (v: unknown, where: string): string =>
      typeof v === "string" && v ? v : bad(where, "a non-empty string", v);
    const list = (v: unknown, where: string): unknown[] =>
      Array.isArray(v) ? v : bad(where, "an array", v);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(out.stdout));
    } catch (e) {
      bad("", "JSON", (e as Error).message);
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      bad("", "a non-empty array of exams", parsed);
    }
    const exams = (parsed as unknown[]).map((e, i) => {
      const w = `exam ${i}`;
      const id = text(field(e, "id", w), `${w} id`);
      const x = `exam ${id}`;
      return {
        name: text(field(e, "name", x), `${x} name`),
        body: text(field(e, "body", x), `${x} body`),
        domains: list(field(e, "domains", x), `${x} domains`).map((d, j) => {
          const dw = `${x} domains[${j}]`;
          return {
            name: text(field(d, "name", dw), `${dw} name`),
            objectives: list(field(d, "objectives", dw), `${dw} objectives`)
              .map((o, k) => {
                const ow = `${dw} objectives[${k}]`;
                return {
                  title: text(field(o, "title", ow), `${ow} title`),
                  sub: list(field(o, "sub", ow), `${ow} sub`).map((t, m) =>
                    text(t, `${ow} sub[${m}]`)
                  ),
                };
              }),
          };
        }),
      };
    });
    let nCert = 0, nNonLatin = 0;
    for (const e of exams) {
      for (const d of e.domains) {
        for (const o of d.objectives) {
          // The stage drops titles with no Latin letter (empty key). One
          // Oracle exam ships a Japanese copy, so count them here, in the log.
          if (!/[a-z]/i.test(o.title)) {
            nNonLatin++;
            continue;
          }
          // A question title ("How to analyze performance") names a skill
          // after its verb, as cleanStandard does for OpenSALT.
          let title = o.title.replace(
            /^(Can|Could|Should|How to|What is|Why does)\s+/i,
            "",
          ).replace(/\?$/, "");
          if (!title) {
            throw new Error(
              `${path} ${e.name} / ${d.name}: expected an objective title with words after the question prefix, received ${
                JSON.stringify(o.title)
              }. Fix the title in the source, or drop the prefix from the strip in stageList.`,
            );
          }
          title = title[0].toUpperCase() + title.slice(1);
          raw.push({
            id: "",
            title,
            description: `${e.name} (${e.body}), ${d.name}.${
              o.sub.length ? " " + o.sub.join("; ") : ""
            }`,
            sources: ["certatlas"],
            tags: [],
          });
          nCert++;
        }
      }
    }
    console.log(
      `  certatlas: ${nCert} objectives from ${exams.length} exams (${nNonLatin} without a Latin letter dropped)`,
    );
  }

  // BNCC: one skill per learning objective, titled by its English translation.
  // REVIEW: BNCC skips the long-title drop; stage enrich names each title over
  // 120 characters in 3-7 words, and the full statement becomes the
  // description. Alternative: drop long titles as for OpenSALT. Most BNCC
  // objectives are long, so the source would lose most of its rows.
  {
    const english = loadTsvCache(BNCC_TRANSLATE_CACHE);
    const rows = readBncc();
    for (const r of rows) {
      const t = english.get(r.code);
      if (!isBnccTranslation(t)) {
        throw new Error(
          `BNCC ${r.code}: expected an English translation in ${BNCC_TRANSLATE_CACHE}, received ${
            JSON.stringify(t)
          }. Delete that row if present, then run: deno run -A pipeline.ts enrich`,
        );
      }
      raw.push({
        id: "",
        title: t,
        description: "",
        sources: ["bncc"],
        tags: [
          "bncc:objective",
          `bncc:subject:${slugify(r.subject)}`,
          ...r.grades.map((g) => `grade:${g}`),
          `code:${r.code}`,
        ],
      });
    }
    console.log(`  bncc: ${rows.length} objectives`);
  }

  // Normalize + denoise
  let normalized = 0, denoised = 0;
  for (const s of raw) {
    const t0 = s.title, d0 = s.description;
    const decode = !s.sources.includes("opensalt") &&
      !s.sources.includes("learningcommons");
    s.title = normalizeText(s.title, decode);
    s.description = normalizeText(s.description, decode);
    if (/^The SCED provides a series of unused codes/i.test(s.description)) {
      s.description = "";
    }
    if (/We took this down/i.test(s.description)) s.description = "";
    if (/^\*\*(See |Standards (related|that))/i.test(s.description)) {
      s.description = "";
    }
    if (/^(\*\*)?Big Idea:/i.test(s.description)) s.description = "";
    if (
      /^Modeling is best interpreted not as a collection/i.test(s.description)
    ) s.description = "";
    if (/On the state assessment, items measuring/i.test(s.description)) {
      s.description = "";
    }
    if (/^Students need not use formal/i.test(s.description)) {
      s.description = "";
    }
    if (/^Examples may include but are not limited/i.test(s.description)) {
      s.description = "";
    }
    if (/^\d\.$/.test(s.description)) s.description = "";
    s.description = s.description.replace(
      /^(Progression|Clarification|Note|Sample|Sample Problem)\s*:\s*/i,
      "",
    );
    s.title = s.title.replace(/\s*:$/g, "");
    if (s.title !== t0 || s.description !== d0) normalized++;
    const before = s.title;
    const after = denoiseTitle(before);
    if (after && after !== before) {
      denoised++;
      if (
        !s.description && (before.length - after.length) / before.length > 0.3
      ) s.description = before;
      s.title = after;
    }
  }
  console.log(`[list] normalized=${normalized}, denoised=${denoised}`);

  // Apply summarize + onet-desc + opensalt-desc caches
  let summarized = 0, onetEnriched = 0, opensaltEnriched = 0;
  for (const s of raw) {
    const k = slugify(s.title);
    const sum = summarize.get(k);
    if (sum) {
      if (!isSummary(sum)) {
        throw new Error(
          `${SUMMARIZE_CACHE}: expected a summary of at most 15 words and a slug of at most 80 characters for "${k}", received "${
            sum.slice(0, 120)
          }". Run: deno run -A pipeline.ts enrich (it drops such rows and asks again).`,
        );
      }
      if (!s.description) s.description = s.title;
      s.title = sum;
      summarized++;
    }
    if (!s.description && s.sources.includes("onet")) {
      const d = onetDesc.get(k);
      if (d) {
        s.description = d;
        onetEnriched++;
      }
    }
    if (!s.description && s.sources.includes("opensalt")) {
      const d = opensaltDesc.get(k);
      if (d) {
        s.description = d;
        opensaltEnriched++;
      }
    }
  }
  console.log(
    `[list] applied ${summarized} summaries, ${onetEnriched} onet descs, ${opensaltEnriched} opensalt descs`,
  );

  // Long-title drop: anything that would overflow an 80-char slug and
  // require a hex-suffix hash is a compliance statement, not a skill.
  let longTitleDropped = 0, slugOverflowDropped = 0;
  const survivors: Skill[] = [];
  for (const s of raw) {
    if (/^DEPRECATED\b/i.test(s.title)) {
      longTitleDropped++;
      continue;
    }
    const fromOpensalt = s.sources.includes("opensalt") ||
      s.tags.includes("learningcommons:standard");
    const fromOnetTask = s.tags.some((t) => t === "onet:task");
    const wc = s.title.split(/\s+/).filter(Boolean).length;
    const exempt = s.tags.includes("learningcommons:coherence");
    if (
      (fromOpensalt || fromOnetTask) && !exempt &&
      (wc > 12 || s.title.length > 100)
    ) {
      longTitleDropped++;
      continue;
    }
    if (fromOpensalt && !exempt) {
      if (slugBase(s.title).length > 80) {
        // Still overflows post-summarize: summarization didn't fire or didn't help.
        slugOverflowDropped++;
        continue;
      }
    }
    survivors.push(s);
  }
  raw.length = 0;
  raw.push(...survivors);
  console.log(
    `[list] long_title_dropped=${longTitleDropped}, slug_overflow=${slugOverflowDropped}`,
  );

  // Fuzzy dedupe
  const fuzzyKey = (s: string): string =>
    s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(
        /\s+/g,
        " ",
      );
  const TAG_CAP = 20;
  const byKey = new Map<string, Skill>();
  const keyNodes = new Map<string, string[]>();
  let collisions = 0, emptyKey = 0, emptySlug = 0;
  for (const s of raw) {
    const k = fuzzyKey(s.title);
    if (!k) {
      emptyKey++;
      continue;
    }
    const nodes = lcNodes.get(s);
    if (nodes) keyNodes.set(k, [...keyNodes.get(k) ?? [], ...nodes]);
    const existing = byKey.get(k);
    if (existing) {
      collisions++;
      for (const src of s.sources) {
        if (!existing.sources.includes(src)) existing.sources.push(src);
      }
      for (const t of s.tags) {
        if (existing.tags.length >= TAG_CAP) break;
        if (!existing.tags.includes(t)) existing.tags.push(t);
      }
      if (s.description && s.description.length > existing.description.length) {
        existing.description = s.description;
      }
    } else {
      const slug = slugify(s.title);
      if (!slug) {
        emptySlug++;
        continue;
      }
      byKey.set(k, { ...s, id: slug });
    }
  }
  console.log(
    `[list] dropped ${emptyKey} titles with an empty key and ${emptySlug} with an empty slug; merged ${collisions} duplicates by key`,
  );
  if (emptyKey + emptySlug > raw.length * 0.01) {
    throw new Error(
      `list: too many drops (empty_key=${emptyKey}, empty_slug=${emptySlug})`,
    );
  }

  // Resolve slug collisions
  const bySlug = new Map<string, Skill[]>();
  for (const s of byKey.values()) {
    const arr = bySlug.get(s.id) ?? [];
    arr.push(s);
    bySlug.set(s.id, arr);
  }
  let slugCollisions = 0;
  for (const arr of bySlug.values()) {
    if (arr.length === 1) continue;
    slugCollisions += arr.length - 1;
    arr.forEach((s, i) => {
      if (i > 0) {
        const suffix = `-${i + 1}`;
        s.id = s.id.slice(0, 80 - suffix.length).replace(/-$/, "") + suffix;
      }
    });
  }

  const out = [...byKey.values()];
  // Stage list writes the node-to-skill map, because the tag cap (20)
  // would lose most of the ids of a statement that fifty states repeat.
  // Alternative: a lc:<id> tag per node. It needs no file but loses nodes past
  // the cap, and buildsTowards seed pairs then fail to resolve.
  const lcRows: string[][] = [];
  for (const [k, nodes] of keyNodes) {
    const skill = byKey.get(k);
    if (skill) { for (const n of nodes) lcRows.push([n, skill.id]); }
  }
  const ids = new Set<string>();
  for (const s of out) {
    if (!s.id || ids.has(s.id)) {
      throw new Error(
        `list: expected a unique, non-empty id per skill, received "${s.id}" for "${s.title}". A -N collision suffix met a real id; change the suffix scheme.`,
      );
    }
    ids.add(s.id);
  }
  const perSource = Object.fromEntries(
    [
      "esco",
      "onet",
      "lightcast",
      "opensalt",
      "foundation",
      "learningcommons",
      "digcomp",
      "certatlas",
      "bncc",
    ]
      .map((
        src,
      ) => [src, out.filter((s) => s.sources.includes(src)).length]),
  );
  for (const [src, n] of Object.entries(perSource)) {
    if (!n) {
      throw new Error(
        `list: expected rows from every source, received 0 from ${src}. Check its files under data/.`,
      );
    }
  }
  if (out.length < 20000) {
    throw new Error(
      `list: expected at least 20000 skills, received ${out.length}. Check the per-source counts above.`,
    );
  }
  writeTable(LC_IDS, lcRows);
  // The tags column joins tags with commas: a comma would split a tag.
  for (const s of out) {
    const t = s.tags.find((t) => t.includes(","));
    if (t !== undefined) {
      throw new Error(
        `list: expected tags without a comma, received ${
          JSON.stringify(t)
        } on skill "${s.id}" (sources ${
          s.sources.join(",")
        }). Strip the comma where stageList builds the tag.`,
      );
    }
  }
  const clean = (c: string) =>
    c
      // deno-lint-ignore no-control-regex -- strips C0 controls (tab, newline included) from source text
      .replace(/[\u0000-\u001f\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ").trim();
  writeTable(
    SKILL_LIST,
    out.map((s) => [
      s.id,
      clean(s.title),
      clean(s.description),
      s.sources.join(","),
      s.tags.join(","),
    ]),
  );

  const titleLens = out.map((s) => s.title.length);
  writeStats(1, {
    total_rows: out.length,
    raw_rows: raw.length,
    dedupe_collisions: collisions,
    empty_key_drops: emptyKey,
    empty_slug_drops: emptySlug,
    slug_collisions: slugCollisions,
    per_source: perSource,
    title_len: {
      p50: pct(titleLens, 0.5),
      p95: pct(titleLens, 0.95),
      max: Math.max(...titleLens),
    },
    empty_description: out.filter((s) => !s.description).length,
  });
}

// ---------- stage enrich: Ollama infill + summarize + onet-desc ----------

export async function stageEnrich() {
  // First, because stage list throws without these and the rest reads its output.
  await resumableClaude(
    "enrich:bncc",
    BNCC_TRANSLATE_CACHE,
    readBncc().map((r) => ({ id: r.code, text: r.text, subject: r.subject })),
    (t) =>
      `Translate this learning objective from Brazil's national curriculum (subject: ${t.subject}) from Portuguese into plain English. Keep every idea and add none. Output only the translation.\n\nObjective: ${t.text}\n\nEnglish:`,
    {
      // The longest objective is 1,500 characters, about 400 tokens in English.
      numPredict: 700,
      clean: (raw) => {
        const c = raw.replace(/^["“]|["”]$/g, "").trim();
        return isBnccTranslation(c) ? c : "";
      },
    },
  );
  const SUM_MAX = 120;
  const infillTargets: { id: string; title: string }[] = [];
  const sumTargets: { id: string; title: string }[] = [];
  const onetTargets: { id: string; title: string }[] = [];
  const opensaltTargets: { id: string; title: string }[] = [];
  let opaqueSkipped = 0;
  for (
    const { id, title, description: desc, sources, tags } of readTable(
      SKILL_LIST,
    )
  ) {
    // A title whose slug overflows gets a hex-hashed id: name it shorter.
    if (title.length > SUM_MAX || slugBase(title).length > 80) {
      sumTargets.push({ id, title });
    }
    if (
      sources.includes("lightcast") &&
      (!desc || tags?.includes("desc:placeholder"))
    ) {
      if (title.length <= 3 && !SHORT_TECH_WHITELIST.has(title.toLowerCase())) {
        opaqueSkipped++;
      } else infillTargets.push({ id, title });
    }
    if (sources === "onet" && !desc && title.length < 120) {
      onetTargets.push({ id, title });
    }
    if (
      sources === "opensalt" && !desc && title.length >= 8 &&
      title.length <= 120
    ) {
      opensaltTargets.push({ id, title });
    }
  }
  console.log(
    `[enrich] infill=${infillTargets.length} (opaque=${opaqueSkipped}), summarize=${sumTargets.length}, onet-desc=${onetTargets.length}, opensalt-desc=${opensaltTargets.length}`,
  );

  // Summaries rename skills, so they run before the slow infill (about 28k
  // Lightcast descriptions); stop the stage there and the titles hold. A
  // cached answer that is not a summary drops, so it is asked again.
  {
    const cache = [...loadTsvCache(SUMMARIZE_CACHE)];
    const good = cache.filter(([, v]) => isSummary(v));
    if (good.length < cache.length) {
      Deno.writeTextFileSync(
        SUMMARIZE_CACHE + ".tmp",
        good.map(([k, v]) => `${k}\t${v}\n`).join(""),
      );
      Deno.renameSync(SUMMARIZE_CACHE + ".tmp", SUMMARIZE_CACHE);
      console.log(
        `[enrich:summarize] dropped ${
          cache.length - good.length
        } cached answers over 15 words or 80 slug characters`,
      );
    }
  }
  await resumableClaude(
    "enrich:summarize",
    SUMMARIZE_CACHE,
    sumTargets,
    (t) =>
      `Extract the core skill as a concise 3-7 word noun phrase of at most 70 characters. Extract only concepts present in the input; do not add or assume. Name a list of items by its category. Output only the phrase — no preamble, no quotes, no trailing period. Examples:\n"Use place value understanding to round multi-digit whole numbers." → Rounding multi-digit whole numbers\n"Draw triangles with given conditions." → Drawing triangles with given conditions\n"Overhaul or replace carburetors, blowers, generators, distributors, starters, and pumps." → Overhauling engine components\n\nStandard: ${t.title}\n\nName:`,
    {
      numPredict: 60,
      clean: (raw) => {
        const c = cleanDef(raw);
        return isSummary(c) ? c : "";
      },
    },
  );

  // Without context, the model reads "Protege" as mentorship, not the ontology editor.
  const LIGHTCAST_CONTEXT =
    "You are describing entries in a professional labor-market skills taxonomy (Lightcast). When a name is ambiguous between generic English and a specific technical tool/product/standard, assume the technical interpretation. Do not invent organization names, certifications, or statistics.";

  await resumableClaude(
    "enrich:infill",
    INFILL_CACHE,
    infillTargets,
    (t) =>
      `${LIGHTCAST_CONTEXT}\n\nWrite a single factual sentence (≤100 chars) defining the skill without marketing language, jargon, or elaboration. Do not begin with the skill name. If unclear, output: SKIP\n\nSkill: ${t.title}\n\nDefinition:`,
    // Under 200 tokens, answers stop mid-word. A SKIP caches as SKIP, so a
    // rerun does not ask again; stage list reads it as no description.
    {
      numPredict: 200,
      clean: (raw) => /^\W*skip\W*$/i.test(raw) ? INFILL_SKIP : cleanDef(raw),
    },
  );

  await resumableClaude(
    "enrich:onet-desc",
    ONET_DESC_CACHE,
    onetTargets,
    (t) =>
      `Describe this workplace task in one sentence (<150 chars). Start with the action verb. Do not use "This task involves". No preamble, no quotation marks.\n\nTask: ${t.title}\n\nDescription:`,
    { numPredict: 120 },
  );

  await resumableClaude(
    "enrich:opensalt-desc",
    OPENSALT_DESC_CACHE,
    opensaltTargets,
    (t) =>
      `Describe this K-12 academic standard in one sentence (<150 chars) that a teacher would use to explain what a student learns. Start with a noun or verb. Do not use "Students will". No preamble, no quotation marks.\n\nStandard: ${t.title}\n\nDescription:`,
    { numPredict: 140 },
  );

  // MOOCCubeX labels are Simplified Chinese; seed-edges matches English titles.
  const hanLabels = new Set(
    (await readMoocPairs()).flatMap((p) => [p.c1, p.c2]).filter((l) =>
      HAN_RE.test(l)
    ),
  );
  await resumableClaude(
    "enrich:translate",
    TRANSLATE_CACHE,
    [...hanLabels].map((id) => ({ id })),
    (t) =>
      `Translate this concept from a Chinese university course into the short English name an English textbook index would use (1-6 words). Output only the name.\n\nConcept: ${t.id}\n\nEnglish:`,
    {
      numPredict: 200,
      clean: (raw) => {
        const c = cleanDef(raw);
        return HAN_RE.test(c) ? "" : c;
      },
    },
  );
}

// ---------- stage trees: LCSH + DBpedia SKOS broader chains ----------

// One pass over a SKOS dump. Writes slug → ancestor slugs to outPath, and
// returns the labels of the most-used broader targets as topic candidates.
async function buildTree(
  label: string,
  cmd: string[],
  depth: number,
  junkRe?: RegExp,
): Promise<{ ancestors: Map<string, string[]>; topics: string[] }> {
  console.log(`[trees] ${label}: streaming…`);
  const labels = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  const topicLabels = new Map<string, string>();
  const PREF = "skos/core#prefLabel";
  const BROADER = "skos/core#broader";
  const rxPref =
    /^<([^>]+)>\s+<[^>]+prefLabel>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/;
  const rxBroader = /^<([^>]+)>\s+<[^>]+broader>\s+<([^>]+)>\s*\.$/;
  const rxAnyUri = /^<[^>]+>\s+<[^>]+>\s+<([^>]+)>\s*\.$/;
  const rxAnyLit = /^<([^>]+)>\s+<[^>]+>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/;
  const BADCAT =
    /^(Wikipedia|Lists of|List of|Categories |Redirects|Articles |Stubs|Templates|Commons|Set indices)/i;
  const unquote = (s: string) => s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const dump = cmd[cmd.length - 1];
  try {
    Deno.statSync(dump);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new Error(
      `${dump}: expected a SKOS dump, received no file. Download it from the source listed in claude.md.`,
    );
  }
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  let n = 0;
  for await (
    const line of p.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TextLineStream(),
    )
  ) {
    n++;
    if (n % 2000000 === 0) {
      console.log(`  ${label}: ${n} lines, ${labels.size} labels`);
    }
    if (line.length < 40 || line[0] === "#") continue;
    if (line.includes(BROADER)) {
      const m = rxAnyUri.exec(line);
      if (m) inDeg.set(m[1], (inDeg.get(m[1]) ?? 0) + 1);
    }
    if (line.includes(PREF)) {
      const m = rxAnyLit.exec(line);
      const lbl = m && unquote(m[2]);
      if (
        m && lbl && lbl.length >= 2 && lbl.length <= 50 && !BADCAT.test(lbl) &&
        lbl.split(/\s+/).length <= 4 && !lbl.includes("(") && !lbl.includes(",")
      ) topicLabels.set(m[1], lbl);
    }
    if (line.length < 50 || line[0] !== "<") continue;
    if (line.includes(PREF)) {
      const m = rxPref.exec(line);
      if (m) {
        const lbl = unquote(m[2]);
        if (lbl.length >= 2 && lbl.length <= 80 && !lbl.includes("--")) {
          labels.set(m[1], lbl);
        }
      }
    } else if (line.includes(BROADER)) {
      const m = rxBroader.exec(line);
      if (m) {
        const arr = parents.get(m[1]) ?? [];
        arr.push(m[2]);
        parents.set(m[1], arr);
      }
    }
  }
  const { code } = await p.status;
  if (code !== 0) {
    throw new Error(
      `${
        cmd.join(" ")
      }: expected exit 0, received ${code} after ${n} lines. The dump is truncated or corrupt; re-download it.`,
    );
  }
  console.log(
    `[trees] ${label}: ${labels.size} labels, ${parents.size} with parents`,
  );
  if (!labels.size || !parents.size) {
    throw new Error(
      `${
        cmd.join(" ")
      }: expected SKOS prefLabel and broader triples, received ${labels.size} labels and ${parents.size} broader links in ${n} lines. Check the dump format; re-download it.`,
    );
  }

  // The 5000 labelled targets with the most broader edges, from the 25000
  // targets with the most. Pick them now and free both maps: DBpedia nears
  // the 4 GB heap limit in the ancestor walk below.
  const PER_SOURCE = 5000;
  const topSet = new Map(
    [...inDeg].sort((a, b) => b[1] - a[1]).slice(0, PER_SOURCE * 5),
  );
  const topics = [...topicLabels].filter(([uri]) => topSet.has(uri))
    .sort((a, b) => topSet.get(b[0])! - topSet.get(a[0])!)
    .slice(0, PER_SOURCE).map(([, lbl]) => lbl);
  inDeg.clear();
  topicLabels.clear();

  const slugToAncestors = new Map<string, string[]>();
  for (const [uri, lbl] of labels) {
    if (junkRe && (junkRe.test(uri) || junkRe.test(lbl))) continue;
    const slug = slugify(lbl);
    if (!slug || slug.length > 80) continue;
    const seen = new Set<string>([uri]);
    const anc: string[] = [];
    let frontier = parents.get(uri) || [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (junkRe && junkRe.test(p)) continue;
        const pLbl = labels.get(p);
        if (pLbl && !(junkRe && junkRe.test(pLbl))) {
          const pSlug = slugify(pLbl);
          if (pSlug && pSlug !== slug && !anc.includes(pSlug)) anc.push(pSlug);
        }
        for (const pp of (parents.get(p) || [])) next.push(pp);
      }
      frontier = next;
    }
    if (anc.length) slugToAncestors.set(slug, anc.slice(0, 6));
  }
  console.log(`[trees] ${label}: ${slugToAncestors.size} slugs`);
  if (!slugToAncestors.size) {
    throw new Error(
      `${
        cmd.join(" ")
      }: expected at least 1 slug with an ancestor, received 0. No labelled concept reaches a labelled broader concept; check the dump format.`,
    );
  }
  return { ancestors: slugToAncestors, topics };
}

export async function stageTrees() {
  const lcsh = await buildTree(
    "lcsh",
    ["gunzip", "-c", "data/lcsh/subjects.skosrdf.nt.gz"],
    4,
  );
  const JUNK =
    /_by_country$|_by_region$|_by_type$|_by_year$|_introduced_in_|_established_in_|_disestablished_in_|_founded_in_|_born_in_|_died_in_|_set_in_|^Category:People_in_|_people$|_in_history$/i;
  const dbp = await buildTree(
    "dbpedia",
    ["bzcat", "data/dbpedia/skos_categories_en.ttl.bz2"],
    3,
    JUNK,
  );
  const seen = new Set<string>();
  const refs = [...lcsh.topics, ...dbp.topics].filter((l) => {
    const k = l.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Write only after both dumps parse, so the three files come from one run.
  for (
    const [path, tree] of [
      [`${BUILD}/1j_lcsh_tree.tsv`, lcsh.ancestors],
      [`${BUILD}/1k_dbpedia_tree.tsv`, dbp.ancestors],
    ] as const
  ) {
    const fh = Deno.openSync(path, {
      create: true,
      write: true,
      truncate: true,
    });
    const enc = new TextEncoder();
    for (const [slug, anc] of tree) {
      fh.writeSync(enc.encode(`${slug}\t${anc.join(",")}\n`));
    }
    fh.close();
    console.log(`[trees] ${tree.size} slugs → ${path}`);
  }
  Deno.writeTextFileSync(TOPIC_REFS, refs.join("\n") + "\n");
  console.log(`[trees] ${refs.length} topic refs → ${TOPIC_REFS}`);
}

// ---------- stage seed-edges ----------

// Each buildsTowards edge runs prereq (source) to dependent (target). The export
// links misconceptions with hinders and symmetric ties with relatesTo; the
// extract holds neither. Aliases fold a skill that stage dedupe merged.
export function lcSeedEdges(
  skillOf: Map<string, string>,
  alias: Map<string, string>,
): {
  edges: { src: string; dst: string; raw: string }[];
  dropped: { from: string; to: string; raw: string; reason: string }[];
} {
  const edges: { src: string; dst: string; raw: string }[] = [];
  const dropped: { from: string; to: string; raw: string; reason: string }[] =
    [];
  for (const e of readLearningCommons().edges) {
    if (e.rel !== "buildsTowards") continue;
    const raw = `${e.from}->${e.to}`;
    const a = skillOf.get(e.from), b = skillOf.get(e.to);
    if (!a || !b) {
      dropped.push({ from: e.from, to: e.to, raw, reason: "no-skill" });
      continue;
    }
    const src = alias.get(a) ?? a, dst = alias.get(b) ?? b;
    if (src === dst) {
      dropped.push({ from: e.from, to: e.to, raw, reason: "self-loop" });
    } else edges.push({ src, dst, raw });
  }
  return { edges, dropped };
}

const DIGCOMP_LEVELS = ["basic", "intermediate", "advanced", "highly-advanced"];

// REVIEW: Within one DigComp competence, each outcome of a level is a seed
// prereq of each outcome of the next level. DigComp orders its levels per
// competence, not per outcome. Alternative: order the levels inside stage
// difficulty only, with no edge. It adds no edge that DigComp never states,
// but it needs an ordering path apart from the seeds.
export function digcompSeedEdges(
  tagged: { id: string; tags: string }[],
): { src: string; dst: string; raw: string }[] {
  const byComp = new Map<string, string[][]>();
  for (const s of tagged) {
    const comps = new Set(
      [...s.tags.matchAll(/(?:^|,)digcomp:competence:([^,]+)/g)].map((m) =>
        m[1]
      ),
    );
    const ks = [...s.tags.matchAll(/(?:^|,)digcomp:level:([^,]+)/g)].map((
      m,
    ) => DIGCOMP_LEVELS.indexOf(m[1]));
    if (!comps.size && !ks.length) continue;
    // Dedupe merges one statement at two levels; it is first learnable at
    // the lower one.
    const k = Math.min(...ks);
    if (comps.size !== 1 || !ks.length || ks.includes(-1)) {
      throw new Error(
        `${TAGGED_DEDUPED.path}: expected a DigComp skill to carry one digcomp:competence:* tag and digcomp:level:* tags of ${
          DIGCOMP_LEVELS.join(", ")
        }, received "${s.tags}" on "${s.id}". Rerun: deno run -A pipeline.ts list`,
      );
    }
    const comp = [...comps][0];
    const levels = byComp.get(comp) ??
      byComp.set(comp, DIGCOMP_LEVELS.map(() => [])).get(comp)!;
    levels[k].push(s.id);
  }
  const edges: { src: string; dst: string; raw: string }[] = [];
  for (const [comp, levels] of byComp) {
    for (let k = 0; k + 1 < levels.length; k++) {
      for (const src of levels[k]) {
        for (const dst of levels[k + 1]) {
          if (src !== dst) {
            edges.push({ src, dst, raw: `${comp}:${src}>${dst}` });
          }
        }
      }
    }
  }
  return edges;
}

export async function stageSeedEdges() {
  console.log("[seed-edges] collecting…");
  const tagged = readTable(TAGGED_DEDUPED);
  const idx = skillIndex(tagged);
  console.log(`[seed-edges] index: ${idx.idSet.size} ids`);
  type RawPair = {
    rawSrc: string;
    rawDst: string;
    source: string;
    raw: string;
  };
  const rawPairs: RawPair[] = [];
  const perSource: Record<
    string,
    { total: number; resolved: number }
  > = {};
  // AL-CPL labels look like "Basis_(linear_algebra)"; Khan adds "(basic)".
  const normalizeLabel = (lbl: string): string => {
    return lbl
      .replace(/_/g, " ")
      .replace(/\s*\([^)]*\)/g, "") // strip parentheticals
      .replace(/\s+/g, " ")
      .trim();
  };
  const addRaw = (s: string, d: string, src: string, r: string) => {
    s = normalizeLabel(s);
    d = normalizeLabel(d);
    if (!s || !d || s.toLowerCase() === d.toLowerCase()) return;
    rawPairs.push({ rawSrc: s, rawDst: d, source: src, raw: r });
    (perSource[src] ??= { total: 0, resolved: 0 })
      .total++;
  };

  // Khan Academy
  {
    const path = "data/khanacademy/khandata.tsv";
    const rows = readTsv(path);
    const iName = col(rows, "Data Name", path),
      iPre = col(rows, "Prereq(s)", path),
      iCode = col(rows, "Code", path),
      iDisp = col(rows, "Display Name", path);
    const codeToName = new Map<string, string>(),
      nameToDisplay = new Map<string, string>();
    for (const c of rows.slice(1)) {
      if (c[iCode] && c[iName]) {
        codeToName.set(c[iCode].trim(), c[iName].trim());
      }
      if (c[iName] && c[iDisp]) {
        nameToDisplay.set(c[iName].trim(), c[iDisp].trim());
      }
    }
    // An exercise slug that a khan:<slug> tag names resolves to that skill
    // id; resolveConcept matches ids directly.
    const bySlug = new Map<string, string>();
    for (const s of tagged) {
      for (const t of s.tags.split(",")) {
        if (t.startsWith("khan:") && !bySlug.has(t.slice(5))) {
          bySlug.set(t.slice(5), s.id);
        }
      }
    }
    const label = (name: string) =>
      bySlug.get(name) ?? nameToDisplay.get(name) ?? name;
    for (const c of rows.slice(1)) {
      const target = (c[iName] || "").trim();
      const pre = (c[iPre] || "").trim();
      if (!target || !pre || pre === "root") continue;
      for (const p of pre.split(";").map((x) => x.trim()).filter(Boolean)) {
        const pName = codeToName.get(p) || p;
        addRaw(label(pName), label(target), "khan", `${pName}->${target}`);
      }
    }
  }

  // AL-CPL — per readme: "*.preqs: concept pairs with prerequisite relations.
  // The second concept (2nd column) is a prerequisite of the first concept (1st column)."
  for (const domain of ["data_mining", "geometry", "physics", "precalculus"]) {
    const path = `data/al-cpl/data/${domain}.preqs`;
    for (const line of Deno.readTextFileSync(path).split("\n")) {
      if (!line.trim()) continue;
      const [dependent, prereq, extra] = line.trim().split(",");
      if (!dependent || !prereq || extra !== undefined) {
        throw new Error(
          `${path}: expected "Dependent,Prereq", received "${line}". Re-download it: deno run -A data/download.ts`,
        );
      }
      addRaw(prereq, dependent, `alcpl_${domain}`, line.trim());
    }
  }

  // Metacademy — Wikipedia-mapped CSV
  {
    const rows = readCsv(
      "data/metacademy/Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv",
    );
    for (let i = 1; i < rows.length; i++) {
      const pre = rows[i][0], tgt = rows[i][3];
      if (pre && tgt) addRaw(pre, tgt, "metacademy", `${pre}->${tgt}`);
    }
  }

  // Metacademy — raw concept dependencies.txt (393 concept dirs)
  {
    const CONCEPTS = "data/metacademy/metacademy-content/concepts";
    const titleByDir = new Map<string, string>();
    const dirs: string[] = [];
    for (const f of readDirSorted(CONCEPTS)) {
      if (!f.isDirectory || f.name === "ANNOTATED_EXAMPLE") continue;
      dirs.push(f.name);
      titleByDir.set(
        f.name,
        Deno.readTextFileSync(`${CONCEPTS}/${f.name}/title.txt`).trim(),
      );
    }
    const resolveTag = (tag: string): string => {
      const t = tag.trim();
      if (!t) return "";
      const dashToUnder = t.replace(/-/g, "_");
      const underToDash = t.replace(/_/g, "-");
      for (const key of [t, dashToUnder, underToDash]) {
        const title = titleByDir.get(key);
        if (title) return title;
      }
      return t.replace(/[_-]/g, " ");
    };
    let emitted = 0;
    for (const dir of dirs) {
      const target = titleByDir.get(dir) || dir.replace(/_/g, " ");
      const deps = Deno.readTextFileSync(`${CONCEPTS}/${dir}/dependencies.txt`);
      for (const line of deps.split("\n")) {
        const m = line.match(/^\s*tag:\s*(\S+)\s*$/);
        if (!m) continue;
        const pre = resolveTag(m[1]);
        if (pre && target) {
          addRaw(pre, target, "metacademy_raw", `${m[1]}->${dir}`);
          emitted++;
        }
      }
    }
    console.log(
      `[seed-edges] metacademy_raw: ${emitted} pairs from ${dirs.length} concept dirs`,
    );
  }

  // MOOCCubeX
  {
    const translations = loadTsvCache(TRANSLATE_CACHE);
    const english = (label: string) => {
      if (!HAN_RE.test(label)) return label;
      const t = translations.get(label);
      if (!isTranslation(t)) {
        throw new Error(
          `MOOCCubeX label "${label}": expected an English translation in ${TRANSLATE_CACHE}, received ${
            JSON.stringify(t)
          }. Delete that row if present, then run: deno run -A pipeline.ts enrich`,
        );
      }
      return t;
    };
    for (const p of await readMoocPairs()) {
      addRaw(
        english(p.c1),
        english(p.c2),
        `moocx_${p.domain}`,
        `${p.c1}->${p.c2}`,
      );
    }
  }

  // University course prerequisites
  // REVIEW: Keep courses although about 85% of its distinct topics name no
  // skill (7 Nov: 6,275 below the gate, 1,552 edges resolve). The unresolved
  // ones go to quarantine and cost nothing. Alternative: drop the source, as
  // todo.md planned when most titles fail. It loses a third of the seed edges.
  const courses = await readCoursePairs();
  for (const p of courses.pairs) addRaw(p.src, p.dst, "courses", p.raw);
  console.log(
    `[seed-edges] courses: ${courses.pairs.length} title pairs from ${courses.timingCounts.before} before-edges (${courses.timingCounts.concurrent} concurrent and ${courses.timingCounts.before_or_concurrent} before_or_concurrent edges skipped), ${courses.dropped.length} dropped`,
  );

  // OpenSALT precedes
  {
    for (const f of readDirSorted("data/opensalt")) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      const doc: {
        CFItems?: {
          identifier: string;
          humanCodingScheme?: string;
          fullStatement?: string;
        }[];
        CFAssociations?: {
          associationType?: string;
          originNodeURI?: { identifier?: string; title?: string };
          destinationNodeURI?: { identifier?: string; title?: string };
        }[];
      } = readJson(`data/opensalt/${f.name}`);
      const itemMap = new Map<string, { code: string; statement: string }>();
      for (const it of doc.CFItems || []) {
        itemMap.set(it.identifier, {
          code: it.humanCodingScheme || "",
          statement: it.fullStatement || "",
        });
      }
      for (const a of doc.CFAssociations || []) {
        if ((a.associationType || "").toLowerCase() !== "precedes") continue;
        const o = a.originNodeURI || {}, d = a.destinationNodeURI || {};
        const lbl = (x: { identifier?: string; title?: string }) => {
          if (x.identifier && itemMap.has(x.identifier)) {
            return itemMap.get(x.identifier)!.statement || x.title ||
              x.identifier || "";
          }
          return x.title || x.identifier || "";
        };
        addRaw(
          lbl(o),
          lbl(d),
          "opensalt_precedes",
          `${o.identifier || o.title}->${d.identifier || d.title}`,
        );
      }
    }
  }

  // OpenSALT within-framework grade ordering
  {
    const STOPT = new Set([
      ...STOPWORDS,
      "which",
      "can",
      "will",
      "should",
      "about",
      "each",
      "student",
      "students",
      "their",
      "they",
      "them",
      "are",
      "use",
      "uses",
    ]);
    const sigT = (s: string) =>
      new Set(
        s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) =>
          w.length >= 4 && !STOPT.has(w)
        ),
      );
    let emitted = 0;
    let capDroppedPairs = 0;
    const capDroppedFrameworks = new Set<string>();
    for (const f of readDirSorted("data/opensalt")) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      const doc: {
        CFItems?: {
          identifier: string;
          humanCodingScheme?: string;
          fullStatement?: string;
          educationLevel?: string[];
        }[];
      } = readJson(`data/opensalt/${f.name}`);
      type Node = { label: string; grade: number; code: string };
      const nodes: Node[] = [];
      for (const it of doc.CFItems || []) {
        if (!it.fullStatement || it.fullStatement.length < 15) continue;
        const grades: number[] = [];
        for (const el of it.educationLevel || []) {
          const v = (el || "").toUpperCase();
          if (v === "KG" || v === "K") grades.push(0);
          else if (v === "PK") grades.push(-1);
          else if (/^\d+$/.test(v)) grades.push(Number(v));
        }
        if (!grades.length) continue;
        const minG = Math.min(...grades);
        if (minG < 0 || minG > 12) continue;
        nodes.push({
          label: it.fullStatement.slice(0, 120),
          grade: minG,
          code: it.humanCodingScheme || "",
        });
      }
      if (nodes.length < 10) continue;
      nodes.sort((a, b) => a.grade - b.grade);
      const PAIR_CAP = 5;
      const perGradePair = new Map<string, number>();
      for (let i = 0; i < nodes.length; i++) {
        const ai = nodes[i];
        const ta = sigT(ai.label);
        if (ta.size < 3) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const aj = nodes[j];
          if (aj.grade <= ai.grade || aj.grade > ai.grade + 3) {
            if (aj.grade > ai.grade + 3) {
              break;
            } else continue;
          }
          const tb = sigT(aj.label);
          let overlap = 0;
          for (const t of ta) if (tb.has(t)) overlap++;
          if (overlap < 3) continue;
          // Jaccard ≥0.80: the same standard at two grades, not a prereq.
          const jaccard = overlap / (ta.size + tb.size - overlap);
          if (jaccard >= 0.80) continue;
          const k = `${ai.grade}->${aj.grade}`;
          const c = perGradePair.get(k) ?? 0;
          if (c >= PAIR_CAP) continue;
          if (emitted > 50000) {
            capDroppedPairs++;
            capDroppedFrameworks.add(f.name);
            continue;
          }
          perGradePair.set(k, c + 1);
          addRaw(
            ai.label,
            aj.label,
            "opensalt_grade",
            `${ai.code || "c"}_g${ai.grade}->${aj.code || "c"}_g${aj.grade}`,
          );
          emitted++;
        }
      }
    }
    console.log(`[seed-edges] opensalt_grade: ${emitted} pairs`);
    if (capDroppedPairs) {
      console.log(
        `[seed-edges] opensalt_grade: 50000 cap dropped ${capDroppedPairs} pairs in ${capDroppedFrameworks.size} frameworks`,
      );
    }
  }

  // Foundation wiring: each hub becomes a prereq of its variants (add-within-5).
  {
    const f = readFoundations();
    const titleOf = new Map(f.foundations.map((fd) => [fd.id, fd.title]));
    let n = 0;
    for (const e of f.seed_edges) {
      const pre = titleOf.get(e.prereq)!;
      if (e.dependent) {
        addRaw(
          pre,
          titleOf.get(e.dependent)!,
          "foundation",
          `${e.prereq}->${e.dependent}`,
        );
        n++;
        continue;
      }
      const re = new RegExp(e.dependent_pattern!);
      const before = n;
      for (const id of idx.idSet) {
        if (id === e.prereq || !re.test(id)) continue;
        // resolveConcept matches ids directly; pass the id slug as the "label".
        addRaw(pre, id, "foundation", `${e.prereq}->${id}`);
        n++;
      }
      if (n === before) {
        throw new Error(
          `${FOUNDATIONS_PATH}: dependent_pattern ${
            JSON.stringify(e.dependent_pattern)
          } for "${e.prereq}" matches no skill id. Fix or delete that seed edge.`,
        );
      }
    }
    console.log(`[seed-edges] foundation wiring: ${n} pairs`);
  }

  console.log(`[seed-edges] collected ${rawPairs.length} raw pairs`);

  // Exact match.
  const labelToId = new Map<string, string | null>();
  const resolveExact = (lbl: string): string | null => {
    if (labelToId.has(lbl)) return labelToId.get(lbl)!;
    const r = resolveConcept(lbl, idx);
    labelToId.set(lbl, r);
    return r;
  };
  const unresolved = new Set<string>();
  for (const p of rawPairs) {
    if (!resolveExact(p.rawSrc)) unresolved.add(p.rawSrc);
    if (!resolveExact(p.rawDst)) unresolved.add(p.rawDst);
  }
  console.log(
    `[seed-edges] pass 1: ${
      labelToId.size - unresolved.size
    }/${labelToId.size} resolved exactly`,
  );

  // Embedding fallback.
  const dropReason = new Map<string, string>();
  if (unresolved.size > 0) {
    const fb = await embeddingFallback([...unresolved], tagged, "seed-edges");
    for (const [lbl, id] of fb.matched) labelToId.set(lbl, id);
    for (const [lbl, why] of fb.dropped) dropReason.set(lbl, why);
  }

  // Emit, and quarantine the unresolved pairs.
  type Edge = {
    src: string;
    dst: string;
    source: string;
    confidence: number;
    holdout: boolean;
    fallback: boolean;
  };
  const edges: Edge[] = [];
  const quarantine: string[] = [
    "rawSrc\trawDst\tsource\traw\tsrc_reason\tdst_reason",
  ];
  const labelReason = (lbl: string): string => {
    if (labelToId.get(lbl)) return "ok";
    if (dropReason.has(lbl)) return dropReason.get(lbl)!;
    return "no-match";
  };
  for (const p of rawPairs) {
    const src = labelToId.get(p.rawSrc);
    const dst = labelToId.get(p.rawDst);
    if (!src || !dst || src === dst) {
      const reason = src === dst && src ? "self-loop" : "unresolved";
      quarantine.push(
        `${p.rawSrc}\t${p.rawDst}\t${p.source}\t${p.raw}\t${
          src ? "ok" : labelReason(p.rawSrc)
        }\t${dst ? "ok" : labelReason(p.rawDst)}${
          reason === "self-loop" ? " (self-loop)" : ""
        }`,
      );
      continue;
    }
    const srcExact = resolveConcept(p.rawSrc, idx) === src;
    const dstExact = resolveConcept(p.rawDst, idx) === dst;
    const fallback = !(srcExact && dstExact);
    const holdout = (h32(p.source + "|" + p.raw) % 5) === 0;
    edges.push({
      src,
      dst,
      source: p.source,
      confidence: fallback ? 0.85 : 1.0,
      holdout,
      fallback,
    });
    perSource[p.source].resolved++;
  }
  // Learning Commons pairs carry skill ids already: no label to resolve.
  {
    const aliases = new Map(
      readTable(ALIASES).map((r) => [r.dropped_id, r.canonical_id]),
    );
    const lc = lcSeedEdges(
      new Map(readTable(LC_IDS).map((r) => [r.node_id, r.skill_id])),
      aliases,
    );
    perSource.learningcommons = {
      total: lc.edges.length + lc.dropped.length,
      resolved: lc.edges.length,
    };
    for (const e of lc.edges) {
      for (const id of [e.src, e.dst]) {
        if (!idx.idSet.has(id)) {
          throw new Error(
            `${LC_IDS.path}: expected skill id "${id}" in ${TAGGED_DEDUPED.path}, received none. Run: deno run -A pipeline.ts list, then every later stage.`,
          );
        }
      }
      edges.push({
        ...e,
        source: "learningcommons",
        confidence: 1,
        holdout: (h32("learningcommons|" + e.raw) % 5) === 0,
        fallback: false,
      });
    }
    for (const d of lc.dropped) {
      quarantine.push(
        `${d.from}\t${d.to}\tlearningcommons\t${d.raw}\t${d.reason}\t${d.reason}`,
      );
    }
  }
  {
    const dig = digcompSeedEdges(tagged);
    perSource.digcomp = { total: dig.length, resolved: dig.length };
    for (const e of dig) {
      edges.push({
        ...e,
        source: "digcomp",
        confidence: 1,
        holdout: (h32("digcomp|" + e.raw) % 5) === 0,
        fallback: false,
      });
    }
  }
  // Course edges whose code has no sure title carry no label to resolve.
  (perSource.courses ??= { total: 0, resolved: 0 }).total +=
    courses.dropped.length;
  for (const d of courses.dropped) {
    quarantine.push(
      `${d.from}\t${d.to}\tcourses\t${d.raw}\t${d.reason}\t${d.reason}`,
    );
  }
  const seen = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.src}\t${e.dst}\t${e.source}`;
    const prev = seen.get(k);
    if (!prev || (prev.fallback && !e.fallback)) seen.set(k, e);
  }
  // A source that names both A → B and B → A gives no order, and the pair
  // is a seed cycle. Both go; the floors still count them as resolved.
  const contested = (e: Edge) => seen.has(`${e.dst}\t${e.src}\t${e.source}`);
  const drop = (e: Edge) => {
    quarantine.push(
      `${e.src}\t${e.dst}\t${e.source}\t${e.src}->${e.dst}\tcontested-order\tcontested-order`,
    );
    return false;
  };
  const kept = [...seen.values()].filter((e) => !contested(e) || drop(e));
  // REVIEW: Expert sources outrank course catalogs. A course edge inside a
  // seed cycle drops as contested-order: catalogs closed loops such as
  // linear algebra → … → "Mathematics" → algebra. Alternative: let stage
  // postproc break the cycle by rank. It keeps the cycle in the seeds that
  // stage difficulty reads. One pass suffices: dropping edges only splits
  // a cycle, so no kept course edge enters one.
  // Stage difficulty reads the non-holdout seeds only. stronglyConnected
  // leaves out a node in no cycle, so comp.has guards the comparison.
  const succ = new Map<string, string[]>();
  for (const e of kept.filter((e) => !e.holdout)) {
    (succ.get(e.src) ?? succ.set(e.src, []).get(e.src)!).push(e.dst);
  }
  const comp = new Map<string, number>();
  stronglyConnected(succ).forEach((c, i) => c.forEach((n) => comp.set(n, i)));
  const uniq = kept.filter((e) =>
    e.source !== "courses" || e.holdout || !comp.has(e.src) ||
    comp.get(e.src) !== comp.get(e.dst) || drop(e)
  );
  Deno.writeTextFileSync(
    `${BUILD}/1e_unresolved.tsv`,
    quarantine.join("\n") + "\n",
  );
  console.log(
    `[seed-edges] quarantine: ${
      quarantine.length - 1
    } pairs dropped, written to build/1e_unresolved.tsv`,
  );
  // REVIEW: Each floor is 90% of the resolved share on the last run that set
  // it, so a lost source stops the stage, and embedding jitter does not.
  // Alternative: a status condition. It lets a quarantined source ship.
  const SEED_FLOORS: Record<string, number> = {
    khan: 0.675,
    alcpl_data_mining: 0.172,
    alcpl_geometry: 0.029,
    alcpl_physics: 0.044,
    alcpl_precalculus: 0.072,
    metacademy: 0.04,
    metacademy_raw: 0.0137,
    moocx_cs: 0.0037,
    moocx_math: 0.0023,
    moocx_psy: 0.079,
    courses: 0.065,
    opensalt_precedes: 0.0106,
    opensalt_grade: 0.201,
    foundation: 0.9,
    learningcommons: 0.71,
    // Ids from tags, so every pair resolves.
    digcomp: 0.9,
  };
  const short = Object.entries(perSource).flatMap(([src, s]) => {
    const floor = SEED_FLOORS[src];
    if (floor === undefined) {
      return [`${src}: no floor in SEED_FLOORS (sources.ts)`];
    }
    return s.resolved < floor * s.total
      ? [`${src}: ${s.resolved}/${s.total} resolved, floor ${floor}`]
      : [];
  });
  if (short.length) {
    throw new Error(
      `[seed-edges] expected each source to resolve at or above its floor, received:\n  ${
        short.join("\n  ")
      }\nSource: perSource counts in stage seed-edges. Read the reasons in build/1e_unresolved.tsv for that source. If the drop is intended, lower its floor in SEED_FLOORS.`,
    );
  }
  writeTable(
    SEEDS,
    uniq.map((e) => [
      e.src,
      e.dst,
      e.source,
      e.confidence.toFixed(2),
      e.holdout ? "1" : "0",
      e.fallback ? "1" : "0",
    ]),
  );
  console.log(
    `[seed-edges] ${uniq.length} edges (${
      uniq.filter((e) => e.fallback).length
    } fallback). Resolved/total: ${
      Object.entries(perSource).map(([src, s]) =>
        `${src} ${s.resolved}/${s.total}`
      ).join(", ")
    }`,
  );
}
