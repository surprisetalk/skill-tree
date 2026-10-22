import { DOMParser, type Element } from "@b-fuze/deno-dom";
import { TextLineStream } from "@std/streams/text-line-stream";
import {
  BUILD,
  cleanDef,
  col,
  decodeEntities,
  EMBED_DIM,
  embedBatch,
  h32,
  HAN_RE,
  isTranslation,
  loadRawEmbeddings,
  loadTsvCache,
  normalize,
  normalizedEmbeddingsForSkills,
  readCsv,
  readJson,
  readMoocPairs,
  readTable,
  readTsv,
  resolveConcept,
  resumableOllama,
  SEEDS,
  Skill,
  SKILL_LIST,
  skillIndex,
  slugify,
  STOPWORDS,
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
const SUMMARIZE_CACHE = `${BUILD}/1c_summarize.tsv`;
const ONET_DESC_CACHE = `${BUILD}/1d_onet_desc.tsv`;
const OPENSALT_DESC_CACHE = `${BUILD}/1e_opensalt_desc.tsv`;

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
    let n = 0,
      scaffType = 0,
      scaffPat = 0,
      truncated = 0,
      perFrameDup = 0,
      stuPrefix = 0,
      pureVerb = 0,
      frameDropped = 0;
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
      const seenInFrame = new Set<string>();
      for (const it of items) {
        if (it.CFItemType && SCAFFOLDING_TYPES.has(it.CFItemType)) {
          scaffType++;
          continue;
        }
        const where = `${path} item ${it.identifier}`;
        const fullStmt = htmlText(it.fullStatement || "", where).trim();
        const abbrev = htmlText(it.abbreviatedStatement || "", where).trim();
        const notes = htmlText(it.notes || "", where).trim();
        if (!fullStmt && !abbrev) {
          scaffPat++;
          continue;
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
        title = title.replace(/^[•▪►■◆]\s*/, "").replace(/^\d+\.\s+/, "");
        const before = title;
        title = stripStudentPrefix(title);
        title = title.replace(
          /^(Can|Could|Should|How to|What is|Why does)\s+/i,
          (_m, _g, _off, _s) => "",
        );
        if (title && title[0] === title[0].toLowerCase()) {
          title = title[0].toUpperCase() + title.slice(1);
        }
        if (title !== before) stuPrefix++;
        title = title.replace(
          /^(Benchmark|Standard|Indicator)\s+[\d.]+\s*:\s*/i,
          "",
        ).trim();
        if (title.length > 300) {
          title = truncTitle(title, 300);
          truncated++;
        }
        if (title.length <= 2 || (title.length <= 20 && CODE_RE.test(title))) {
          scaffPat++;
          continue;
        }
        if (SCAFFOLDING_SIMPLE_RE.test(title)) {
          scaffPat++;
          continue;
        }
        if (
          /^(Essential|Proficient|Advanced|Intermediate|Beginning|Emerging|Developing|Extending|Exceeding|Level)\s+[IVX0-9]+/i
            .test(title) && title.length < 30
        ) {
          scaffPat++;
          continue;
        }
        if (/^You\s+[a-z]/i.test(title) && title.length > 20) {
          scaffPat++;
          continue;
        }
        // A bare acronym ("WCAG", "IoT") is a label, not a standard.
        if (!/\s/.test(title) && title.length < 30) {
          scaffPat++;
          continue;
        }
        if (SCAFFOLDING_RE.test(title) && title.length < 50 && !it.CFItemType) {
          scaffPat++;
          continue;
        }
        if (
          /^(understand|recognize|demonstrate|apply|identify|know|explain|describe)\s+(the|how|that|what|why|when|where|a|an)\s/i
            .test(title) &&
          title.length < 60 && !it.CFItemType
        ) {
          pureVerb++;
          continue;
        }
        description = description.replace(
          /^(Students?\s+(will|demonstrate)|The student|This unit|Module \d+|The course|Courses)\s[^.]*?\.\s+/i,
          "",
        );
        const localKey = title.toLowerCase();
        if (seenInFrame.has(localKey)) {
          perFrameDup++;
          continue;
        }
        seenInFrame.add(localKey);

        // Stage prereq keeps sced:catalog entries out of candidate pools.
        const tags: string[] = ["opensalt"];
        if (isSced) tags.push("sced:catalog");
        if (Array.isArray(it.educationLevel)) {
          for (const g of it.educationLevel) {
            const gv = normGrade(String(g));
            if (gv) tags.push(`grade:${gv}`);
          }
        }
        if (Array.isArray(it.conceptKeywords)) {
          for (const kw of it.conceptKeywords) {
            const kwSlug = slugify(String(kw));
            if (kwSlug) tags.push(`topic:${kwSlug}`);
          }
        }
        // Stage finalize shows a code:* tag as a display title, so a sub-item
        // label like "a" must not become one.
        if (it.humanCodingScheme) {
          const code = String(it.humanCodingScheme).trim().replace(
            /^Khan\s+/i,
            "",
          );
          if (code.length >= 4 && (/[A-Z]/.test(code) || /\./.test(code))) {
            tags.push(`code:${code}`);
          }
        }
        if (it.CFItemType) tags.push(`opensalt:${slugify(it.CFItemType)}`);

        raw.push({ id: "", title, description, sources: ["opensalt"], tags });
        n++;
      }
    }
    console.log(
      `  opensalt: ${n} (scaff_type=${scaffType}, scaff_pat=${scaffPat}, pure_verb=${pureVerb}, stu_prefix=${stuPrefix}, trunc=${truncated}, dup=${perFrameDup}, framework_dropped=${frameDropped})`,
    );
  }

  // Normalize + denoise
  let normalized = 0, denoised = 0;
  for (const s of raw) {
    const t0 = s.title, d0 = s.description;
    const decode = !s.sources.includes("opensalt");
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
    if (sum && sum.length > 0 && sum.length < s.title.length) {
      const orig = s.title;
      s.title = sum;
      if (!s.description) s.description = orig;
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
    const fromOpensalt = s.sources.includes("opensalt");
    const fromOnetTask = s.tags.some((t) => t === "onet:task");
    const wc = s.title.split(/\s+/).filter(Boolean).length;
    if ((fromOpensalt || fromOnetTask) && (wc > 12 || s.title.length > 100)) {
      longTitleDropped++;
      continue;
    }
    if (fromOpensalt) {
      const slugBase = decodeEntities(s.title).toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ").trim().replace(/\s+/g, "-").replace(
          /-+/g,
          "-",
        );
      if (slugBase.length > 80) {
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
  let collisions = 0, emptyKey = 0, emptySlug = 0;
  for (const s of raw) {
    const k = fuzzyKey(s.title);
    if (!k) {
      emptyKey++;
      continue;
    }
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
    ["esco", "onet", "lightcast", "opensalt", "foundation"].map((
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
    if (title.length > SUM_MAX) sumTargets.push({ id, title });
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

  // Without context, the model reads "Protege" as mentorship, not the ontology editor.
  const LIGHTCAST_CONTEXT =
    "You are describing entries in a professional labor-market skills taxonomy (Lightcast). When a name is ambiguous between generic English and a specific technical tool/product/standard, assume the technical interpretation. Do not invent organization names, certifications, or statistics.";

  await resumableOllama(
    "enrich:infill",
    INFILL_CACHE,
    infillTargets,
    (t) =>
      `${LIGHTCAST_CONTEXT}\n\nWrite a single factual sentence (≤100 chars) defining the skill without marketing language, jargon, or elaboration. Do not begin with the skill name. If unclear, output: SKIP\n\nSkill: ${t.title}\n\nDefinition:`,
    // Under 200 tokens, answers stop mid-word.
    { numPredict: 200 },
  );

  await resumableOllama(
    "enrich:summarize",
    SUMMARIZE_CACHE,
    sumTargets,
    (t) =>
      `Extract the core skill as a concise 3-7 word noun phrase. Extract only concepts present in the input; do not add or assume. Output only the phrase — no preamble, no quotes, no trailing period. Examples:\n"Use place value understanding to round multi-digit whole numbers." → Rounding multi-digit whole numbers\n"Draw triangles with given conditions." → Drawing triangles with given conditions\n\nStandard: ${t.title}\n\nName:`,
    { numPredict: 60 },
  );

  await resumableOllama(
    "enrich:onet-desc",
    ONET_DESC_CACHE,
    onetTargets,
    (t) =>
      `Describe this workplace task in one sentence (<150 chars). Start with the action verb. Do not use "This task involves". No preamble, no quotation marks.\n\nTask: ${t.title}\n\nDescription:`,
    { numPredict: 120 },
  );

  await resumableOllama(
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
  await resumableOllama(
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
    for (const c of rows.slice(1)) {
      const target = (c[iName] || "").trim();
      const pre = (c[iPre] || "").trim();
      if (!target || !pre || pre === "root") continue;
      const dstLabel = nameToDisplay.get(target) || target;
      for (const p of pre.split(";").map((x) => x.trim()).filter(Boolean)) {
        const pName = codeToName.get(p) || p;
        const srcLabel = nameToDisplay.get(pName) || pName;
        addRaw(srcLabel, dstLabel, "khan", `${pName}->${target}`);
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
  const FALLBACK = 0.90;
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (
      const t of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter(Boolean)
    ) {
      if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
    }
    return out;
  };
  const titleById = new Map(tagged.map((s) => [s.id, s.title]));
  const dropReason = new Map<string, string>();
  if (unresolved.size > 0) {
    const { ids: embIds } = loadRawEmbeddings();
    const matIds = embIds.filter((id) => idx.idSet.has(id));
    const mat = normalizedEmbeddingsForSkills(matIds);
    console.log(
      `[seed-edges] active vectors: ${matIds.length}/${embIds.length}`,
    );
    const labels = [...unresolved];
    const labelVecs = (await embedBatch(labels, "seed-edges")).map((v, i) =>
      normalize(v, `seed label "${labels[i]}"`)
    );
    let matched = 0;
    for (let li = 0; li < labels.length; li++) {
      const lv = labelVecs[li];
      let best = -1, bestScore = FALLBACK;
      for (let si = 0; si < matIds.length; si++) {
        const sv = mat.subarray(si * EMBED_DIM, (si + 1) * EMBED_DIM);
        let dot = 0;
        for (let k = 0; k < EMBED_DIM; k++) dot += lv[k] * sv[k];
        if (dot > bestScore) {
          bestScore = dot;
          best = si;
        }
      }
      if (best < 0) {
        dropReason.set(labels[li], `below-cos-${FALLBACK}`);
        continue;
      }
      const lt = sigTokens(labels[li]);
      const tt = sigTokens(titleById.get(matIds[best]) || matIds[best]);
      let overlap = 0;
      for (const t of lt) if (tt.has(t)) overlap++;
      if (overlap === 0 || lt.size === 0) {
        dropReason.set(labels[li], "no-token-overlap");
        continue;
      }
      labelToId.set(labels[li], matIds[best]);
      matched++;
    }
    console.log(
      `[seed-edges] fallback matched ${matched}/${labels.length} @ cos≥${FALLBACK}`,
    );
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
  Deno.writeTextFileSync(
    `${BUILD}/1e_unresolved.tsv`,
    quarantine.join("\n") + "\n",
  );
  console.log(
    `[seed-edges] quarantine: ${
      quarantine.length - 1
    } pairs dropped, written to build/1e_unresolved.tsv`,
  );
  const seen = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.src}\t${e.dst}\t${e.source}`;
    const prev = seen.get(k);
    if (!prev || (prev.fallback && !e.fallback)) seen.set(k, e);
  }
  const uniq = [...seen.values()];
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
