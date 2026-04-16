#!/usr/bin/env -S deno run --allow-all
// Skill-tree pipeline. Monolithic by design.
// Usage: deno run --allow-all pipeline.ts [stage]
// Stages: list, embed, tag, difficulty, prereq, finalize. Default: all.

import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";
// Load .env via `deno run --env-file=.env ...` to populate ANTHROPIC_API_KEY etc.

const BUILD = "build";
await Deno.mkdir(BUILD, { recursive: true });

type Skill = { id: string; title: string; description: string; sources: string[]; tags: string[] };

// ---------- util ----------

const NAMED_ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', sbquo: ",", bdquo: '"',
  ndash: "-", mdash: "-", hellip: "…", middot: "·", bull: "•",
  acirc: "â", aacute: "á", agrave: "à", auml: "ä", atilde: "ã", aring: "å", aelig: "æ",
  ecirc: "ê", eacute: "é", egrave: "è", euml: "ë",
  icirc: "î", iacute: "í", igrave: "ì", iuml: "ï",
  ocirc: "ô", oacute: "ó", ograve: "ò", ouml: "ö", otilde: "õ", oslash: "ø",
  ucirc: "û", uacute: "ú", ugrave: "ù", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", szlig: "ß", yacute: "ý", yuml: "ÿ",
  Acirc: "Â", Aacute: "Á", Agrave: "À", Auml: "Ä", Atilde: "Ã", Aring: "Å", AElig: "Æ",
  Ecirc: "Ê", Eacute: "É", Egrave: "È", Euml: "Ë",
  Icirc: "Î", Iacute: "Í", Igrave: "Ì", Iuml: "Ï",
  Ocirc: "Ô", Oacute: "Ó", Ograve: "Ò", Ouml: "Ö", Otilde: "Õ", Oslash: "Ø",
  Ucirc: "Û", Uacute: "Ú", Ugrave: "Ù", Uuml: "Ü",
  Ccedil: "Ç", Ntilde: "Ñ", Yacute: "Ý",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
};
const decodeEntities = (s: string) => s
  .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITY[name] ?? m)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// Strip HTML/XML tags, decode entities, normalize curly quotes/dashes, strip markdown bold, clean trailing punct.
const normalizeText = (s: string): string => {
  if (!s) return "";
  let t = decodeEntities(s);
  t = t.replace(/<\/?[a-z][^>]*>/gi, "");
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  t = t.replace(/[\u2010\u2011\u2012\u2013\u2014]/g, "-");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1"); // strip markdown bold
  t = t.replace(/Â\s*/g, " "); // UTF-8 double-encoding artifact (NBSP → Â)
  t = t.replace(/â€[\u0090-\u009F\u200B-\u200F]*/g, ""); // UTF-8 double-encoded smart quotes/dashes
  t = t.replace(/Ã[\u0080-\u00BF]/g, (m) => { // UTF-8 double-encoded accented chars
    try { return new TextDecoder().decode(new Uint8Array([...m].map((c) => c.charCodeAt(0)))); }
    catch { return m; }
  });
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

// Remove inline parentheticals (e.g., ...) / (i.e., ...) and any long aside, plus
// trailing ", such as ..." enumerations. Returns the cleaned title.
const denoiseTitle = (s: string): string => {
  if (!s) return "";
  let t = s;
  t = t.replace(/\s*\((?:e\.g\.|i\.e\.)[^)]*\)/gi, "");
  t = t.replace(/\s*\([^)]{60,}\)/g, "");
  t = t.replace(/,?\s+such as\b[^.]*\.?$/i, ".");
  t = t.replace(/^(perform|conduct|provide|ensure|coordinate)\s+(the|an?|of)\s+/i, "$1 ");
  t = t.replace(/[\s:;\-–—]+$/g, "");
  t = t.replace(/^[•▪►■◆]\s*/, ""); // strip leading bullet chars
  t = t.replace(/^\d+\.\s+/, ""); // strip leading numbered-list prefix ("2. Community...")
  t = t.replace(/\s+\([A-Z]\)$/g, ""); // strip trailing single-letter subject markers "(E)", "(H)", "(G)"
  t = t.replace(/\s+\(Supplemental\)$/gi, ""); // strip "(Supplemental)" marker
  t = t.replace(/\.$/g, ""); // strip trailing period (sentence → skill name)
  t = t.replace(/;?\s+and$/i, ""); // strip trailing "; and" (incomplete list item)
  t = t.replace(/\$([^$]+)\$/g, "$1"); // strip LaTeX $...$ delimiters, keep content
  t = t.replace(/\\bmod\b/g, "mod").replace(/\\small\b\s*/g, ""); // clean LaTeX commands
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

// OpenSALT-specific: strip "the student will / SWBAT / upon completion …" prefix
const stripStudentPrefix = (s: string): string => {
  if (!s) return s;
  let t = s.replace(/^(the\s+)?students?\s+will\s+(be\s+able\s+to\s+)?/i, "")
           .replace(/^students?\s+can\s+/i, "")
           .replace(/^by\s+the\s+end\s+of[^,.]+,\s*/i, "")
           .replace(/^upon\s+completion[^,.]+,\s*/i, "")
           .replace(/^(tswbat|swbat)[:\s]+/i, "")
           .trim();
  if (!t) return s;
  return t[0].toUpperCase() + t.slice(1);
};

const slugify = (s: string) => {
  const base = decodeEntities(s).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  if (base.length <= 80) return base;
  const hash = h32(base).toString(16).padStart(8, "0").slice(0, 6);
  let out = "";
  for (const tok of base.split("-")) {
    if (out.length + 1 + tok.length + 7 > 80) break;
    out += (out ? "-" : "") + tok;
  }
  return out ? `${out}-${hash}` : base.slice(0, 73) + "-" + hash;
};

const parseTsv = (text: string): string[][] =>
  text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length).map((l) => l.split("\t"));

// RFC 4180 CSV parser (handles quotes, embedded commas/newlines)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function writeStats(stage: number, stats: Record<string, unknown>) {
  const path = `${BUILD}/${stage}_stats.json`;
  Deno.writeTextFileSync(path, JSON.stringify(stats, null, 2));
  console.log(`[stage ${stage}] stats →`, path);
  console.log(JSON.stringify(stats, null, 2));
}

// ---------- stage 1: list ----------

function stage1List() {
  console.log("[stage 1] reading sources…");
  const summarizeCache = loadSummarizeCache();
  const onetDescCache = loadOnetDescCache();
  console.log(`[stage 1] caches: summarize=${summarizeCache.size}, onet_desc=${onetDescCache.size}`);
  const raw: Skill[] = [];

  // ESCO
  {
    const text = Deno.readTextFileSync("data/esco/skills_en.csv");
    const rows = parseCsv(text);
    const header = rows[0];
    const iLabel = header.indexOf("preferredLabel");
    const iDesc = header.indexOf("description");
    const iDef = header.indexOf("definition");
    const iType = header.indexOf("skillType");
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[iLabel]) continue;
      raw.push({
        id: "",
        title: r[iLabel].trim(),
        description: (r[iDesc] || r[iDef] || "").trim(),
        sources: ["esco"],
        tags: r[iType] ? [`esco:${r[iType]}`] : ["esco"],
      });
      n++;
    }
    console.log(`  esco: ${n}`);
  }

  // ONET Skills / Knowledge / Abilities — dedupe by Element ID, label from Content Model Reference
  {
    const cmrText = Deno.readTextFileSync("data/onet/Content Model Reference.txt");
    const cmrRows = parseTsv(cmrText);
    const cmrHdr = cmrRows[0];
    const cmrIdI = cmrHdr.indexOf("Element ID");
    const cmrNameI = cmrHdr.indexOf("Element Name");
    const cmrDescI = cmrHdr.indexOf("Description");
    const cmr = new Map<string, { name: string; desc: string }>();
    for (let i = 1; i < cmrRows.length; i++) {
      const r = cmrRows[i];
      cmr.set(r[cmrIdI], { name: r[cmrNameI], desc: r[cmrDescI] || "" });
    }

    const onetFiles = [
      { path: "data/onet/Skills.txt", tag: "onet:skill" },
      { path: "data/onet/Knowledge.txt", tag: "onet:knowledge" },
      { path: "data/onet/Abilities.txt", tag: "onet:ability" },
    ];
    for (const { path, tag } of onetFiles) {
      const text = Deno.readTextFileSync(path);
      const rows = parseTsv(text);
      const hdr = rows[0];
      const idI = hdr.indexOf("Element ID");
      const seen = new Set<string>();
      let n = 0;
      for (let i = 1; i < rows.length; i++) {
        const eid = rows[i][idI];
        if (!eid || seen.has(eid)) continue;
        seen.add(eid);
        const meta = cmr.get(eid);
        if (!meta) throw new Error(`ONET element ${eid} missing from Content Model Reference`);
        raw.push({
          id: "",
          title: meta.name.trim(),
          description: meta.desc.trim(),
          sources: ["onet"],
          tags: [tag],
        });
        n++;
      }
      console.log(`  ${path}: ${n}`);
    }
  }

  // ONET Tasks (work tasks with descriptions)
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Task Statements.txt"));
    const hdr = rows[0];
    const iTask = hdr.indexOf("Task");
    const iType = hdr.indexOf("Task Type");
    const seen = new Set<string>();
    let n = 0, dup = 0, naDropped = 0;
    for (let i = 1; i < rows.length; i++) {
      const task = rows[i][iTask]?.trim();
      if (!task) continue;
      const taskType = rows[i][iType]?.trim() || "";
      // Drop tasks with no Task Type (n/a) — these are noisier and lack context.
      if (!taskType) { naDropped++; continue; }
      const key = task.toLowerCase();
      if (seen.has(key)) { dup++; continue; }
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
    console.log(`  onet tasks: ${n} (dedup ${dup}, n/a_dropped ${naDropped})`);
  }

  // ONET DWAs (Detailed Work Activities)
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/DWA Reference.txt"));
    const hdr = rows[0];
    const iTitle = hdr.indexOf("DWA Title");
    const seen = new Set<string>();
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const title = rows[i][iTitle]?.trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push({ id: "", title, description: "", sources: ["onet"], tags: ["onet:dwa"] });
      n++;
    }
    console.log(`  onet dwas: ${n}`);
  }

  // ONET Technology Skills (specific tools)
  {
    const TECH_MODE = Deno.env.get("ONET_TECH_MODE") ?? "hot"; // "hot" | "all"
    const BRAND_RE = /^[!\d]|\b(Inc|LLC|Corp|Corporation|Ltd|GmbH|Co\.)\b|\bSoftware\s+\d/;
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Technology Skills.txt"));
    const hdr = rows[0];
    const iExample = hdr.indexOf("Example");
    const iCat = hdr.indexOf("Commodity Title");
    const iHot = hdr.indexOf("Hot Technology");
    // Dedupe by Example; keep associated commodity category as description/tag
    const seen = new Map<string, { orig: string; desc: string; hot: boolean }>();
    for (let i = 1; i < rows.length; i++) {
      const ex = rows[i][iExample]?.trim();
      if (!ex) continue;
      const cat = rows[i][iCat]?.trim() || "";
      const hot = rows[i][iHot] === "Y";
      const key = ex.toLowerCase();
      const prev = seen.get(key);
      if (!prev || (hot && !prev.hot)) seen.set(key, { orig: ex, desc: cat, hot });
    }
    let n = 0, modeDropped = 0, brandDropped = 0;
    for (const { orig, desc, hot } of seen.values()) {
      if (TECH_MODE === "hot" && !hot) { modeDropped++; continue; }
      if (BRAND_RE.test(orig)) { brandDropped++; continue; }
      // Differentiate description so embeddings don't collapse to ~50 commodity vectors
      const fullDesc = desc ? `${orig} — ${desc}` : "";
      raw.push({
        id: "",
        title: orig,
        description: fullDesc,
        sources: ["onet"],
        tags: ["onet:tech", ...(hot ? ["onet:hot"] : []), ...(desc ? [`onet:tech:${slugify(desc)}`] : [])],
      });
      n++;
    }
    console.log(`  onet tech: ${n} (mode=${TECH_MODE}, mode_dropped=${modeDropped}, brand_dropped=${brandDropped})`);
  }

  // Lightcast
  {
    const infill = loadInfillCache();
    const j = JSON.parse(Deno.readTextFileSync("data/lightcast/skills.json"));
    let n = 0, infilled = 0, placeholdered = 0, certsDropped = 0;
    const missingIds: string[] = [];
    const certs: { id: string; title: string; type: string; category: string }[] = [];
    for (const s of j.data) {
      if (!s.name) continue;
      const title = s.name.trim();
      const id = slugify(title);
      const typeName = s.type?.name ?? "";
      const category = s.category?.name ?? s.subcategory?.name ?? "";
      // Certifications are credentials, not learnable skills — split out to certifications.tsv.
      if (typeName === "Certification") {
        certs.push({ id, title, type: typeName, category });
        certsDropped++;
        continue;
      }
      let desc = infill.get(id) ?? "";
      const tags = typeName ? [`lightcast:${typeName}`] : ["lightcast"];
      if (desc) {
        infilled++;
      } else {
        // Prefer category-aware placeholder over bare type name (avoids 27k items
        // collapsing to "Specialized Skill" embedding).
        if (category) { desc = `${title} — ${category}`; placeholdered++; }
        else if (typeName) { desc = typeName; placeholdered++; }
        tags.push("desc:placeholder");
        missingIds.push(id);
      }
      raw.push({ id: "", title, description: desc, sources: ["lightcast"], tags });
      n++;
    }
    Deno.writeTextFileSync(`${BUILD}/1_lightcast_missing.tsv`, missingIds.join("\n") + "\n");
    if (certs.length) {
      const lines = ["id\ttitle\ttype\tcategory", ...certs.map((c) => `${c.id}\t${c.title}\t${c.type}\t${c.category}`)];
      Deno.writeTextFileSync(`${BUILD}/1_certifications.tsv`, lines.join("\n") + "\n");
    }
    console.log(`  lightcast: ${n} (infilled: ${infilled}, placeholder: ${placeholdered}, certs_split=${certsDropped} →${BUILD}/1_certifications.tsv, missing→${BUILD}/1_lightcast_missing.tsv)`);
  }

  // OpenSALT CFItems — each framework file has CFItems[] with fullStatement
  {
    const SCAFFOLDING_TYPES = new Set([
      "Grade Level", "Domain", "Strand", "Course", "Topic", "Cluster",
      "Component", "Section", "Module", "Chapter", "Unit",
    ]);
    const SCAFFOLDING_RE = /^(\s*)?(grade|kindergarten|pre-?k|elementary|middle school|high school|[0-9]+(st|nd|rd|th)\s+grade|unit\s+\d|chapter\s+\d|section\s+\d|module\s+\d|standard\s+\d|topic\s+\d|strand|domain)\b/i;
    // Truncate to last sentence boundary ≤cap; fall back to last word boundary.
    const truncTitle = (t: string, cap: number): string => {
      if (t.length <= cap) return t;
      const head = t.slice(0, cap);
      const lastDot = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
      if (lastDot > cap * 0.5) return head.slice(0, lastDot + 1).trim();
      const lastSpace = head.lastIndexOf(" ");
      return (lastSpace > cap * 0.5 ? head.slice(0, lastSpace) : head).trim() + "…";
    };
    let n = 0, scaffoldingType = 0, scaffoldingPattern = 0, truncated = 0, perFrameDup = 0, studentPrefixStripped = 0, pureVerbDropped = 0;
    for (const e of Deno.readDirSync("data/opensalt")) {
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const j = JSON.parse(Deno.readTextFileSync(`data/opensalt/${e.name}`));
      const items = j.CFItems || [];
      const doc = j.CFDocument?.title || "opensalt";
      const docSlug = slugify(doc);
      const seenInFrame = new Set<string>();
      for (const it of items) {
        if (it.CFItemType && SCAFFOLDING_TYPES.has(it.CFItemType)) { scaffoldingType++; continue; }
        const fullStmt = (it.fullStatement || "").trim();
        const abbrev = (it.abbreviatedStatement || "").trim();
        const notes = (it.notes || "").trim();
        if (!fullStmt && !abbrev) { scaffoldingPattern++; continue; }
        // Pick the shorter non-empty statement as title; keep the longer as description.
        // BUT don't prefer abbrev when it looks like a bare code (e.g. "K.RL.2.2", "TF.ATL.3.2.d").
        const CODE_RE = /^[A-Z0-9\u2013\u2014–-][\w.\u2013\u2014–-]*$/;
        let title: string;
        let description: string;
        if (abbrev && (!fullStmt || abbrev.length < fullStmt.length) && !(abbrev.length <= 20 && CODE_RE.test(abbrev))) {
          title = abbrev;
          description = fullStmt && fullStmt !== abbrev ? fullStmt : notes;
        } else {
          title = fullStmt;
          description = notes && notes !== fullStmt ? notes : "";
        }
        // Strip bullets and numbering before prefix checks
        title = title.replace(/^[•▪►■◆]\s*/, "").replace(/^\d+\.\s+/, "");
        // Strip student-output prefix language ("the student will / SWBAT / upon completion …")
        const beforePrefix = title;
        title = stripStudentPrefix(title);
        if (title !== beforePrefix) studentPrefixStripped++;
        // Strip "Benchmark X.X:" / "Standard X:" / "Indicator X:" prefix
        title = title.replace(/^(Benchmark|Standard|Indicator)\s+[\d.]+\s*:\s*/i, "").trim();
        if (title.length > 300) { title = truncTitle(title, 300); truncated++; }
        // Drop titles that are bare compliance codes, single chars, or too short to be meaningful
        if (title.length <= 2 || (title.length <= 20 && CODE_RE.test(title))) { scaffoldingPattern++; continue; }
        // Drop deprecated items, proficiency level scaffolding, test instructions, single-word headers
        if (/^DEPRECATED\b/i.test(title)) { scaffoldingPattern++; continue; }
        if (/^(Essential|Proficient|Advanced|Intermediate|Beginning|Emerging|Developing|Extending|Exceeding|Level)\s+[IVX0-9]+/i.test(title) && title.length < 30) { scaffoldingPattern++; continue; }
        if (/^(Use the (clock|timer)|Click the|Press the|Drag the|Open the app)/i.test(title)) { scaffoldingPattern++; continue; }
        if (/^(Constructed Response|Hook Activity|Background Information|Vocabulary Activity|Document Analysis)\s*:/i.test(title)) { scaffoldingPattern++; continue; }
        if (/^(Sample Problem|Example)\s*:/i.test(title)) { scaffoldingPattern++; continue; }
        if (/^Particular Topics in /i.test(title)) { scaffoldingPattern++; continue; }
        if (/\?\s*(Hook Activity|Background Information|Vocabulary Activity|Document Analysis|Writing)$/i.test(title)) { scaffoldingPattern++; continue; }
        if (/\s+(Hook Activity|Writing Activity|Vocabulary Activity|Assessment Activity)$/i.test(title)) { scaffoldingPattern++; continue; }
        // Second-person competency statements ("You follow...", "You are sought...") are not skills
        if (/^You\s+[a-z]/i.test(title) && title.length > 20) { scaffoldingPattern++; continue; }
        // Single-word OpenSALT titles are too generic to be useful skills
        if (!/\s/.test(title) && title.length < 20) { scaffoldingPattern++; continue; }
        // Drop scaffolding by pattern only when it looks like a header (short + matches)
        if (SCAFFOLDING_RE.test(title) && title.length < 50 && !it.CFItemType) { scaffoldingPattern++; continue; }
        if (/^(CFItemType|Course|Subject)\s*:/.test(title)) { scaffoldingPattern++; continue; }
        // Drop pure-verb-prompt rows with no concrete noun ("understand the X", <60 chars, no type)
        if (/^(understand|recognize|demonstrate|apply|identify|know|explain|describe)\s+(the|how|that|what|why|when|where|a|an)\s/i.test(title)
            && title.length < 60 && !it.CFItemType) { pureVerbDropped++; continue; }
        // Per-framework dedupe: same title repeated within one file is filler
        const localKey = title.toLowerCase();
        if (seenInFrame.has(localKey)) { perFrameDup++; continue; }
        seenInFrame.add(localKey);

        const tags: string[] = ["opensalt", `framework:${docSlug}`];
        // Split educationLevel array into per-grade tags so stage 7 grade extraction works.
        if (Array.isArray(it.educationLevel)) {
          for (const g of it.educationLevel) {
            const gv = String(g).trim();
            if (gv) tags.push(`grade:${gv}`);
          }
        }
        // conceptKeywords feed topic-matching downstream
        if (Array.isArray(it.conceptKeywords)) {
          for (const kw of it.conceptKeywords) {
            const kwSlug = slugify(String(kw));
            if (kwSlug) tags.push(`topic:${kwSlug}`);
          }
        }
        // Preserve standard codes as queryable tags
        if (it.humanCodingScheme) tags.push(`code:${it.humanCodingScheme}`);
        if (it.CFItemType) tags.push(`opensalt:${slugify(it.CFItemType)}`);

        raw.push({ id: "", title, description, sources: ["opensalt"], tags });
        n++;
      }
    }
    console.log(`  opensalt: ${n} (scaffolding_type=${scaffoldingType}, scaffolding_pattern=${scaffoldingPattern}, pure_verb_dropped=${pureVerbDropped}, student_prefix_stripped=${studentPrefixStripped}, truncated=${truncated}, per_frame_dup=${perFrameDup})`);
  }

  // Apply Apfel infill cache to ALL sources (loadInfillCache only feeds Lightcast parser)
  const apfelInfill = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(`${BUILD}/1b_apfel_infill.tsv`).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab > 0) apfelInfill.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch { /* no file */ }
  let apfelFilled = 0;
  for (const s of raw) {
    if (s.description) continue;
    const id = slugify(s.title);
    const desc = apfelInfill.get(id);
    if (desc) { s.description = desc; apfelFilled++; }
  }
  if (apfelFilled) console.log(`[stage 1] apfel infill applied: ${apfelFilled}`);

  // Normalize all titles and descriptions: HTML entities, tags, curly quotes, trailing punct.
  // Then run titles through de-noising regex (strip "(e.g., ...)", ", such as ...", etc.).
  // Preserve the pre-denoise text as description if denoising shrinks the title >30%.
  let normalized = 0, denoised = 0;
  for (const s of raw) {
    const t0 = s.title;
    const d0 = s.description;
    s.title = normalizeText(s.title);
    s.description = normalizeText(s.description);
    // Drop boilerplate / broken descriptions
    if (/^The SCED provides a series of unused codes/i.test(s.description)) s.description = "";
    if (/We took this down/i.test(s.description)) s.description = "";
    if (/^\*\*(See |Standards (related|that))/i.test(s.description)) s.description = "";
    if (/^(\*\*)?Big Idea:/i.test(s.description)) s.description = "";
    if (/^Modeling is best interpreted not as a collection/i.test(s.description)) s.description = "";
    if (/On the state assessment, items measuring/i.test(s.description)) s.description = "";
    if (/^Students need not use formal/i.test(s.description)) s.description = "";
    if (/^Examples may include but are not limited/i.test(s.description)) s.description = "";
    if (/^\d\.$/.test(s.description)) s.description = ""; // bare "1." etc
    // Strip meta-prefixes from descriptions (keep the content after)
    s.description = s.description.replace(/^(Progression|Clarification|Note|Sample|Sample Problem)\s*:\s*/i, "");
    // Strip trailing colon from title
    s.title = s.title.replace(/\s*:$/g, "");
    if (s.title !== t0 || s.description !== d0) normalized++;
    const before = s.title;
    const after = denoiseTitle(before);
    if (after && after !== before) {
      denoised++;
      if (!s.description && (before.length - after.length) / before.length > 0.3) {
        s.description = before;
      }
      s.title = after;
    }
  }
  console.log(`[stage 1] normalized=${normalized}, denoised=${denoised}`);

  // Apply summarize cache: replace long titles with concise summaries, keep original as description
  let summarized = 0, onetEnriched = 0;
  for (const s of raw) {
    const candidate = slugify(s.title);
    const summary = summarizeCache.get(candidate);
    if (summary && summary.length > 0 && summary.length < s.title.length) {
      const original = s.title;
      s.title = summary;
      if (!s.description) s.description = original;
      summarized++;
    }
    // Apply ONET description enrichment if still missing a description
    if (!s.description && s.sources.includes("onet")) {
      const desc = onetDescCache.get(candidate);
      if (desc) { s.description = desc; onetEnriched++; }
    }
  }
  console.log(`[stage 1] applied ${summarized} summaries, ${onetEnriched} onet descriptions`);

  // Long-title hard cap: after normalization, denoising, and summarization, drop OpenSALT
  // and ONET-Task rows whose title is still >12 words / >100 chars. These are compliance
  // statements that didn't compress; downstream stages waste work on them.
  let longTitleDropped = 0;
  const survivors: Skill[] = [];
  for (const s of raw) {
    // Drop deprecated items from any source
    if (/^DEPRECATED\b/i.test(s.title)) { longTitleDropped++; continue; }
    const fromOpensalt = s.sources.includes("opensalt");
    const fromOnetTask = s.tags.some((t) => t === "onet:task");
    const wordCount = s.title.split(/\s+/).filter(Boolean).length;
    if ((fromOpensalt || fromOnetTask) && (wordCount > 12 || s.title.length > 100)) {
      longTitleDropped++;
      continue;
    }
    survivors.push(s);
  }
  raw.length = 0;
  raw.push(...survivors);
  console.log(`[stage 1] long_title_dropped=${longTitleDropped} (opensalt/onet-task, >12 words or >100 chars)`);

  // Dedupe by fuzzy key
  console.log(`[stage 1] raw rows: ${raw.length}; deduping…`);
  // NFKD strips combining diacritics so "café" ≡ "cafe"; no stopword removal
  // (caused "the algebra" ≡ "algebra" collisions — token-sort signature merge in
  // stage 3b handles legit word-order swaps with proper stopword filtering).
  const fuzzyKey = (s: string): string => {
    return s.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  };
  const TAG_CAP = 20;
  const byKey = new Map<string, Skill>();
  let collisions = 0, emptyKeyDrops = 0, emptySlugDrops = 0;
  for (const s of raw) {
    const key = fuzzyKey(s.title);
    if (!key) { emptyKeyDrops++; continue; }
    const existing = byKey.get(key);
    if (existing) {
      collisions++;
      for (const src of s.sources) if (!existing.sources.includes(src)) existing.sources.push(src);
      for (const t of s.tags) {
        if (existing.tags.length >= TAG_CAP) break;
        if (!existing.tags.includes(t)) existing.tags.push(t);
      }
      // Prefer longer description when both present (stronger signal for embeddings)
      if (s.description && s.description.length > existing.description.length) {
        existing.description = s.description;
      }
    } else {
      const slug = slugify(s.title);
      if (!slug) { emptySlugDrops++; continue; }
      byKey.set(key, { ...s, id: slug });
    }
  }
  if (emptyKeyDrops + emptySlugDrops > raw.length * 0.01) {
    throw new Error(`stage 1: too many silent drops (empty_key=${emptyKeyDrops}, empty_slug=${emptySlugDrops}, raw=${raw.length})`);
  }

  // Resolve slug collisions (different titles → same slug) with numeric suffix
  const bySlug = new Map<string, Skill[]>();
  for (const s of byKey.values()) {
    const arr = bySlug.get(s.id) ?? [];
    arr.push(s);
    bySlug.set(s.id, arr);
  }
  let slugCollisions = 0;
  for (const [slug, arr] of bySlug) {
    if (arr.length === 1) continue;
    slugCollisions += arr.length - 1;
    arr.forEach((s, i) => { if (i > 0) s.id = `${slug}-${i + 1}`; });
  }

  // Write
  const out = [...byKey.values()];
  const clean = (c: string) => c
    .replace(/[\u0000-\u001f\u200b-\u200f\ufeff]/g, "")
    .replace(/[\t\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tsv = ["id\ttitle\tdescription\tsources\ttags"];
  for (const s of out) {
    if (!s.id) throw new Error(`skill with empty id: ${s.title}`);
    tsv.push([s.id, clean(s.title), clean(s.description), s.sources.join(","), s.tags.join(",")].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/1_skills.tsv`, tsv.join("\n") + "\n");

  const titleLens = out.map((s) => s.title.length);
  const stats = {
    total_rows: out.length,
    raw_rows: raw.length,
    dedupe_collisions: collisions,
    empty_key_drops: emptyKeyDrops,
    empty_slug_drops: emptySlugDrops,
    slug_collisions: slugCollisions,
    per_source: {
      esco: out.filter((s) => s.sources.includes("esco")).length,
      onet: out.filter((s) => s.sources.includes("onet")).length,
      lightcast: out.filter((s) => s.sources.includes("lightcast")).length,
      opensalt: out.filter((s) => s.sources.includes("opensalt")).length,
    },
    title_len: { p50: pct(titleLens, 0.5), p95: pct(titleLens, 0.95), max: Math.max(...titleLens) },
    empty_description: out.filter((s) => !s.description).length,
  };
  writeStats(1, stats);

  if (out.length < 20000) throw new Error(`stage 1: suspiciously few rows (${out.length})`);
}

// ---------- stage 1b: infill Lightcast descriptions ----------

const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "gpt-oss:20b";
const INFILL_CACHE = `${BUILD}/1b_infill.tsv`;

function loadInfillCache(): Map<string, string> {
  const m = new Map<string, string>();
  for (const path of [INFILL_CACHE, `${BUILD}/1b_apfel_infill.tsv`]) {
    try {
      for (const line of Deno.readTextFileSync(path).split("\n")) {
        if (!line) continue;
        const [k, v] = line.split("\t");
        if (k && v && !m.has(k)) m.set(k, v); // first-seen wins (Anthropic cache preferred)
      }
    } catch { /* missing is fine */ }
  }
  return m;
}

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-4-5-20251001";
const PREREQ_MODEL = Deno.env.get("PREREQ_MODEL") ?? "claude-3-haiku-20240307";
const INFILL_SYSTEM = `You define workplace skills in exactly one concise sentence. Be concrete and factual. Output only the definition — no preamble, no "refers to", no quotation marks, no trailing notes. Never repeat the skill name verbatim at the start.`;
const BATCH_STATE = `${BUILD}/1b_batch.json`;
const ANTHROPIC_HEADERS = {
  "content-type": "application/json",
  "x-api-key": ANTHROPIC_KEY ?? "",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "message-batches-2024-09-24",
};

const REFUSAL_RE = /(cannot|unable to|not familiar with|not (?:able|aware|sure)|do(?:n't| not) have|no (?:recognized |clear |standard )?(?:definition|meaning)|without (?:more |further |additional )?(?:context|information)|could you (?:provide|clarify|specify)|recognized definition|clear workplace skill)/i;

function cleanDef(raw: string): string {
  const trimmed = raw.trim()
    .replace(/^[\s"'*_-]+|[\s"'*_-]+$/g, "")
    .replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (REFUSAL_RE.test(trimmed)) return "";
  if (trimmed.length <= 400) return trimmed;
  const head = trimmed.slice(0, 400);
  const lastSent = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (lastSent > 200) return head.slice(0, lastSent + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 200 ? head.slice(0, lastSpace) : head).trim() + "…";
}

// Map custom_id ↔ full skill id; custom_id must be ≤64 chars and unique.
async function shortId(fullId: string, idx: number): Promise<string> {
  const h = await sha256(fullId);
  const hex = Array.from(h.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `s${idx.toString(36)}_${hex}`;
}

async function submitBatch(todo: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(todo.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 120,
        system: [{ type: "text", text: INFILL_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Define: ${t.title}` }],
      },
    };
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batch submit ${res.status}: ${await res.text()}`);
  const j = await res.json();
  console.log(`[stage 1b] batch submitted: ${j.id} (${requests.length} requests)`);
  return { batchId: j.id, idMap };
}

async function pollBatch(id: string): Promise<{ status: string; resultsUrl?: string; counts?: Record<string, number> }> {
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${id}`, { headers: ANTHROPIC_HEADERS });
  if (!res.ok) throw new Error(`batch poll ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { status: j.processing_status, resultsUrl: j.results_url, counts: j.request_counts };
}

async function downloadBatchResults(url: string, idMap: Record<string, string>): Promise<Record<string, string>> {
  const res = await fetch(url, { headers: ANTHROPIC_HEADERS });
  if (!res.ok) throw new Error(`results ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const out: Record<string, string> = {};
  let errs = 0, unmapped = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line);
    const skillId = idMap[j.custom_id];
    if (!skillId) { unmapped++; continue; }
    if (j.result?.type === "succeeded") {
      out[skillId] = cleanDef(j.result.message.content?.[0]?.text ?? "");
    } else {
      errs++;
    }
  }
  console.log(`[stage 1b] results: ${Object.keys(out).length} succeeded, ${errs} failed, ${unmapped} unmapped`);
  return out;
}

function appendInfill(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(INFILL_CACHE, { create: true, append: true });
  for (const [id, desc] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${desc.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

// Known short tech names that are real skills despite being ≤3 chars; everything else
// at that length is opaque code that the LLM tends to hallucinate or refuse on.
const SHORT_TECH_WHITELIST = new Set([
  "r", "go", "c#", "c++", "ada", "apl", "awk", "css", "db2", "git", "ios", "jet",
  "lua", "mdx", "mmx", "php", "qml", "sql", "tcl", "xml", "yml", "vim", "tex", "rsa",
]);

async function stage1bInfill() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // Identify Lightcast skills needing infill
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  let opaqueSkipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (!c[3].includes("lightcast") || c[2]) continue;
    const title = c[1];
    if (title.length <= 3 && !SHORT_TECH_WHITELIST.has(title.toLowerCase())) {
      opaqueSkipped++;
      continue;
    }
    targets.push({ id: c[0], title });
  }
  const cache = loadInfillCache();
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[stage 1b] targets: ${targets.length}, opaque_skipped: ${opaqueSkipped}, cached: ${targets.length - todo.length}, to submit: ${todo.length}`);

  // Check for existing in-flight batch
  let state: { id: string; idMap: Record<string, string> } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(BATCH_STATE)); } catch { /* none */ }

  // Resume existing batch
  if (state) {
    console.log(`[stage 1b] resuming batch ${state.id}`);
    while (true) {
      const p = await pollBatch(state.id);
      console.log(`  batch ${state.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("batch ended but no results_url");
        const results = await downloadBatchResults(p.resultsUrl, state.idMap);
        appendInfill(results);
        Deno.removeSync(BATCH_STATE);
        writeStats(11, { targets: targets.length, batch_id: state.id, results_count: Object.keys(results).length });
        return;
      }
      await new Promise((r) => setTimeout(r, 30000));
    }
  }

  if (todo.length === 0) {
    console.log("[stage 1b] all targets already cached — nothing to do");
    return;
  }

  // Chunk into batches of up to 90k requests (cap under Anthropic's 100k limit)
  const CHUNK = 90000;
  if (todo.length > CHUNK) {
    console.warn(`[stage 1b] splitting ${todo.length} into chunks of ${CHUNK}; submitting first chunk now, rerun stage to submit next`);
  }
  const chunk = todo.slice(0, CHUNK);

  if (Deno.env.get("INFILL_LIMIT")) {
    chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
    console.log(`[stage 1b] INFILL_LIMIT → ${chunk.length}`);
  }

  const { batchId, idMap } = await submitBatch(chunk);
  Deno.writeTextFileSync(BATCH_STATE, JSON.stringify({ id: batchId, idMap }));
  console.log(`[stage 1b] batch submitted. Re-run \`pipeline.ts infill\` to poll for results.`);
}

// ---------- stage 1d: enrich ONET Task/DWA descriptions ----------

const ONET_DESC_CACHE = `${BUILD}/1d_onet_desc.tsv`;
const ONET_DESC_BATCH_STATE = `${BUILD}/1d_batch.json`;
const ONET_DESC_SYSTEM = `Expand the given workplace task into a 1-2 sentence description of what the task involves. Be concrete and factual. No preamble. No quotation marks. Return only the description.`;

function loadOnetDescCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(ONET_DESC_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      m.set(line.slice(0, tab), line.slice(tab + 1) || "");
    }
    return m;
  } catch { return new Map(); }
}

function appendOnetDesc(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(ONET_DESC_CACHE, { create: true, append: true });
  for (const [id, v] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${v.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

async function submitOnetDescBatch(chunk: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(chunk.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 80,
        system: [{ type: "text", text: ONET_DESC_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Task: ${t.title}` }],
      },
    };
  }));
  const body = JSON.stringify({ requests });
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
        method: "POST",
        headers: ANTHROPIC_HEADERS,
        body,
      });
      if (res.ok) { const j = await res.json(); return { batchId: j.id, idMap }; }
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(60 * attempt, 300);
        console.warn(`  [retry ${attempt}/8] ${res.status} — sleeping ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new Error(`onet-desc submit ${res.status}: ${txt}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/onet-desc submit [1-4]\d\d/.test(msg)) throw err;
      const delay = Math.min(30 * attempt, 300);
      console.warn(`  [retry ${attempt}/8] network: ${msg.slice(0, 80)} — sleeping ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  throw new Error("onet-desc submit: retries exhausted");
}

async function stage1dOnetDesc() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[3] === "onet" && !c[2] && c[1].length < 120) targets.push({ id: c[0], title: c[1] });
  }
  const cache = loadOnetDescCache();

  // Track IDs already in flight
  let state: { batches: { id: string; idMap: Record<string, string> }[] } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(ONET_DESC_BATCH_STATE)); } catch { /* none */ }
  const inFlight = new Set<string>();
  if (state) for (const b of state.batches) for (const v of Object.values(b.idMap)) inFlight.add(v);

  const buildTodo = () => targets.filter((t) => !cache.has(t.id) && !inFlight.has(t.id));
  let todo = buildTodo();
  console.log(`[stage 1d] targets: ${targets.length}, cached: ${cache.size}, in-flight: ${inFlight.size}, to submit: ${todo.length}`);

  // Poll existing batches
  if (state) {
    const remaining: typeof state.batches = [];
    for (const b of state.batches) {
      const p = await pollBatch(b.id);
      console.log(`  batch ${b.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) { console.warn(`  no results_url for ${b.id}`); continue; }
        const results = await downloadBatchResults(p.resultsUrl, b.idMap);
        appendOnetDesc(results);
        for (const id of Object.keys(results)) cache.set(id, results[id]);
        for (const v of Object.values(b.idMap)) inFlight.delete(v);
      } else remaining.push(b);
    }
    if (remaining.length === 0) {
      try { Deno.removeSync(ONET_DESC_BATCH_STATE); } catch { /* ignore */ }
      state = { batches: [] };
    } else {
      Deno.writeTextFileSync(ONET_DESC_BATCH_STATE, JSON.stringify({ batches: remaining }));
      state = { batches: remaining };
    }
    todo = buildTodo();
  }
  if (todo.length === 0 && (!state || state.batches.length === 0)) {
    writeStats(13, { targets: targets.length, cached: cache.size });
    console.log(`[stage 1d] all done — ${cache.size}/${targets.length} cached`);
    return;
  }

  // Fill parallel submission slots
  const CHUNK = Number(Deno.env.get("ONET_CHUNK") ?? "5000");
  const PARALLEL = Number(Deno.env.get("ONET_PARALLEL") ?? "3");
  const inFlightBatches = state?.batches ?? [];
  const slots = Math.max(0, PARALLEL - inFlightBatches.length);
  const batches = [...inFlightBatches];
  let off = 0;
  for (let n = 0; n < slots && off < todo.length; n++) {
    const chunk = todo.slice(off, off + CHUNK);
    if (Deno.env.get("INFILL_LIMIT")) chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
    const b = await submitOnetDescBatch(chunk);
    batches.push({ id: b.batchId, idMap: b.idMap });
    Deno.writeTextFileSync(ONET_DESC_BATCH_STATE, JSON.stringify({ batches }));
    console.log(`[stage 1d] batch ${b.batchId}: ${chunk.length} requests submitted`);
    off += chunk.length;
  }
  console.log(`[stage 1d] ${batches.length} batch(es) in-flight. Rerun to poll + submit next.`);
}

// ---------- stage 1c: summarize long titles ----------

const SUMMARIZE_CACHE = `${BUILD}/1c_summarize.tsv`;
const SUMMARIZE_BATCH_STATE = `${BUILD}/1c_batch.json`;
const SUMMARIZE_SYSTEM = `You extract the core skill from a long workplace/curriculum standard. Output exactly one concise noun phrase (3-7 words) naming the core skill. No preamble, no quotes, no trailing period. Examples:
"Use place value understanding to round multi-digit whole numbers to any place." → Rounding multi-digit whole numbers
"Prepare or present reports concerning activities, expenses, budgets, government statutes or rulings, or other items affecting businesses or program services." → Preparing business reports
"Draw triangles (freehand, with ruler and protractor, and using technology) with given conditions from three measures of angles or sides." → Drawing triangles with given conditions`;

function loadSummarizeCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(SUMMARIZE_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const [k, v] = line.split("\t");
      m.set(k, v ?? "");
    }
    return m;
  } catch { return new Map(); }
}

function appendSummarize(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(SUMMARIZE_CACHE, { create: true, append: true });
  for (const [id, v] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${v.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

async function submitSummarizeBatch(todo: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(todo.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 60,
        system: [{ type: "text", text: SUMMARIZE_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: t.title }],
      },
    };
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`summarize batch submit ${res.status}: ${await res.text()}`);
  const j = await res.json();
  console.log(`[stage 1c] batch submitted: ${j.id} (${requests.length} requests)`);
  return { batchId: j.id, idMap };
}

async function stage1cSummarize() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const MAX_LEN = Number(Deno.env.get("SUMMARIZE_MAX_LEN") ?? "120");

  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[1].length > MAX_LEN) targets.push({ id: c[0], title: c[1] });
  }

  const cache = loadSummarizeCache();
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[stage 1c] long-title skills: ${targets.length}, cached: ${targets.length - todo.length}, to submit: ${todo.length}`);

  let state: { id: string; idMap: Record<string, string> } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(SUMMARIZE_BATCH_STATE)); } catch { /* none */ }

  if (state) {
    console.log(`[stage 1c] resuming batch ${state.id}`);
    while (true) {
      const p = await pollBatch(state.id);
      console.log(`  status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("no results_url");
        const results = await downloadBatchResults(p.resultsUrl, state.idMap);
        appendSummarize(results);
        Deno.removeSync(SUMMARIZE_BATCH_STATE);
        writeStats(12, { targets: targets.length, results: Object.keys(results).length });
        return;
      }
      await new Promise((r) => setTimeout(r, 30000));
    }
  }

  if (todo.length === 0) { console.log("[stage 1c] all cached"); return; }

  const CHUNK = 90000;
  const chunk = todo.slice(0, CHUNK);
  if (Deno.env.get("INFILL_LIMIT")) {
    chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
  }
  const { batchId, idMap } = await submitSummarizeBatch(chunk);
  Deno.writeTextFileSync(SUMMARIZE_BATCH_STATE, JSON.stringify({ id: batchId, idMap }));
  console.log(`[stage 1c] batch submitted; re-run \`pipeline.ts summarize\` to poll`);
}

// ---------- stage 2: embed ----------

// Prefer deduped tagged output if present (stage 3b); falls back to stage 3.
function taggedTsvPath(): string {
  try { Deno.statSync(`${BUILD}/3b_tagged_deduped.tsv`); return `${BUILD}/3b_tagged_deduped.tsv`; } catch { return `${BUILD}/3_tagged.tsv`; }
}

const OLLAMA = Deno.env.get("OLLAMA_HOST") ?? "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;
const CACHE_PATH = `${BUILD}/2_cache.bin`;
const CACHE_RECORD_BYTES = 32 + EMBED_DIM * 4;

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

function loadCache(): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  let data: Uint8Array;
  try { data = Deno.readFileSync(CACHE_PATH); } catch { return cache; }
  if (data.byteLength % CACHE_RECORD_BYTES !== 0) {
    throw new Error(`cache file ${CACHE_PATH} size ${data.byteLength} not multiple of ${CACHE_RECORD_BYTES}; delete to rebuild`);
  }
  const n = data.byteLength / CACHE_RECORD_BYTES;
  for (let i = 0; i < n; i++) {
    const off = i * CACHE_RECORD_BYTES;
    const hash = Array.from(data.slice(off, off + 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const vec = new Float32Array(data.buffer.slice(data.byteOffset + off + 32, data.byteOffset + off + CACHE_RECORD_BYTES));
    cache.set(hash, vec);
  }
  console.log(`[stage 2] loaded cache: ${cache.size} vectors`);
  return cache;
}

function appendCache(fh: Deno.FsFile, hashBytes: Uint8Array, vec: Float32Array) {
  const rec = new Uint8Array(CACHE_RECORD_BYTES);
  rec.set(hashBytes, 0);
  rec.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 32);
  fh.writeSync(rec);
}

async function embedOne(content: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: content }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.embedding || j.embedding.length !== EMBED_DIM) {
    throw new Error(`bad embedding: length=${j.embedding?.length}, expected ${EMBED_DIM}`);
  }
  return new Float32Array(j.embedding);
}

async function stage2Embed() {
  const tsv = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`);
  const lines = tsv.split("\n").filter((l) => l.length);
  const skills: { id: string; content: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    const content = c[2] ? `${c[1]}\n${c[2]}` : c[1];
    skills.push({ id: c[0], content });
  }
  if (Deno.env.get("SKILL_LIMIT")) {
    skills.length = Math.min(skills.length, Number(Deno.env.get("SKILL_LIMIT")));
    console.log(`[stage 2] SKILL_LIMIT → ${skills.length} skills`);
  }
  console.log(`[stage 2] embedding ${skills.length} skills…`);

  const hashes = await Promise.all(skills.map((s) => sha256(s.content)));
  const hashHex = hashes.map((h) => Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const cache = loadCache();
  const cacheFh = Deno.openSync(CACHE_PATH, { create: true, append: true });

  const concurrency = Number(Deno.env.get("EMBED_CONCURRENCY") ?? "8");
  const missing: number[] = [];
  for (let i = 0; i < skills.length; i++) if (!cache.has(hashHex[i])) missing.push(i);
  console.log(`[stage 2] cached: ${skills.length - missing.length}; to compute: ${missing.length}; concurrency: ${concurrency}`);

  const latencies: number[] = [];
  let done = 0;
  const t0 = performance.now();
  async function worker(queue: number[]) {
    while (queue.length) {
      const idx = queue.shift()!;
      const t = performance.now();
      try {
        const vec = await embedOne(skills[idx].content);
        latencies.push(performance.now() - t);
        cache.set(hashHex[idx], vec);
        appendCache(cacheFh, hashes[idx], vec);
      } catch (err) {
        throw new Error(`embed failed for ${skills[idx].id}: ${(err as Error).message}`);
      }
      done++;
      if (done % 500 === 0) {
        const elapsed = (performance.now() - t0) / 1000;
        const rate = done / elapsed;
        const eta = (missing.length - done) / rate;
        console.log(`  ${done}/${missing.length} (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`);
      }
    }
  }
  const queue = [...missing];
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
  cacheFh.close();

  // Write bin + ids in skill order
  const bin = new Float32Array(skills.length * EMBED_DIM);
  let nans = 0;
  const seen = new Map<string, number>();
  let dupes = 0;
  for (let i = 0; i < skills.length; i++) {
    const vec = cache.get(hashHex[i])!;
    if (!vec) throw new Error(`missing vec for ${skills[i].id}`);
    for (let j = 0; j < EMBED_DIM; j++) if (!Number.isFinite(vec[j])) nans++;
    bin.set(vec, i * EMBED_DIM);
    const key = hashHex[i];
    const prev = seen.get(key);
    if (prev !== undefined) dupes++;
    else seen.set(key, i);
  }
  Deno.writeFileSync(`${BUILD}/2_embeddings.bin`, new Uint8Array(bin.buffer));
  Deno.writeTextFileSync(`${BUILD}/2_ids.tsv`, skills.map((s) => s.id).join("\n") + "\n");

  writeStats(2, {
    total: skills.length,
    newly_computed: missing.length,
    cache_hits: skills.length - missing.length,
    dim: EMBED_DIM,
    nan_count: nans,
    duplicate_content: dupes,
    latency_ms: latencies.length
      ? { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: Math.max(...latencies) }
      : null,
    total_seconds: (performance.now() - t0) / 1000,
  });

  if (nans > 0) throw new Error(`stage 2: ${nans} NaN/Inf values in embeddings`);
}

// ---------- stage 3: tag ----------

function parseOccupationRefs(): { label: string; desc: string }[] {
  const refs: { label: string; desc: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, desc: string) => {
    label = label.trim();
    if (!label) return;
    const k = label.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    refs.push({ label, desc: desc.trim() });
  };

  // ESCO occupations
  const esco = parseCsv(Deno.readTextFileSync("data/esco/occupations_en.csv"));
  const eHdr = esco[0];
  const eLabel = eHdr.indexOf("preferredLabel");
  const eDesc = eHdr.indexOf("description");
  for (let i = 1; i < esco.length; i++) push(esco[i][eLabel] || "", esco[i][eDesc] || "");
  const afterEsco = refs.length;

  // ONET occupations
  const onet = parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt"));
  const oHdr = onet[0];
  const oTitle = oHdr.indexOf("Title");
  const oDesc = oHdr.indexOf("Description");
  for (let i = 1; i < onet.length; i++) push(onet[i][oTitle] || "", onet[i][oDesc] || "");

  console.log(`[stage 3] occupation refs: esco=${afterEsco}, onet=${refs.length - afterEsco}, total=${refs.length}`);
  return refs;
}

// Two-pass streaming to control memory: pass 1 = broader in-degree only; pass 2 = labels for top-N URIs.
async function streamLines(cmd: string[], onLine: (line: string) => void) {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" }).spawn();
  const lines = p.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) onLine(line);
  await p.status;
}

async function parseTopicSource(name: string, cmd: string[], perSource: number): Promise<{ uri: string; label: string; inDeg: number }[]> {
  const BROADER = "skos/core#broader";
  const PREF = "skos/core#prefLabel";
  const BADCAT = /^(Wikipedia|Lists of|List of|Categories |Redirects|Articles |Stubs|Templates|Commons|Set indices)/i;

  console.log(`[stage 3] ${name}: pass 1 (broader in-degree)`);
  const inDeg = new Map<string, number>();
  let n = 0;
  await streamLines(cmd, (line) => {
    if (line.length < 40 || line[0] === "#") return;
    if (!line.includes(BROADER)) return;
    const m = line.match(/^<[^>]+>\s+<[^>]+>\s+<([^>]+)>\s*\.$/);
    if (m) inDeg.set(m[1], (inDeg.get(m[1]) ?? 0) + 1);
    if (++n % 2000000 === 0) console.log(`  ${name} p1: ${n} lines, ${inDeg.size} targets`);
  });
  console.log(`  ${name}: ${inDeg.size} broader targets`);

  // Keep up to 5× perSource candidates (we'll filter by label quality next, then trim)
  const top = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, perSource * 5);
  const topSet = new Map(top.map(([uri, d]) => [uri, d]));
  inDeg.clear();

  console.log(`[stage 3] ${name}: pass 2 (labels for top ${topSet.size})`);
  const labels = new Map<string, string>();
  n = 0;
  await streamLines(cmd, (line) => {
    if (line.length < 40 || line[0] === "#") return;
    if (!line.includes(PREF)) return;
    const m = line.match(/^<([^>]+)>\s+<[^>]+>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/);
    if (!m) return;
    if (!topSet.has(m[1])) return;
    const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (lbl.length < 2 || lbl.length > 50) return;
    if (BADCAT.test(lbl)) return;
    // Only keep short labels — 1 to 4 words, no parenthetical qualifiers
    const words = lbl.split(/\s+/);
    if (words.length > 4) return;
    if (lbl.includes("(") || lbl.includes(",")) return;
    labels.set(m[1], lbl);
    if (++n % 500000 === 0) console.log(`  ${name} p2: ${n} lines, ${labels.size} labeled`);
  });

  const scored: { uri: string; label: string; inDeg: number }[] = [];
  for (const [uri, label] of labels) scored.push({ uri, label, inDeg: topSet.get(uri)! });
  scored.sort((a, b) => b.inDeg - a.inDeg);
  return scored.slice(0, perSource);
}

async function parseTopicRefs(perSource: number): Promise<{ label: string; desc: string }[]> {
  const topLcsh = await parseTopicSource(
    "lcsh",
    ["sh", "-c", "gunzip -c data/lcsh/subjects.skosrdf.nt.gz"],
    perSource,
  );
  const topDbp = await parseTopicSource(
    "dbpedia",
    ["sh", "-c", "bzcat data/dbpedia/skos_categories_en.ttl.bz2"],
    perSource,
  );

  const refs: { label: string; desc: string }[] = [];
  const seen = new Set<string>();
  for (const r of [...topLcsh, ...topDbp]) {
    const k = r.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push({ label: r.label, desc: "" });
  }
  console.log(`[stage 3] topic refs: ${refs.length} (${topLcsh.length} lcsh + ${topDbp.length} dbp − overlap)`);
  return refs;
}

async function embedRefs(refs: { label: string; desc: string }[]): Promise<Float32Array[]> {
  const cache = loadCache();
  const cacheFh = Deno.openSync(CACHE_PATH, { create: true, append: true });

  // Embed labels only — including generic descriptions causes noise matches.
  const contents = refs.map((r) => r.label);
  const hashes = await Promise.all(contents.map((c) => sha256(c)));
  const hashHex = hashes.map((h) => Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const missing: number[] = [];
  for (let i = 0; i < refs.length; i++) if (!cache.has(hashHex[i])) missing.push(i);
  console.log(`[stage 3] embedding refs: ${refs.length} total, ${missing.length} to compute`);

  const concurrency = Number(Deno.env.get("EMBED_CONCURRENCY") ?? "8");
  let done = 0;
  const t0 = performance.now();
  async function worker(queue: number[]) {
    while (queue.length) {
      const i = queue.shift()!;
      const vec = await embedOne(contents[i]);
      cache.set(hashHex[i], vec);
      appendCache(cacheFh, hashes[i], vec);
      done++;
      if (done % 500 === 0) {
        const elapsed = (performance.now() - t0) / 1000;
        console.log(`  ${done}/${missing.length} (${(done / elapsed).toFixed(1)}/s)`);
      }
    }
  }
  const q = [...missing];
  await Promise.all(Array.from({ length: concurrency }, () => worker(q)));
  cacheFh.close();

  return refs.map((_, i) => cache.get(hashHex[i])!);
}

function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
  const inv = 1 / Math.sqrt(sq || 1);
  const r = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = v[i] * inv;
  return r;
}

// Walk ESCO broader hierarchy: child → direct parent label (first broader).
function parseEscoSkillTopics(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/broaderRelationsSkillPillar_en.csv"));
  const hdr = rows[0];
  const iChild = hdr.indexOf("conceptLabel");
  const iChildUri = hdr.indexOf("conceptUri");
  const iBroader = hdr.indexOf("broaderLabel");
  const iBroaderUri = hdr.indexOf("broaderUri");
  // Build URI → label map and URI → parents[]
  const label = new Map<string, string>();
  const parents = new Map<string, string[]>();
  for (let i = 1; i < rows.length; i++) {
    const cUri = rows[i][iChildUri], cLbl = rows[i][iChild];
    const pUri = rows[i][iBroaderUri], pLbl = rows[i][iBroader];
    if (cUri && cLbl) label.set(cUri, cLbl);
    if (pUri && pLbl) label.set(pUri, pLbl);
    if (cUri && pUri) {
      const arr = parents.get(cUri) ?? [];
      arr.push(pUri);
      parents.set(cUri, arr);
    }
  }
  // For each concept, walk up to the top and collect ancestor labels (skip generic roots "knowledge"/"skill")
  const GENERIC = new Set(["knowledge", "skill", "generic programmes and qualifications"]);
  const out = new Map<string, string[]>();
  for (const [uri, lbl] of label) {
    const topics: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = uri;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const ps = parents.get(cursor);
      if (!ps || !ps.length) break;
      for (const p of ps) {
        const pl = label.get(p);
        if (pl && !GENERIC.has(pl.toLowerCase()) && topics.indexOf(pl) < 0) topics.push(pl);
      }
      cursor = ps[0];
    }
    if (topics.length) out.set(slugify(lbl), topics);
  }
  console.log(`[stage 3] ESCO direct topics: ${out.size} skills/groups → topics`);
  return out;
}

// Build map slugify(ONET Element Name) → [occupation Title] from ONET's IM-scored occupation×skill matrix.
function parseOnetSkillOccupations(): Map<string, string[]> {
  // Load occupation titles
  const occTitles = new Map<string, string>();
  for (const row of parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt")).slice(1)) {
    if (row[0] && row[1]) occTitles.set(row[0], row[1]);
  }
  // CMR for Element ID → Name
  const cmr = new Map<string, string>();
  for (const row of parseTsv(Deno.readTextFileSync("data/onet/Content Model Reference.txt")).slice(1)) {
    if (row[0] && row[1]) cmr.set(row[0], row[1]);
  }
  // Aggregate IM score per (skill element, occupation); pick top-5 occupations per skill
  const perFile = ["Skills.txt", "Knowledge.txt", "Abilities.txt"];
  const bySkill = new Map<string, Map<string, number>>();
  for (const fname of perFile) {
    const rows = parseTsv(Deno.readTextFileSync(`data/onet/${fname}`));
    const hdr = rows[0];
    const iSoc = hdr.indexOf("O*NET-SOC Code");
    const iEl = hdr.indexOf("Element ID");
    const iScale = hdr.indexOf("Scale ID");
    const iVal = hdr.indexOf("Data Value");
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][iScale] !== "IM") continue;
      const name = cmr.get(rows[i][iEl]);
      if (!name) continue;
      const occ = occTitles.get(rows[i][iSoc]);
      if (!occ) continue;
      const v = Number(rows[i][iVal]);
      if (!Number.isFinite(v)) continue;
      const key = slugify(name);
      let m = bySkill.get(key);
      if (!m) { m = new Map(); bySkill.set(key, m); }
      m.set(occ, Math.max(m.get(occ) ?? 0, v));
    }
  }
  const out = new Map<string, string[]>();
  for (const [key, m] of bySkill) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    out.set(key, top);
  }
  console.log(`[stage 3] ONET direct occupations: ${out.size} skills → occupations`);
  return out;
}

// Build map slugify(skillLabel) → [occupationLabel] from ESCO's explicit relations.
function parseEscoSkillOccupations(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/occupationSkillRelations_en.csv"));
  const hdr = rows[0];
  const iOcc = hdr.indexOf("occupationLabel");
  const iSkill = hdr.indexOf("skillLabel");
  const iType = hdr.indexOf("relationType");
  const m = new Map<string, Set<string>>();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][iType] !== "essential") continue; // drop "optional" — less signal
    const slug = slugify(rows[i][iSkill] || "");
    const occ = rows[i][iOcc];
    if (!slug || !occ) continue;
    let s = m.get(slug);
    if (!s) { s = new Set(); m.set(slug, s); }
    s.add(occ);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  console.log(`[stage 3] ESCO direct occupations: ${out.size} skills → occupations`);
  return out;
}

async function stage3Tag() {
  // Load stage 1 skills
  const lines1 = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const skills = lines1.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4] };
  });

  // Load stage 2 embeddings
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  if (ids.length !== skills.length) throw new Error(`ids (${ids.length}) vs skills (${skills.length}) mismatch`);

  const DIM = EMBED_DIM;
  // Normalize skill embeddings in place
  const skillVecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const v = emb.subarray(i * DIM, (i + 1) * DIM);
    const n = normalize(v);
    skillVecs.set(n, i * DIM);
  }

  // Build refs
  const occRefs = parseOccupationRefs();
  const topicRefs = await parseTopicRefs(Number(Deno.env.get("TOPIC_PER_SOURCE") ?? "5000"));

  const occVecsRaw = await embedRefs(occRefs);
  const topicVecsRaw = await embedRefs(topicRefs);

  const packNorm = (vecs: Float32Array[]) => {
    const buf = new Float32Array(vecs.length * DIM);
    for (let i = 0; i < vecs.length; i++) buf.set(normalize(vecs[i]), i * DIM);
    return buf;
  };
  const occMat = packNorm(occVecsRaw);
  const topicMat = packNorm(topicVecsRaw);

  const OCC_K = Number(Deno.env.get("OCC_TOP_K") ?? "2");
  const TOPIC_K = Number(Deno.env.get("TOPIC_TOP_K") ?? "3");
  const OCC_THRESHOLD = Number(Deno.env.get("OCC_THRESHOLD") ?? "0.60");
  const TOPIC_THRESHOLD = Number(Deno.env.get("TOPIC_THRESHOLD") ?? "0.62");
  // Drop refs that match more than this fraction of skills — they're non-discriminative
  const IDF_MAX_FRAC = Number(Deno.env.get("IDF_MAX_FRAC") ?? "0.015");

  // One oversampled pass per ref set → prune degenerate refs by IDF → take top-K from survivors.
  const oversamplePass = (refMat: Float32Array, refCount: number, keep: number, thresh: number) => {
    const out: { idx: number; score: number }[][] = new Array(skills.length);
    const refHits = new Int32Array(refCount);
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * DIM;
      const top: { idx: number; score: number }[] = [];
      for (let r = 0; r < refCount; r++) {
        let s = 0;
        const rOff = r * DIM;
        for (let d = 0; d < DIM; d++) s += skillVecs[sOff + d] * refMat[rOff + d];
        if (s < thresh) continue;
        if (top.length < keep) {
          top.push({ idx: r, score: s });
          top.sort((a, b) => a.score - b.score);
        } else if (s > top[0].score) {
          top[0] = { idx: r, score: s };
          top.sort((a, b) => a.score - b.score);
        }
      }
      top.sort((a, b) => b.score - a.score);
      out[i] = top;
      for (const t of top) refHits[t.idx]++;
      if ((i + 1) % 10000 === 0) console.log(`    ${i + 1}/${skills.length}`);
    }
    return { out, refHits };
  };

  const pruneMask = (refHits: Int32Array, refs: { label: string }[], label: string): Uint8Array => {
    const maxHits = Math.floor(skills.length * IDF_MAX_FRAC);
    const mask = new Uint8Array(refs.length);
    let dropped = 0;
    const droppedLabels: string[] = [];
    for (let r = 0; r < refs.length; r++) {
      if (refHits[r] > maxHits) {
        dropped++;
        if (droppedLabels.length < 20) droppedLabels.push(`${refs[r].label}=${refHits[r]}`);
      } else {
        mask[r] = 1;
      }
    }
    console.log(`[stage 3] ${label}: pruned ${dropped}/${refs.length} refs (>${maxHits} hits). Top dropped: ${droppedLabels.slice(0, 10).join(", ")}`);
    return mask;
  };

  const OVERSAMPLE = 5;
  const t0 = performance.now();
  console.log(`[stage 3] matching ${skills.length} × ${occRefs.length} occs (keep ${OCC_K * OVERSAMPLE})…`);
  const occPass = oversamplePass(occMat, occRefs.length, OCC_K * OVERSAMPLE, OCC_THRESHOLD);
  const occMask = pruneMask(occPass.refHits, occRefs, "occ");
  console.log(`[stage 3] matching ${skills.length} × ${topicRefs.length} topics (keep ${TOPIC_K * OVERSAMPLE})…`);
  const topicPass = oversamplePass(topicMat, topicRefs.length, TOPIC_K * OVERSAMPLE, TOPIC_THRESHOLD);
  const topicMask = pruneMask(topicPass.refHits, topicRefs, "topic");

  const finalize = (pass: { out: { idx: number; score: number }[][] }, mask: Uint8Array, k: number): number[][] =>
    pass.out.map((row) => row.filter((r) => mask[r.idx]).slice(0, k).map((r) => r.idx));

  // For occupations: after picking top-k, drop occupations that are semantically distant from each other
  // (cosine between them < OCC_PAIR_MIN). Weeds out bizarre pairings like plumbers+hairdressers.
  const OCC_PAIR_MIN = Number(Deno.env.get("OCC_PAIR_MIN") ?? "0.5");
  const occFinalizeWithPairFilter = (pass: { out: { idx: number; score: number }[][] }, mask: Uint8Array, k: number): number[][] => {
    const results: number[][] = [];
    let droppedByPair = 0;
    for (const row of pass.out) {
      const kept = row.filter((r) => mask[r.idx]);
      if (kept.length <= 1) { results.push(kept.slice(0, k).map((r) => r.idx)); continue; }
      // Keep top-1 always; for each subsequent, check cosine against all already-kept
      const finalIdxs: number[] = [kept[0].idx];
      for (let j = 1; j < kept.length && finalIdxs.length < k; j++) {
        const rj = kept[j].idx;
        let minCos = 1;
        for (const ki of finalIdxs) {
          let sc = 0;
          for (let d = 0; d < DIM; d++) sc += occMat[rj * DIM + d] * occMat[ki * DIM + d];
          if (sc < minCos) minCos = sc;
        }
        if (minCos >= OCC_PAIR_MIN) finalIdxs.push(rj);
        else droppedByPair++;
      }
      results.push(finalIdxs);
    }
    console.log(`[stage 3] occ pair filter: dropped ${droppedByPair} distant-pair occupations`);
    return results;
  };

  const occFinal = occFinalizeWithPairFilter(occPass, occMask, OCC_K);
  const topicFinal = finalize(topicPass, topicMask, TOPIC_K);

  const directEsco = parseEscoSkillOccupations();
  const directOnet = parseOnetSkillOccupations();
  const directEscoTopics = parseEscoSkillTopics();
  const DIRECT_OCC_CAP = Number(Deno.env.get("DIRECT_OCC_CAP") ?? "3");
  const DIRECT_TOPIC_CAP = Number(Deno.env.get("DIRECT_TOPIC_CAP") ?? "3");

  // Extract a framework-derived topic from OpenSALT tags (e.g. "framework:common-core-math-standards" → "math-standards")
  const frameworkTopic = (tagString: string): string | null => {
    const m = tagString.match(/framework:([^,]+)/);
    if (!m) return null;
    const raw = m[1];
    // Strip leading source/jurisdiction tokens — keep the content token(s)
    const simplified = raw.replace(/^(ui-|gcps-aks-|pcg-|ccs-|chicago-public-schools-illinois-|western-and-northern-canadian-protocol-)/, "");
    return simplified;
  };

  const rows: string[] = ["id\ttitle\tdescription\tsources\ttags\toccupations\ttopics"];
  const occCount = new Map<string, number>();
  const topicCount = new Map<string, number>();
  const occPerSkill: number[] = [];
  const topicPerSkill: number[] = [];
  let directOccHits = 0, directTopicHits = 0, frameworkHits = 0;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    let occSlugs = occFinal[i].map((r) => slugify(occRefs[r].label)).filter((x) => x);
    let topicSlugs = topicFinal[i].map((r) => slugify(topicRefs[r].label)).filter((x) => x);

    if (s.sources.includes("esco")) {
      const dOcc = directEsco.get(s.id);
      if (dOcc?.length) {
        directOccHits++;
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map(slugify).filter((x) => x);
        occSlugs = [...new Set([...direct, ...occSlugs])].slice(0, DIRECT_OCC_CAP);
      }
      const dTopic = directEscoTopics.get(s.id);
      if (dTopic?.length) {
        directTopicHits++;
        const direct = dTopic.slice(0, DIRECT_TOPIC_CAP).map(slugify).filter((x) => x);
        topicSlugs = [...new Set([...direct, ...topicSlugs])].slice(0, DIRECT_TOPIC_CAP);
      }
    }
    if (s.sources.includes("onet")) {
      const dOcc = directOnet.get(s.id);
      if (dOcc?.length) {
        directOccHits++;
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map(slugify).filter((x) => x);
        occSlugs = [...new Set([...direct, ...occSlugs])].slice(0, DIRECT_OCC_CAP);
      }
    }
    if (s.sources.includes("opensalt")) {
      const ft = frameworkTopic(s.tags);
      if (ft) {
        frameworkHits++;
        topicSlugs = [...new Set([ft, ...topicSlugs])].slice(0, DIRECT_TOPIC_CAP);
      }
    }

    for (const x of occSlugs) occCount.set(x, (occCount.get(x) ?? 0) + 1);
    for (const x of topicSlugs) topicCount.set(x, (topicCount.get(x) ?? 0) + 1);
    occPerSkill.push(occSlugs.length);
    topicPerSkill.push(topicSlugs.length);
    rows.push([s.id, s.title, s.description, s.sources, s.tags, occSlugs.join(","), topicSlugs.join(",")].join("\t"));
  }
  console.log(`[stage 3] direct tags: ${directOccHits} esco-occ, ${directTopicHits} esco-topic, ${frameworkHits} opensalt-framework`);
  Deno.writeTextFileSync(`${BUILD}/3_tagged.tsv`, rows.join("\n") + "\n");
  // Stage 3b output, if it exists, is now stale — remove so stages 4+ reread from stage 3 until dedupe re-runs
  try { Deno.removeSync(`${BUILD}/3b_tagged_deduped.tsv`); } catch { /* ignore */ }

  const topN = (counts: Map<string, number>, n: number) =>
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  writeStats(3, {
    skills: skills.length,
    occ_refs: occRefs.length,
    topic_refs: topicRefs.length,
    occ_threshold: OCC_THRESHOLD,
    topic_threshold: TOPIC_THRESHOLD,
    occ_top_k: OCC_K,
    topic_top_k: TOPIC_K,
    occ_per_skill: { p50: pct(occPerSkill, 0.5), p95: pct(occPerSkill, 0.95), max: Math.max(...occPerSkill), mean: occPerSkill.reduce((a, b) => a + b, 0) / occPerSkill.length },
    topic_per_skill: { p50: pct(topicPerSkill, 0.5), p95: pct(topicPerSkill, 0.95), max: Math.max(...topicPerSkill), mean: topicPerSkill.reduce((a, b) => a + b, 0) / topicPerSkill.length },
    untagged_occupation: occPerSkill.filter((n) => n === 0).length,
    untagged_topic: topicPerSkill.filter((n) => n === 0).length,
    top_occupations: topN(occCount, 20),
    top_topics: topN(topicCount, 20),
    total_seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 4: difficulty ----------

// Map a grade token to a difficulty in [0, 15]. 0 = pre-K; 1 = kindergarten; then grades 1-12 map to 2-13; post-secondary tokens → 14-15.
function gradeToDifficulty(token: string): number | null {
  const t = token.toUpperCase().trim();
  if (t === "PK" || t === "PR" || t === "PRE-K" || t === "EC") return 0;
  if (t === "KG" || t === "K") return 1;
  const m = t.match(/^0?(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) return n + 1;
  }
  if (t === "IT" || t === "CTE") return 14;
  if (/AP|COLLEGE|UG|UNDERGRAD/.test(t)) return 15;
  return null;
}

function stage4Difficulty() {
  const lines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = lines[0].split("\t");
  const iTags = hdr.indexOf("tags");
  const iSources = hdr.indexOf("sources");
  const iTopics = hdr.indexOf("topics");
  const skills = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], sources: c[iSources], tags: c[iTags], topics: c[iTopics] };
  });

  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToEmbIdx.set(ids[i], i);

  const DIM = EMBED_DIM;
  const vecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const ei = idToEmbIdx.get(skills[i].id);
    if (ei === undefined) throw new Error(`no embedding for ${skills[i].id}`);
    vecs.set(normalize(emb.subarray(ei * DIM, (ei + 1) * DIM)), i * DIM);
  }

  // Anchor difficulty per skill: OpenSALT grade > Khan V-position > unset (NaN)
  const anchor = new Float32Array(skills.length);
  anchor.fill(Number.NaN);
  let gradeAnchored = 0, khanAnchored = 0;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const matches = [...s.tags.matchAll(/grade:([^,]+)/g)];
    const grades: number[] = [];
    for (const m of matches) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (grades.length) {
      anchor[i] = Math.max(...grades);
      gradeAnchored++;
    }
  }
  // D2: Khan Academy V-Position as pseudo-grade anchor for unanchored skills that resolve
  // to Khan concepts. V-position ranges ~1-80 across the curriculum; map linearly to K-12.
  try {
    const lines = Deno.readTextFileSync("data/khanacademy/khandata.tsv").split("\n").filter((l) => l.length);
    const hdr = lines[0].split("\t");
    const iName = hdr.indexOf("Data Name");
    const iDisp = hdr.indexOf("Display Name");
    const iV = hdr.indexOf("V-Position");
    const labelToV = new Map<string, number>();
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      const v = Number(c[iV]);
      if (!Number.isFinite(v)) continue;
      vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      for (const lbl of [c[iName], c[iDisp]]) {
        if (lbl) {
          const slug = slugify(lbl);
          if (!labelToV.has(slug)) labelToV.set(slug, v);
        }
      }
    }
    const slugToIdx = new Map<string, number>();
    for (let i = 0; i < skills.length; i++) {
      slugToIdx.set(skills[i].id, i);
      const altSlug = slugify(skills[i].title);
      if (!slugToIdx.has(altSlug)) slugToIdx.set(altSlug, i);
    }
    if (vMax > vMin) {
      for (const [lbl, v] of labelToV) {
        const i = slugToIdx.get(lbl);
        if (i === undefined) continue;
        if (!Number.isNaN(anchor[i])) continue; // keep explicit grade tag if present
        const vGrade = (v - vMin) / (vMax - vMin) * 12; // linear to 0-12
        anchor[i] = vGrade;
        khanAnchored++;
      }
    }
  } catch { /* no khan data */ }
  const totalAnchored = gradeAnchored + khanAnchored;
  const unanchored = skills.length - totalAnchored;
  console.log(`[stage 4] anchors: grade=${gradeAnchored}, khan=${khanAnchored}, unanchored=${unanchored}`);

  // Collect anchor indices
  const anchorIdxs: number[] = [];
  for (let i = 0; i < skills.length; i++) if (!Number.isNaN(anchor[i])) anchorIdxs.push(i);
  console.log(`[stage 4] total anchors: ${anchorIdxs.length}`);

  // For each skill (including anchors, for consistency/smoothing), compute difficulty as kNN weighted mean of anchor difficulties.
  const K = Number(Deno.env.get("KNN_K") ?? "15");
  const t0 = performance.now();

  // Build topic → anchor set
  const topicToAnchors = new Map<string, number[]>();
  for (let a = 0; a < anchorIdxs.length; a++) {
    const ai = anchorIdxs[a];
    for (const topic of skills[ai].topics.split(",")) {
      if (!topic) continue;
      let arr = topicToAnchors.get(topic);
      if (!arr) { arr = []; topicToAnchors.set(topic, arr); }
      arr.push(a);
    }
  }
  console.log(`[stage 4] topic-to-anchor index: ${topicToAnchors.size} topics`);

  const candidates = (i: number): number[] => {
    const seen = new Set<number>();
    for (const topic of skills[i].topics.split(",")) {
      if (!topic) continue;
      const arr = topicToAnchors.get(topic);
      if (!arr) continue;
      for (const a of arr) seen.add(a);
    }
    return seen.size ? [...seen] : []; // empty → fall back to global kNN
  };
  let out: Float32Array;
  try {
    const cached = Deno.readFileSync(`${BUILD}/4_raw.bin`);
    if (cached.byteLength === skills.length * 4) {
      out = new Float32Array(cached.buffer, cached.byteOffset, skills.length);
      console.log(`[stage 4] loaded cached raw scores from 4_raw.bin — skipping kNN`);
    } else {
      throw new Error("size mismatch");
    }
  } catch {
    out = new Float32Array(skills.length);
  }
  let withinTopicHits = 0, globalFallbacks = 0;
  if (out.every((v) => v === 0)) {
  // Pack anchor vectors contiguously for cache-friendly inner loop
  const anchorMat = new Float32Array(anchorIdxs.length * DIM);
  const anchorDiff = new Float32Array(anchorIdxs.length);
  for (let a = 0; a < anchorIdxs.length; a++) {
    const ai = anchorIdxs[a];
    anchorMat.set(vecs.subarray(ai * DIM, (ai + 1) * DIM), a * DIM);
    anchorDiff[a] = anchor[ai];
  }

  for (let i = 0; i < skills.length; i++) {
    const sOff = i * DIM;
    const top: { score: number; a: number }[] = [];
    let pool: number[] | null = candidates(i);
    if (!pool.length) pool = null; // fall back to all anchors
    if (pool) withinTopicHits++; else globalFallbacks++;
    const iter = pool ?? null;
    const n = iter ? iter.length : anchorIdxs.length;
    for (let k = 0; k < n; k++) {
      const a = iter ? iter[k] : k;
      let sc = 0;
      const aOff = a * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * anchorMat[aOff + d];
      if (top.length < K) {
        top.push({ score: sc, a });
        if (top.length === K) top.sort((x, y) => x.score - y.score);
      } else if (sc > top[0].score) {
        top[0] = { score: sc, a };
        top.sort((x, y) => x.score - y.score);
      }
    }
    // Weighted mean by score² (softmax-ish; higher similarity dominates)
    let num = 0, den = 0;
    for (const { score, a } of top) {
      const w = Math.max(0, score) ** 2;
      num += w * anchorDiff[a];
      den += w;
    }
    out[i] = den > 0 ? num / den : (Number.isNaN(anchor[i]) ? 10 : anchor[i]);
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(`  ${i + 1}/${skills.length} (${((i + 1) / el).toFixed(0)}/s)`);
    }
  }
  } // end kNN guard

  // D3: kNN within-topic smoothing (pull each raw toward topic-mean to reduce outliers)
  const SMOOTH_W = Number(Deno.env.get("SMOOTH_W") ?? "0.3");
  const smoothed = new Float32Array(out);
  if (SMOOTH_W > 0) {
    // Group by primary topic, compute topic mean, pull raw toward it
    const topicSum = new Map<string, { sum: number; n: number }>();
    for (let i = 0; i < skills.length; i++) {
      for (const t of skills[i].topics.split(",")) {
        if (!t) continue;
        const e = topicSum.get(t) ?? { sum: 0, n: 0 };
        e.sum += out[i]; e.n++; topicSum.set(t, e);
      }
    }
    for (let i = 0; i < skills.length; i++) {
      let sum = 0, n = 0;
      for (const t of skills[i].topics.split(",")) {
        if (!t) continue;
        const e = topicSum.get(t);
        if (!e || e.n < 3) continue;
        sum += (e.sum - out[i]) / (e.n - 1);
        n++;
      }
      if (n > 0) smoothed[i] = (1 - SMOOTH_W) * out[i] + SMOOTH_W * (sum / n);
    }
  }

  // Jitter for tie-breaks
  const jittered = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    let h = 0;
    for (let k = 0; k < skills[i].id.length; k++) h = ((h * 31) + skills[i].id.charCodeAt(k)) | 0;
    const jit = ((h >>> 0) % 1000) / 1000;
    jittered[i] = smoothed[i] + (jit - 0.5) * 0.001;
  }

  // D1: isotonic PAV fit on anchored skills (raw → grade). Then apply to all skills.
  // Anchors are K-12 grades (0..12). Workplace skills extrapolate via linear endpoint slope.
  type PavNode = { x: number; y: number; w: number };
  const pairs: [number, number][] = [];
  for (const ai of anchorIdxs) pairs.push([jittered[ai], anchor[ai]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const pav: PavNode[] = [];
  for (const [x, y] of pairs) {
    let cur: PavNode = { x, y, w: 1 };
    while (pav.length && pav[pav.length - 1].y > cur.y) {
      const prev = pav.pop()!;
      cur = { x: prev.x, y: (prev.y * prev.w + cur.y * cur.w) / (prev.w + cur.w), w: prev.w + cur.w };
    }
    pav.push(cur);
  }
  const pavX = pav.map((p) => p.x);
  const pavY = pav.map((p) => p.y);
  // Endpoint slope for extrapolation (use last 10% of steps to estimate)
  const tailStart = Math.max(0, pavX.length - Math.max(2, Math.floor(pavX.length * 0.1)));
  const tailDX = pavX[pavX.length - 1] - pavX[tailStart];
  const tailDY = pavY[pavY.length - 1] - pavY[tailStart];
  const tailSlope = tailDX > 0 ? tailDY / tailDX : 0.5;
  const calibrate = (raw: number): number => {
    if (pavX.length === 0) return raw;
    if (raw <= pavX[0]) return pavY[0];
    if (raw >= pavX[pavX.length - 1]) {
      return pavY[pavY.length - 1] + tailSlope * (raw - pavX[pavX.length - 1]);
    }
    let lo = 0, hi = pavX.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pavX[mid] <= raw) lo = mid; else hi = mid;
    }
    const span = pavX[hi] - pavX[lo];
    const t = span > 0 ? (raw - pavX[lo]) / span : 0;
    return pavY[lo] + t * (pavY[hi] - pavY[lo]);
  };
  const calibrated = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const base = calibrate(jittered[i]);
    // Workplace bonus in CALIBRATED (grade) space: non-OpenSALT skills get +3 grades
    calibrated[i] = base + (skills[i].sources.includes("opensalt") ? 0 : 3);
  }
  console.log(`[stage 4] isotonic: ${pavX.length} PAV steps from ${anchorIdxs.length} anchors, tail_slope=${tailSlope.toFixed(3)}`);

  // Bucket calibrated values (≈grade) into 20 bands. Grade 0-12 → bands 1-13; workplace → 14-20.
  const sorted = [...calibrated].sort((a, b) => a - b);
  const rawMin = sorted[0], rawMax = sorted[sorted.length - 1];
  const band = new Int32Array(skills.length);
  const bandCounts = new Array(20).fill(0);
  for (let i = 0; i < skills.length; i++) {
    const b = Math.max(1, Math.min(20, Math.round(calibrated[i]) + 1));
    band[i] = b;
    bandCounts[b - 1]++;
  }
  void rawMin; void rawMax;

  // Write
  const rows = ["id\tdifficulty\tdifficulty_raw"];
  for (let i = 0; i < skills.length; i++) rows.push(`${skills[i].id}\t${band[i]}\t${out[i].toFixed(4)}`);
  Deno.writeTextFileSync(`${BUILD}/4_difficulty.tsv`, rows.join("\n") + "\n");
  // Cache raw scores so we can re-bin without rerunning kNN
  Deno.writeFileSync(`${BUILD}/4_raw.bin`, new Uint8Array(out.buffer));

  // Kendall-τ between grade-anchor ordering and final band, on grade-anchored subset
  let concordant = 0, discordant = 0;
  const sample: { raw: number; a: number }[] = [];
  for (let i = 0; i < skills.length; i++) if (!Number.isNaN(anchor[i]) && anchor[i] < 14) sample.push({ raw: out[i], a: anchor[i] });
  sample.length = Math.min(sample.length, 2000);
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const ds = Math.sign(sample[i].raw - sample[j].raw);
      const da = Math.sign(sample[i].a - sample[j].a);
      if (ds === 0 || da === 0) continue;
      if (ds === da) concordant++; else discordant++;
    }
  }
  const tau = concordant + discordant ? (concordant - discordant) / (concordant + discordant) : 0;

  writeStats(4, {
    skills: skills.length,
    anchors: { grade: gradeAnchored, total: anchorIdxs.length, unanchored },
    within_topic: withinTopicHits,
    global_fallbacks: globalFallbacks,
    raw_stats: { p05: pct([...out], 0.05), p50: pct([...out], 0.5), p95: pct([...out], 0.95), min: sorted[0], max: sorted[sorted.length - 1] },
    band_distribution: bandCounts,
    kendall_tau_vs_anchor: tau,
    total_seconds: (performance.now() - t0) / 1000,
  });

  if (bandCounts.some((c) => c < skills.length * 0.01)) {
    console.warn(`[stage 4] warning: some bands have <1% of skills: ${bandCounts.join(", ")}`);
  }
}

// ---------- stage 5: prereq ----------

const PREREQ_CANDIDATES_CACHE = `${BUILD}/5_candidates.tsv`;
const PREREQ_BATCH_STATE = `${BUILD}/5_batch.json`;
const PREREQ_CACHE = `${BUILD}/5_prereqs.tsv`;
const PREREQ_SYSTEM = `You identify true prerequisites for a skill. Given a skill and a numbered list of candidate prerequisites (all from easier/earlier material), return the numbers of candidates that MUST be understood first before learning the skill. Be strict — only include genuinely foundational dependencies, not merely related or adjacent topics. Return ONLY a comma-separated list of numbers (e.g. "2,5,9") or the word "none". No explanation.`;

function parseSkillsWithDifficulty(): { skills: { id: string; title: string; description: string; topics: string }[]; diff: Int32Array; raw: Float32Array } {
  const tagged = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const taggedHdr = tagged[0].split("\t");
  const iTitle = taggedHdr.indexOf("title");
  const iDesc = taggedHdr.indexOf("description");
  const iTopics = taggedHdr.indexOf("topics");
  const skills = tagged.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[iTitle], description: c[iDesc], topics: c[iTopics] };
  });

  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length).slice(1);
  const diffMap = new Map<string, { band: number; raw: number }>();
  for (const l of diffLines) { const c = l.split("\t"); diffMap.set(c[0], { band: Number(c[1]), raw: Number(c[2]) }); }
  const diff = new Int32Array(skills.length);
  const raw = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const e = diffMap.get(skills[i].id);
    if (!e) throw new Error(`no difficulty for ${skills[i].id}`);
    diff[i] = e.band;
    raw[i] = e.raw;
  }
  return { skills, diff, raw };
}

function loadPrereqCandidates(): Map<string, number[]> {
  try {
    const text = Deno.readTextFileSync(PREREQ_CANDIDATES_CACHE);
    const m = new Map<string, number[]>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const idxStr = line.slice(tab + 1);
      m.set(id, idxStr ? idxStr.split(",").map(Number).filter((n) => Number.isFinite(n)) : []);
    }
    return m;
  } catch { return new Map(); }
}

function computePrereqCandidates(): Map<string, number[]> {
  const { skills, raw } = parseSkillsWithDifficulty();
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToEmbIdx.set(ids[i], i);
  const DIM = EMBED_DIM;
  const vecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const ei = idToEmbIdx.get(skills[i].id);
    if (ei === undefined) throw new Error(`no embedding for ${skills[i].id}`);
    vecs.set(normalize(emb.subarray(ei * DIM, (ei + 1) * DIM)), i * DIM);
  }

  // topic → indexes (with difficulty)
  const topicIdx = new Map<string, number[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      let arr = topicIdx.get(t);
      if (!arr) { arr = []; topicIdx.set(t, arr); }
      arr.push(i);
    }
  }

  const K = Number(Deno.env.get("PREREQ_K") ?? "15");
  const MIN_DIFF = Number(Deno.env.get("PREREQ_MIN_DIFF_DELTA") ?? "0.3");
  const ANCESTOR_K = Number(Deno.env.get("PREREQ_ANCESTOR_K") ?? "5");
  // A3: reserve slots for globally-closest lower-diff candidates (catches cross-topic prereqs
  // that topic-scoped retrieval misses, e.g. "linear-algebra" as prereq of "pca").
  const GLOBAL_K = Number(Deno.env.get("PREREQ_GLOBAL_K") ?? "5");
  const out = new Map<string, number[]>();
  const outLines: string[] = [];

  const t0 = performance.now();
  for (let i = 0; i < skills.length; i++) {
    // Pool: within-topic skills with strictly lower raw difficulty (peer candidates)
    const pool = new Set<number>();
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      const arr = topicIdx.get(t);
      if (!arr) continue;
      for (const j of arr) if (raw[j] + MIN_DIFF <= raw[i]) pool.add(j);
    }
    // Fallback: global easier skills if pool is small
    let candidates: number[];
    if (pool.size >= K) {
      candidates = [...pool];
    } else {
      candidates = [];
      for (let j = 0; j < skills.length; j++) if (raw[j] + MIN_DIFF <= raw[i]) candidates.push(j);
    }

    // Ancestor seed: reserve ANCESTOR_K slots for much-lower-difficulty skills in same top-topic.
    // Catches foundational prereqs (e.g. "programming fundamentals" for "javascript").
    const ancestorSet = new Set<number>();
    const topics = skills[i].topics.split(",").filter((t) => t);
    if (topics.length > 0 && ANCESTOR_K > 0) {
      const ancestorMaxDiff = raw[i] - 2; // require ≥2 raw units lower
      for (const t of topics) {
        const arr = topicIdx.get(t);
        if (!arr) continue;
        // Sort arr by raw difficulty ascending, pick lowest few
        const sorted = [...arr].sort((a, b) => raw[a] - raw[b]);
        for (let k = 0; k < sorted.length && ancestorSet.size < ANCESTOR_K; k++) {
          if (raw[sorted[k]] <= ancestorMaxDiff) ancestorSet.add(sorted[k]);
          else break;
        }
        if (ancestorSet.size >= ANCESTOR_K) break;
      }
    }

    // Top (K - ancestorSet.size - GLOBAL_K) by cosine similarity among in-topic candidates
    const sOff = i * DIM;
    const top: { idx: number; score: number }[] = [];
    const globalTop: { idx: number; score: number }[] = [];
    const inTopicSlots = Math.max(1, K - ancestorSet.size - GLOBAL_K);
    for (const j of candidates) {
      if (ancestorSet.has(j)) continue;
      let sc = 0;
      const aOff = j * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
      if (top.length < inTopicSlots) {
        top.push({ idx: j, score: sc });
        if (top.length === inTopicSlots) top.sort((a, b) => a.score - b.score);
      } else if (sc > top[0].score) {
        top[0] = { idx: j, score: sc };
        top.sort((a, b) => a.score - b.score);
      }
    }
    top.sort((a, b) => b.score - a.score);

    // A3: add GLOBAL_K globally-closest lower-diff skills. Scoped to cross-topic-token pool
    // to stay sub-quadratic — skills whose topic slugs share tokens with our skill's topic slugs.
    const picked = new Set<number>([...ancestorSet, ...top.map((t) => t.idx), i]);
    if (GLOBAL_K > 0 && topics.length > 0) {
      // Build cross-topic pool: skills in topics sharing a significant token with our topics
      const myTopicToks = new Set<string>();
      for (const t of topics) for (const tok of t.split("-")) if (tok.length >= 5) myTopicToks.add(tok);
      const crossPool = new Set<number>();
      for (const [otherTopic, otherIdxs] of topicIdx) {
        let shared = false;
        for (const tok of otherTopic.split("-")) if (tok.length >= 5 && myTopicToks.has(tok)) { shared = true; break; }
        if (!shared) continue;
        for (const j of otherIdxs) crossPool.add(j);
      }
      for (const j of crossPool) {
        if (picked.has(j)) continue;
        if (raw[j] + MIN_DIFF > raw[i]) continue;
        let sc = 0;
        const aOff = j * DIM;
        for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
        if (globalTop.length < GLOBAL_K) {
          globalTop.push({ idx: j, score: sc });
          if (globalTop.length === GLOBAL_K) globalTop.sort((a, b) => a.score - b.score);
        } else if (sc > globalTop[0].score) {
          globalTop[0] = { idx: j, score: sc };
          globalTop.sort((a, b) => a.score - b.score);
        }
      }
      globalTop.sort((a, b) => b.score - a.score);
    }

    const idxs = [...ancestorSet, ...top.map((t) => t.idx), ...globalTop.map((t) => t.idx)].slice(0, K);
    out.set(skills[i].id, idxs);
    outLines.push(`${skills[i].id}\t${idxs.join(",")}`);
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(`  candidates ${i + 1}/${skills.length} (${((i + 1) / el).toFixed(0)}/s)`);
    }
  }
  Deno.writeTextFileSync(PREREQ_CANDIDATES_CACHE, outLines.join("\n") + "\n");
  return out;
}

function formatPrereqPrompt(s: { title: string; description: string }, candTitles: string[]): string {
  const desc = s.description ? `\nDescription: ${s.description.slice(0, 200)}` : "";
  const cands = candTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Skill: ${s.title}${desc}\n\nCandidates:\n${cands}\n\nPrerequisite numbers (or "none"):`;
}

function parsePrereqResponse(text: string, numCandidates: number): number[] {
  const t = text.trim().toLowerCase();
  if (t === "none" || t === "" || t === "n/a") return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of t.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n >= 1 && n <= numCandidates && !seen.has(n)) {
      seen.add(n);
      out.push(n - 1); // convert to 0-based
    }
  }
  return out.slice(0, 5); // cap at 5 prereqs per skill
}

function loadPrereqCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(PREREQ_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      m.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return m;
  } catch { return new Map(); }
}

async function submitPrereqBatch(batch: { id: string; title: string; description: string; candTitles: string[] }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(batch.map(async (b, i) => {
    const cid = await shortId(b.id, i);
    idMap[cid] = b.id;
    return {
      custom_id: cid,
      params: {
        model: PREREQ_MODEL,
        max_tokens: 40,
        system: [{ type: "text", text: PREREQ_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: formatPrereqPrompt(b, b.candTitles) }],
      },
    };
  }));
  const body = JSON.stringify({ requests });
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
        method: "POST",
        headers: ANTHROPIC_HEADERS,
        body,
      });
      if (res.ok) {
        const j = await res.json();
        return { batchId: j.id, idMap };
      }
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(60 * attempt, 300);
        console.warn(`  [submit retry ${attempt}/8] ${res.status}: ${txt.slice(0, 150)} — sleeping ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new Error(`prereq batch submit ${res.status}: ${txt}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/prereq batch submit [1-4]\d\d/.test(msg)) throw err; // non-5xx from above
      const delay = Math.min(30 * attempt, 300);
      console.warn(`  [submit retry ${attempt}/8] network err: ${msg} — sleeping ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  throw new Error("prereq batch submit: exhausted retries");
}

async function stage5Prereq() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const { skills } = parseSkillsWithDifficulty();

  // Step 1: build or load candidates
  let candidates = loadPrereqCandidates();
  if (candidates.size !== skills.length) {
    console.log(`[stage 5] computing candidates for ${skills.length} skills…`);
    candidates = computePrereqCandidates();
  } else {
    console.log(`[stage 5] loaded ${candidates.size} cached candidate lists`);
  }

  // also track candidate ids already in any in-flight batch (prevents double-submission after download)
  const inFlightIds = new Set<string>();
  {
    try {
      const s: { batches: { id: string; idMap: Record<string, string> }[] } = JSON.parse(Deno.readTextFileSync(PREREQ_BATCH_STATE));
      for (const b of s.batches) for (const v of Object.values(b.idMap)) inFlightIds.add(v);
    } catch { /* none */ }
  }

  const buildTodo = () => {
    const cache = loadPrereqCache();
    const out: { id: string; title: string; description: string; candTitles: string[] }[] = [];
    for (const s of skills) {
      if (cache.has(s.id)) continue;
      if (inFlightIds.has(s.id)) continue;
      const cands = candidates.get(s.id);
      if (!cands || cands.length === 0) continue;
      out.push({
        id: s.id,
        title: s.title,
        description: s.description,
        candTitles: cands.map((j) => skills[j].title),
      });
    }
    return out;
  };
  let todo = buildTodo();
  console.log(`[stage 5] targets: ${skills.length}, in-flight: ${inFlightIds.size}, to submit: ${todo.length}`);

  // Step 2: resume existing batch(es) if any
  let state: { batches: { id: string; idMap: Record<string, string> }[] } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(PREREQ_BATCH_STATE)); } catch { /* none */ }

  if (state) {
    console.log(`[stage 5] resuming ${state.batches.length} batch(es)`);
    const skillOrder = skills.map((s) => s.id);
    const remaining: typeof state.batches = [];
    for (const b of state.batches) {
      const p = await pollBatch(b.id);
      console.log(`  batch ${b.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("no results_url");
        const res = await fetch(p.resultsUrl, { headers: ANTHROPIC_HEADERS });
        if (!res.ok) throw new Error(`results ${res.status}`);
        const text = await res.text();
        const fh = Deno.openSync(PREREQ_CACHE, { create: true, append: true });
        const enc = new TextEncoder();
        let ok = 0, err = 0;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const j = JSON.parse(line);
          const skillId = b.idMap[j.custom_id];
          if (!skillId) continue;
          if (j.result?.type !== "succeeded") { err++; continue; }
          const raw = (j.result.message.content?.[0]?.text ?? "").replace(/[\t\n\r]/g, " ");
          // Resolve positional indexes to prereq ids so responses survive skill-array reorders (e.g. from dedupe)
          const cands = candidates.get(skillId) ?? [];
          const picks = parsePrereqResponse(raw, cands.length);
          const resolved = picks.map((p) => skillOrder[cands[p]]).filter((x) => x).join(",");
          fh.writeSync(enc.encode(`${skillId}\t${resolved}\n`));
          ok++;
        }
        fh.close();
        console.log(`  wrote ${ok} successful, ${err} errored`);
      } else {
        remaining.push(b);
      }
    }
    // Any batch that ended has had its responses downloaded — rebuild todo so we don't resubmit them.
    todo = buildTodo();
    if (remaining.length === 0) {
      try { Deno.removeSync(PREREQ_BATCH_STATE); } catch { /* ignore */ }
      console.log(`[stage 5] all batches complete`);
      state = { batches: [] };
    } else {
      Deno.writeTextFileSync(PREREQ_BATCH_STATE, JSON.stringify({ batches: remaining }));
      console.log(`[stage 5] ${remaining.length} batch(es) still processing — will top up to parallel cap`);
      state = { batches: remaining };
    }
  }

  if (todo.length === 0) {
    // Write final prereqs.tsv edge list
    const cacheFinal = loadPrereqCache();
    console.log(`[stage 5] writing edges from ${cacheFinal.size} responses`);
    const skillIds = new Set(skills.map((s) => s.id));
    const edgeFh = Deno.openSync(`${BUILD}/5_edges.tsv`, { create: true, write: true, truncate: true });
    const enc = new TextEncoder();
    edgeFh.writeSync(enc.encode("skill_id\tprereq_id\n"));
    let edges = 0, orphans = 0;
    for (const s of skills) {
      const resp = cacheFinal.get(s.id);
      if (!resp || resp === "none") { orphans++; continue; }
      // Detect format: resolved-ids (contain hyphens/letters) vs legacy positional
      const isResolved = /[a-z]|-/.test(resp);
      if (isResolved) {
        let n = 0;
        for (const pid of resp.split(",")) {
          if (!pid || !skillIds.has(pid)) continue;
          edgeFh.writeSync(enc.encode(`${s.id}\t${pid}\n`));
          edges++; n++;
        }
        if (n === 0) orphans++;
      } else {
        const cands = candidates.get(s.id) ?? [];
        if (!cands.length) { orphans++; continue; }
        const picks = parsePrereqResponse(resp, cands.length);
        if (picks.length === 0) { orphans++; continue; }
        for (const p of picks) {
          const prereq = skills[cands[p]];
          if (prereq) { edgeFh.writeSync(enc.encode(`${s.id}\t${prereq.id}\n`)); edges++; }
        }
      }
    }
    edgeFh.close();
    writeStats(5, {
      skills: skills.length,
      responses: cacheFinal.size,
      edges,
      orphans,
      orphan_rate: orphans / skills.length,
    });
    return;
  }

  // Step 3: submit multiple batches to fill the processing pipeline
  const CHUNK = Number(Deno.env.get("PREREQ_CHUNK") ?? "20000");
  const PARALLEL_BATCHES = Number(Deno.env.get("PREREQ_PARALLEL") ?? "3");
  const inFlight = state?.batches ?? [];
  const slots = Math.max(0, PARALLEL_BATCHES - inFlight.length);
  const batches = [...inFlight];
  let off = 0;
  for (let n = 0; n < slots && off < todo.length; n++) {
    const chunk = todo.slice(off, off + CHUNK);
    if (Deno.env.get("PREREQ_LIMIT")) {
      chunk.length = Math.min(chunk.length, Number(Deno.env.get("PREREQ_LIMIT")));
    }
    const b = await submitPrereqBatch(chunk);
    batches.push({ id: b.batchId, idMap: b.idMap });
    console.log(`[stage 5] batch ${b.batchId}: ${chunk.length} requests submitted`);
    Deno.writeTextFileSync(PREREQ_BATCH_STATE, JSON.stringify({ batches })); // save after each
    off += chunk.length;
  }
  console.log(`[stage 5] ${batches.length} batch(es), ${off}/${todo.length} queued. Re-run to poll + submit next.`);
}

// ---------- stage 6: post-process prereqs ----------

// Apfel (Apple Foundation Model) via OpenAI-compat HTTP. Start with: apfel --serve --port 11435
async function stage5ApfelPrereq() {
  const { skills } = parseSkillsWithDifficulty();
  let candidates = loadPrereqCandidates();
  if (candidates.size !== skills.length) candidates = computePrereqCandidates();
  // Separate cache file for Apfel so Haiku cache stays intact (env: APFEL_OUT)
  const APFEL_OUT = Deno.env.get("APFEL_OUT") ?? PREREQ_CACHE;
  const localCache = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(APFEL_OUT).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      localCache.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch { /* fresh */ }
  const skillOrder = skills.map((s) => s.id);
  const todo: { s: typeof skills[0]; candTitles: string[]; candIdxs: number[] }[] = [];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    if (localCache.has(s.id)) continue;
    const cands = candidates.get(s.id);
    if (!cands || cands.length === 0) continue;
    todo.push({ s, candTitles: cands.map((j) => skills[j].title), candIdxs: cands });
  }
  console.log(`[stage 5-apfel] out=${APFEL_OUT}, targets: ${skills.length}, cached: ${localCache.size}, to run: ${todo.length}`);
  if (!todo.length) return;

  const ENDPOINT = Deno.env.get("APFEL_ENDPOINT") ?? "http://127.0.0.1:11435/v1/chat/completions";
  const CONCURRENCY = Number(Deno.env.get("APFEL_CONCURRENCY") ?? "4"); // lower default — Apfel drops under heavy load
  const LIMIT = Deno.env.get("APFEL_LIMIT") ? Number(Deno.env.get("APFEL_LIMIT")) : todo.length;
  const queue = todo.slice(0, LIMIT);
  console.log(`[stage 5-apfel] endpoint=${ENDPOINT} concurrency=${CONCURRENCY} queued=${queue.length}`);

  const fh = Deno.openSync(APFEL_OUT, { create: true, append: true });
  const enc = new TextEncoder();
  const t0 = performance.now();
  let done = 0, errs = 0, retries = 0;

  async function callApfel(prompt: string, maxRetries = 3): Promise<string> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "apple-foundationmodel",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0,
            max_tokens: 40,
          }),
        });
        if (!res.ok) throw new Error(`apfel ${res.status}`);
        const j = await res.json();
        return (j.choices?.[0]?.message?.content ?? "").replace(/[\t\n\r]/g, " ");
      } catch (e) {
        lastErr = e as Error;
        if (attempt < maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastErr ?? new Error("apfel failed");
  }

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const desc = item.s.description ? `\nDescription: ${item.s.description.slice(0, 150)}` : "";
      const cands = item.candTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const prompt = `I list candidate prerequisites. Pick only the TRUE prerequisites that MUST be learned first for the skill. Most of the time NONE of the candidates are prerequisites — be strict. Output format: comma-separated numbers like "1,3" or exactly the word none. NO other text.\n\nSkill: ${item.s.title}${desc}\n\nCandidates:\n${cands}\n\nOutput:`;
      try {
        const raw = await callApfel(prompt);
        const picks = parsePrereqResponse(raw, item.candTitles.length);
        const resolved = picks.map((p) => skillOrder[item.candIdxs[p]]).filter((x) => x).join(",");
        fh.writeSync(enc.encode(`${item.s.id}\t${resolved}\n`));
      } catch (e) {
        errs++;
        if (errs < 5) console.warn(`[stage 5-apfel] err ${item.s.id}: ${(e as Error).message.slice(0, 100)}`);
      }
      done++;
      if (done % 200 === 0) {
        const dt = (performance.now() - t0) / 1000;
        const rate = done / dt;
        console.log(`  ${done}/${LIMIT} (${rate.toFixed(1)}/s, ETA ${((queue.length) / rate / 60).toFixed(1)}min, errs=${errs}, retries=${retries})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  fh.close();
  const dt = (performance.now() - t0) / 1000;
  console.log(`[stage 5-apfel] done: ${done} in ${dt.toFixed(0)}s, errs=${errs}, retries=${retries}`);
  writeStats(52, { processed: done, errors: errs, retries, endpoint: ENDPOINT, total_seconds: dt });
}

// Generic Apfel one-shot helper: apply `prompt(target)` to each pending target,
// append `id\tresponse` to `outPath`. Resume-friendly: skips ids already in cache.
async function apfelBatch<T extends { id: string }>(
  label: string,
  outPath: string,
  targets: T[],
  prompt: (t: T) => string,
  maxTokens = 60,
): Promise<void> {
  const cache = new Set<string>();
  try {
    for (const line of Deno.readTextFileSync(outPath).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      cache.add(line.slice(0, tab));
    }
  } catch { /* fresh */ }
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[${label}] out=${outPath}, targets=${targets.length}, cached=${cache.size}, to run=${todo.length}`);
  if (!todo.length) return;

  const ENDPOINT = Deno.env.get("APFEL_ENDPOINT") ?? "http://127.0.0.1:11435/v1/chat/completions";
  const CONCURRENCY = Number(Deno.env.get("APFEL_CONCURRENCY") ?? "4");
  const LIMIT = Deno.env.get("APFEL_LIMIT") ? Number(Deno.env.get("APFEL_LIMIT")) : todo.length;
  const queue = todo.slice(0, LIMIT);
  console.log(`[${label}] endpoint=${ENDPOINT} concurrency=${CONCURRENCY} queued=${queue.length}`);

  const fh = Deno.openSync(outPath, { create: true, append: true });
  const enc = new TextEncoder();
  const t0 = performance.now();
  let done = 0, errs = 0, retries = 0;

  async function call(p: string): Promise<string> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "apple-foundationmodel",
            messages: [{ role: "user", content: p }],
            temperature: 0.0,
            max_tokens: maxTokens,
          }),
        });
        if (!res.ok) throw new Error(`apfel ${res.status}`);
        const j = await res.json();
        return (j.choices?.[0]?.message?.content ?? "").replace(/[\t\n\r]/g, " ").trim();
      } catch (e) {
        lastErr = e as Error;
        if (attempt < 3) { retries++; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
      }
    }
    throw lastErr ?? new Error("apfel failed");
  }

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      try {
        const raw = await call(prompt(item));
        if (/^skip$/i.test(raw.trim())) { done++; continue; }
        const cleaned = cleanDef(raw); // refusal-pattern + length safety; empty → skip caching
        if (cleaned) {
          fh.writeSync(enc.encode(`${item.id}\t${cleaned}\n`));
        }
      } catch (e) {
        errs++;
        if (errs < 5) console.warn(`[${label}] err ${item.id}: ${(e as Error).message.slice(0, 100)}`);
      }
      done++;
      if (done % 200 === 0) {
        const dt = (performance.now() - t0) / 1000;
        const rate = done / dt;
        console.log(`  ${done}/${LIMIT} (${rate.toFixed(1)}/s, ETA ${(queue.length / rate / 60).toFixed(1)}min, errs=${errs}, retries=${retries})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  fh.close();
  const dt = (performance.now() - t0) / 1000;
  console.log(`[${label}] done: ${done} in ${dt.toFixed(0)}s, errs=${errs}, retries=${retries}`);
}

// Stage 1c via Apfel: extract concise skill name from long titles. Writes to 1c_summarize.tsv
// (same cache file as the Haiku batch stage), so subsequent stage-1 runs apply the summaries.
async function stage1cApfelSummarize() {
  const MAX_LEN = Number(Deno.env.get("SUMMARIZE_MAX_LEN") ?? "80");
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[1].length > MAX_LEN) targets.push({ id: c[0], title: c[1] });
  }
  await apfelBatch(
    "stage 1c-apfel",
    SUMMARIZE_CACHE,
    targets,
    (t) => `Extract a concise 2-6 word skill name (verb phrase preferred). Output only the name — no preamble, no quotes, no trailing period.\n\nStandard: ${t.title}\n\nSkill name:`,
    40,
  );
}

// Stage 1b via Apfel: define Lightcast skills lacking descriptions. Writes to 1b_apfel_infill.tsv
// by default (separate from Haiku cache); can be merged into 1b_infill.tsv before stage 1.
async function stage1bApfelInfill() {
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  let opaqueSkipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (!c[3].includes("lightcast")) continue;
    // Target items with empty desc OR placeholder desc (type name / category fallback)
    if (c[2] && !c[4]?.includes("desc:placeholder")) continue;
    const title = c[1];
    if (title.length <= 3 && !SHORT_TECH_WHITELIST.has(title.toLowerCase())) { opaqueSkipped++; continue; }
    targets.push({ id: c[0], title });
  }
  console.log(`[stage 1b-apfel] opaque_skipped=${opaqueSkipped}`);
  const out = Deno.env.get("APFEL_INFILL_OUT") ?? `${BUILD}/1b_apfel_infill.tsv`;
  await apfelBatch(
    "stage 1b-apfel",
    out,
    targets,
    (t) => `Define this workplace skill in exactly one concise sentence. Be concrete and factual. Output only the definition — no preamble, no "refers to", no quotation marks. Never repeat the skill name verbatim at the start. If you do not have a clear definition, output the single word: SKIP\n\nSkill: ${t.title}\n\nDefinition:`,
    120,
  );
}

// Infill ALL skills with empty descriptions (any source).
async function stage1bApfelInfillAll() {
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[2]) continue; // has description
    const title = c[1];
    if (title.length <= 3 && !SHORT_TECH_WHITELIST.has(title.toLowerCase())) continue;
    targets.push({ id: c[0], title });
  }
  const out = Deno.env.get("APFEL_INFILL_OUT") ?? `${BUILD}/1b_apfel_infill.tsv`;
  await apfelBatch(
    "stage 1b-apfel-all",
    out,
    targets,
    (t) => `Define this skill or standard in exactly one concise sentence. Be concrete and factual. Output only the definition — no preamble, no "refers to", no quotation marks. Never repeat the skill name verbatim at the start. If you do not have a clear definition, output the single word: SKIP\n\nSkill: ${t.title}\n\nDefinition:`,
    120,
  );
}

async function stage5OllamaPrereq() {
  const { skills } = parseSkillsWithDifficulty();
  let candidates = loadPrereqCandidates();
  if (candidates.size !== skills.length) {
    console.log(`[stage 5-ollama] computing candidates for ${skills.length} skills…`);
    candidates = computePrereqCandidates();
  } else {
    console.log(`[stage 5-ollama] loaded ${candidates.size} cached candidate lists`);
  }
  // OLLAMA_OUT env: separate cache path (mirror APFEL_OUT). Resume-compatible: skills already
  // in OLLAMA_OUT are skipped. Useful for continuing a crashed/partial Apfel run.
  const OLLAMA_OUT = Deno.env.get("OLLAMA_OUT") ?? PREREQ_CACHE;
  const localCache = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(OLLAMA_OUT).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      localCache.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch { /* fresh */ }
  const skillOrder = skills.map((s) => s.id);
  const todo: { idx: number; s: typeof skills[0]; candTitles: string[]; candIdxs: number[] }[] = [];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    if (localCache.has(s.id)) continue;
    const cands = candidates.get(s.id);
    if (!cands || cands.length === 0) continue;
    todo.push({ idx: i, s, candTitles: cands.map((j) => skills[j].title), candIdxs: cands });
  }
  console.log(`[stage 5-ollama] out=${OLLAMA_OUT}, targets: ${skills.length}, cached: ${localCache.size}, to run: ${todo.length}`);
  if (!todo.length) { console.log("[stage 5-ollama] nothing to do"); return; }

  const MODEL = Deno.env.get("OLLAMA_PREREQ_MODEL") ?? "gpt-oss:20b";
  const CONCURRENCY = Number(Deno.env.get("OLLAMA_CONCURRENCY") ?? "4");
  const LIMIT = Deno.env.get("OLLAMA_LIMIT") ? Number(Deno.env.get("OLLAMA_LIMIT")) : todo.length;
  const queue = todo.slice(0, LIMIT);
  console.log(`[stage 5-ollama] model=${MODEL} concurrency=${CONCURRENCY} queued=${queue.length}`);

  const fh = Deno.openSync(OLLAMA_OUT, { create: true, append: true });
  const enc = new TextEncoder();
  const t0 = performance.now();
  let done = 0, errs = 0;
  const callOllama = async (prompt: string): Promise<string> => {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 600 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return (j.response || "").replace(/[\t\n\r]/g, " ");
  };
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const prompt = PREREQ_SYSTEM + "\n\n" + formatPrereqPrompt(item.s, item.candTitles);
      try {
        const raw = await callOllama(prompt);
        const picks = parsePrereqResponse(raw, item.candTitles.length);
        const resolved = picks.map((p) => skillOrder[item.candIdxs[p]]).filter((x) => x).join(",");
        fh.writeSync(enc.encode(`${item.s.id}\t${resolved}\n`));
      } catch (e) {
        errs++;
        if (errs < 5) console.warn(`[stage 5-ollama] err ${item.s.id}: ${(e as Error).message.slice(0, 100)}`);
      }
      done++;
      if (done % 100 === 0) {
        const dt = (performance.now() - t0) / 1000;
        const rate = done / dt;
        const eta = (queue.length) / rate;
        console.log(`  ${done}/${LIMIT} (${rate.toFixed(1)}/s, ETA ${(eta / 60).toFixed(1)}min, errs=${errs})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  fh.close();
  const dt = (performance.now() - t0) / 1000;
  console.log(`[stage 5-ollama] done: ${done} processed in ${dt.toFixed(0)}s, errs=${errs}`);
  writeStats(51, { processed: done, errors: errs, model: MODEL, total_seconds: dt });
}

function stage6PostProc() {
  const tagLines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = tagLines[0].split("\t");
  const iTitle = hdr.indexOf("title");
  const iTags = hdr.indexOf("tags");
  const iTopics = hdr.indexOf("topics");
  const order: string[] = tagLines.slice(1).map((l) => l.split("\t")[0]);
  const skill = new Map<string, { title: string; tags: string; topics: Set<string> }>();
  for (let i = 1; i < tagLines.length; i++) {
    const c = tagLines[i].split("\t");
    skill.set(c[0], {
      title: c[iTitle],
      tags: c[iTags],
      topics: new Set(c[iTopics].split(",").filter((t) => t)),
    });
  }
  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const rawDiff = new Map<string, number>();
  for (let i = 1; i < diffLines.length; i++) {
    const c = diffLines[i].split("\t");
    rawDiff.set(c[0], Number(c[2]));
  }
  const candLines = Deno.readTextFileSync(`${BUILD}/5_candidates.tsv`).split("\n").filter((l) => l.length);
  const candidates = new Map<string, number[]>();
  for (const line of candLines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    candidates.set(id, rest ? rest.split(",").map(Number) : []);
  }

  // Dedupe prereqs cache (file may have retry duplicates — keep last value per id)
  const prereqLines = Deno.readTextFileSync(`${BUILD}/5_prereqs.tsv`).split("\n").filter((l) => l.length);
  const pick = new Map<string, string>();
  for (const line of prereqLines) {
    const tab = line.indexOf("\t");
    pick.set(line.slice(0, tab), line.slice(tab + 1));
  }

  // Build raw edge list. Detect format: resolved-ids (contains hyphens) vs legacy positional (digits only).
  let raw: [string, string][] = [];
  for (const [id, resp] of pick) {
    if (!resp || resp === "none") continue;
    const isResolved = /-/.test(resp) || /[a-z]/.test(resp);
    if (isResolved) {
      for (const pid of resp.split(",")) if (pid) raw.push([id, pid]);
    } else {
      const cands = candidates.get(id) ?? [];
      const picks = parsePrereqResponse(resp, cands.length);
      for (const p of picks) {
        const prereqId = order[cands[p]];
        if (prereqId) raw.push([id, prereqId]);
      }
    }
  }
  // Apply dedupe alias if exists
  try {
    const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    const alias = new Map<string, string>();
    for (let i = 1; i < aliasLines.length; i++) {
      const [d, c] = aliasLines[i].split("\t");
      alias.set(d, c);
    }
    raw = raw.map(([s, p]) => [alias.get(s) ?? s, alias.get(p) ?? p] as [string, string])
      .filter(([s, p]) => s !== p);
    console.log(`[stage 6] applied ${alias.size} aliases`);
  } catch { /* no dedupe */ }
  // Drop edges referencing skills not in the tagged-deduped skill set
  const beforeOrphanFilter = raw.length;
  raw = raw.filter(([s, p]) => skill.has(s) && skill.has(p));
  if (beforeOrphanFilter - raw.length > 0) console.log(`[stage 6] dropped ${beforeOrphanFilter - raw.length} edges referencing unknown skill ids`);
  const beforeTotal = raw.length;
  console.log(`[stage 6] raw edges: ${beforeTotal}`);

  // Load seed-edge keys early so downstream filters can exempt them (A1).
  // seed edges are expert-labeled ground truth — shouldn't be dropped by heuristics.
  const seedEdgeKeys = new Set<string>();
  let seedLoaded = 0;
  try {
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
    let alias = new Map<string, string>();
    try {
      const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
      for (let i = 1; i < aliasLines.length; i++) {
        const [d, c] = aliasLines[i].split("\t");
        alias.set(d, c);
      }
    } catch { /* no aliases */ }
    for (const line of seedLines) {
      const c = line.split("\t");
      if (c[4] === "1") continue; // holdout
      const src = alias.get(c[0]) ?? c[0];
      const dst = alias.get(c[1]) ?? c[1];
      seedEdgeKeys.add(`${dst}\t${src}`); // edge schema: skill \t prereq
      seedLoaded++;
    }
  } catch { /* none */ }
  const isSeed = (s: string, p: string): boolean => seedEdgeKeys.has(`${s}\t${p}`);
  console.log(`[stage 6] loaded ${seedLoaded} seed-edge keys for exemption`);

  // --- Filter 0: drop band-inverted edges (prereq.band > skill.band) ---
  // These occur when the non-OpenSALT +3 bonus crosses a grade-anchor boundary.
  // Raw-diff ordering was preserved in stage 5, but band-level ordering can invert.
  // Seed edges exempt (A1) — expert labels trump inferred bands.
  const diffLines2 = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const band = new Map<string, number>();
  for (let i = 1; i < diffLines2.length; i++) {
    const c = diffLines2[i].split("\t");
    band.set(c[0], Number(c[1]));
  }
  const beforeBandFilter = raw.length;
  let bandSeedExempt = 0;
  raw = raw.filter(([s, p]) => {
    if ((band.get(p) ?? 0) <= (band.get(s) ?? 20)) return true;
    if (isSeed(s, p)) { bandSeedExempt++; return true; }
    return false;
  });
  console.log(`[stage 6] dropped ${beforeBandFilter - raw.length} band-inverted edges (${bandSeedExempt} seed exempt)`);

  // --- Filter 0b: hypernym/subset filter (P2) ---
  // If the prereq's significant slug tokens are a strict subset of the child's, the "prereq"
  // is almost always a hypernym or sibling-label, not a genuine foundation:
  //   manage-staff  ⊂  manage-musical-staff  → hypernym, not a prereq.
  //   supervise-work  ⊂  supervise-correctional-procedures → hypernym.
  // Seeds are exempt. Single-token prereqs (e.g. "algebra") are exempt — they're often real foundations.
  const HYPERNYM_STOP = new Set(["a","an","the","of","to","for","in","on","at","by","with","and","or","from","as","is","are","be","that","this","these","those","their","its"]);
  const sigSlugToks = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) if (w.length >= 3 && !HYPERNYM_STOP.has(w)) out.add(w);
    return out;
  };
  const beforeHypernym = raw.length;
  let hypernymSeedExempt = 0;
  raw = raw.filter(([s, p]) => {
    if (isSeed(s, p)) { hypernymSeedExempt++; return true; }
    const pToks = sigSlugToks(p);
    if (pToks.size < 2) return true; // single-token prereqs (math, algebra, physics) are real foundations
    const sToks = sigSlugToks(s);
    if (sToks.size === 0) return true;
    // strict subset: all prereq tokens appear in child tokens, and child has ≥1 extra
    for (const t of pToks) if (!sToks.has(t)) return true;
    return sToks.size <= pToks.size; // not strict subset
  });
  console.log(`[stage 6] hypernym filter: dropped ${beforeHypernym - raw.length} edges (${hypernymSeedExempt} seed exempt)`);

  // --- Filter 1: tighten onet:tech prereqs ---
  // Specific software products (onet:tech) are rarely true prereqs:
  //   - onet:tech → onet:tech: DROP. Sibling products don't depend on each other.
  //   - non-tech → onet:tech: KEEP only if product slug appears in skill's topics.
  const bySkill = new Map<string, string[]>();
  for (const [s, p] of raw) { const arr = bySkill.get(s) ?? []; arr.push(p); bySkill.set(s, arr); }
  let droppedTech = 0, techSeedExempt = 0;
  const filtered: [string, string][] = [];
  for (const [s, prereqs] of bySkill) {
    const ssk = skill.get(s);
    const sIsTech = ssk?.tags.includes("onet:tech") ?? false;
    const sRaw = rawDiff.get(s) ?? 0;
    const kept = prereqs.filter((p) => {
      if (isSeed(s, p)) { techSeedExempt++; return true; } // A1 seed exemption
      const psk = skill.get(p);
      if (!psk) return true;
      const pIsTech = psk.tags.includes("onet:tech");
      if (!pIsTech) return true;
      if (sIsTech) {
        const pRaw = rawDiff.get(p) ?? 0;
        return sRaw - pRaw >= 2.0;
      }
      if (ssk?.topics.has(p)) return true;
      return false;
    });
    // Fallback: if filter emptied all prereqs AND skill is non-tech, keep first non-tech prereq
    // (tech skills that lose all prereqs are allowed to orphan — sibling products don't belong in DAG)
    let final = kept;
    if (final.length === 0 && !sIsTech && prereqs.length > 0) {
      const firstNonTech = prereqs.find((p) => !(skill.get(p)?.tags.includes("onet:tech") ?? false));
      if (firstNonTech) final = [firstNonTech];
    }
    droppedTech += prereqs.length - final.length;
    for (const p of final) filtered.push([s, p]);
  }
  raw = filtered;
  console.log(`[stage 6] dropped ${droppedTech} onet:tech edges`);

  // --- Filter 2: per-topic hub cap (A5) ---
  // Replaces prior global HUB_CAP=80. A genuine foundational prereq (Chemistry, Physics)
  // legitimately fans out across many topics — don't truncate. But within a single child
  // topic, >20 downstream edges is almost always within-topic spam.
  // Global safety cap still applies for tech products (sibling-product runaway).
  const PER_TOPIC_CAP = Number(Deno.env.get("PER_TOPIC_CAP") ?? "30");
  const GLOBAL_CAP = Number(Deno.env.get("HUB_CAP") ?? "150");
  const TECH_HUB_CAP = Number(Deno.env.get("TECH_HUB_CAP") ?? "15");
  const downstreamOfPrereq = new Map<string, [string, string][]>();
  for (const e of raw) {
    const arr = downstreamOfPrereq.get(e[1]) ?? []; arr.push(e); downstreamOfPrereq.set(e[1], arr);
  }
  let droppedHub = 0, droppedPerTopic = 0, hubSeedExempt = 0;
  const keep = new Set<string>();
  for (const [prereqId, edges] of downstreamOfPrereq) {
    const pIsTech = skill.get(prereqId)?.tags.includes("onet:tech") ?? false;
    const pRaw = rawDiff.get(prereqId) ?? 0;
    // Sort by raw-diff proximity once — preserves closest-level children when capping
    edges.sort((a, b) => Math.abs((rawDiff.get(a[0]) ?? 0) - pRaw) - Math.abs((rawDiff.get(b[0]) ?? 0) - pRaw));

    if (pIsTech) {
      // Tech products: strict global cap, no per-topic refinement
      const cap = TECH_HUB_CAP;
      for (let i = 0; i < edges.length; i++) {
        const [s, p] = edges[i];
        if (isSeed(s, p)) { keep.add(s + "\t" + p); hubSeedExempt++; continue; }
        if (i < cap) keep.add(s + "\t" + p);
        else droppedHub++;
      }
      continue;
    }

    // Per-topic cap: tally how many kept per child's topics (check all, not just first)
    const perTopicCount = new Map<string, number>();
    let globalKept = 0;
    for (const [s, p] of edges) {
      if (isSeed(s, p)) { keep.add(s + "\t" + p); hubSeedExempt++; globalKept++; continue; }
      const childTopics = skill.get(s)?.topics;
      const topics = childTopics && childTopics.size ? [...childTopics] : ["_notopic"];
      // Edge is capped if ANY of the child's topics has hit the cap
      if (topics.some((t) => (perTopicCount.get(t) ?? 0) >= PER_TOPIC_CAP)) { droppedPerTopic++; continue; }
      if (globalKept >= GLOBAL_CAP) { droppedHub++; continue; }
      keep.add(s + "\t" + p);
      for (const t of topics) perTopicCount.set(t, (perTopicCount.get(t) ?? 0) + 1);
      globalKept++;
    }
  }
  console.log(`[stage 6] hub caps: dropped ${droppedPerTopic} per-topic (cap=${PER_TOPIC_CAP}), ${droppedHub} global/tech (non-tech=${GLOBAL_CAP}, tech=${TECH_HUB_CAP}); ${hubSeedExempt} seed exempt`);

  const final: [string, string][] = raw.filter((e) => keep.has(e[0] + "\t" + e[1]));

  // --- Final: ensure every non-orphan skill keeps at least one prereq ---
  // (already preserved since we filter by edge, not by skill — but log skills that got all their edges removed)
  const skillsWithFinalPrereqs = new Set(final.map((e) => e[0]));
  const skillsWithRawPrereqs = new Set<string>();
  for (const [id, resp] of pick) {
    const cands = candidates.get(id) ?? [];
    if (parsePrereqResponse(resp, cands.length).length > 0) skillsWithRawPrereqs.add(id);
  }
  let lostAll = 0;
  for (const id of skillsWithRawPrereqs) if (!skillsWithFinalPrereqs.has(id)) lostAll++;

  // --- Heuristic orphan fix: for orphan skills, find foundational ancestors by topic-slug match ---
  const orphanSkills = new Set<string>();
  const hasEdge = new Set(final.map(([s]) => s));
  for (const id of skill.keys()) if (!hasEdge.has(id)) orphanSkills.add(id);

  // Load Wikidata P279 parent labels as extra topic signal for wiki-resolved orphans
  const idToParentSlugs = new Map<string, Set<string>>();
  try {
    const idToQid = new Map<string, string>();
    for (const line of Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`).split("\n")) {
      if (!line) continue;
      try { const d: { id: string; qid?: string } = JSON.parse(line); if (d.qid) idToQid.set(d.id, d.qid); } catch { /* skip */ }
    }
    const qidParents = new Map<string, string[]>();
    for (const line of Deno.readTextFileSync(`${BUILD}/1g_wd_parents.jsonl`).split("\n")) {
      if (!line) continue;
      try { const d: { qid: string; parents: string[] } = JSON.parse(line); qidParents.set(d.qid, d.parents); } catch { /* skip */ }
    }
    const qidLabel = new Map<string, string>();
    for (const line of Deno.readTextFileSync(`${BUILD}/1i_qid_labels.tsv`).split("\n")) {
      if (!line) continue;
      const [q, l] = line.split("\t");
      if (q && l) qidLabel.set(q, l);
    }
    for (const [id, qid] of idToQid) {
      const slugs = new Set<string>();
      for (const pQid of qidParents.get(qid) || []) {
        const l = qidLabel.get(pQid);
        if (l) for (const w of slugify(l).split("-")) if (w.length >= 4) slugs.add(w);
      }
      if (slugs.size) idToParentSlugs.set(id, slugs);
    }
    console.log(`[stage 6] loaded P279 parent slugs for ${idToParentSlugs.size} skills`);
  } catch { /* no wiki data */ }

  // Index skills by significant slug words
  const wordToSkills = new Map<string, string[]>();
  for (const [id] of skill) {
    for (const w of id.split("-")) {
      if (w.length >= 5) {
        const arr = wordToSkills.get(w) ?? []; arr.push(id); wordToSkills.set(w, arr);
      }
    }
  }

  // Identify words that are too common to be useful signal (like "system", "management", "software")
  const stopWords = new Set<string>();
  for (const [w, list] of wordToSkills) if (list.length > 300) stopWords.add(w);

  // Track how many downstream each heuristic prereq gets — cap to prevent new artificial hubs
  const heurUseCount = new Map<string, number>();
  const HEUR_CAP = 25;

  let orphanFixed = 0, orphanFixedViaWiki = 0;
  for (const orphanId of orphanSkills) {
    const ssk = skill.get(orphanId)!;
    const sRaw = rawDiff.get(orphanId) ?? 0;
    // Collect candidate-word pool: topic slug words + Wikidata parent slug words
    const candWords = new Set<string>();
    for (const topic of ssk.topics) for (const w of topic.split("-")) if (w.length >= 5) candWords.add(w);
    const parentSlugs = idToParentSlugs.get(orphanId);
    const hasWiki = parentSlugs && parentSlugs.size > 0;
    if (hasWiki) for (const w of parentSlugs) candWords.add(w);
    // Find candidate foundational skills whose SLUG EQUALS or STARTS WITH a significant word.
    const cands = new Map<string, number>();
    for (const w of candWords) {
      if (w.length < 5 || stopWords.has(w)) continue;
      const list = wordToSkills.get(w);
      if (!list) continue;
      for (const candId of list) {
        if (candId === orphanId) continue;
        if (!(candId === w || candId.startsWith(w + "-"))) continue; // must start with the word
        if (skill.get(candId)?.tags.includes("onet:tech")) continue;
        const cRaw = rawDiff.get(candId) ?? 0;
        if (sRaw - cRaw < 3) continue;
        const score = candId === w ? 100 : (candId.split("-").length <= 3 ? 10 : 1);
        cands.set(candId, Math.max(cands.get(candId) ?? 0, score));
      }
    }
    if (cands.size === 0) continue;
    // Sort by score, tiebreak by lowest cap usage, then lowest raw diff
    const ranked = [...cands.entries()].sort((a, b) =>
      b[1] - a[1]
      || (heurUseCount.get(a[0]) ?? 0) - (heurUseCount.get(b[0]) ?? 0)
      || (rawDiff.get(a[0]) ?? 0) - (rawDiff.get(b[0]) ?? 0));
    // Pick first candidate that hasn't been over-used AND scored ≥10 (starts-with match)
    for (const [candId, score] of ranked) {
      if (score < 10) break;
      const n = heurUseCount.get(candId) ?? 0;
      if (n >= HEUR_CAP) continue;
      final.push([orphanId, candId]);
      heurUseCount.set(candId, n + 1);
      orphanFixed++;
      if (idToParentSlugs.has(orphanId)) orphanFixedViaWiki++;
      break;
    }
  }
  console.log(`[stage 6] heuristic orphan fix: added edges for ${orphanFixed} of ${orphanSkills.size} orphans (of which ${orphanFixedViaWiki} via Wikidata parents)`);

  // --- Cross-domain edge filter (A6): fractional topic overlap + foundation whitelist ---
  // Drop edges where max(|A∩B|/|A|, |A∩B|/|B|) < MIN_OVERLAP and no slug-token overlap.
  // Exempt: seed edges; prereqs tagged as cross-domain foundations (math, reading, writing,
  // problem-solving, critical thinking — real universal prereqs).
  const FOUNDATION_SLUGS = new Set([
    "mathematics", "math", "arithmetic", "reading", "writing", "reading-comprehension",
    "written-expression", "active-listening", "speaking", "problem-solving",
    "critical-thinking", "complex-problem-solving", "deductive-reasoning", "inductive-reasoning",
    "active-learning", "learning-strategies",
  ]);
  const isFoundation = (id: string): boolean => {
    if (FOUNDATION_SLUGS.has(id)) return true;
    const tags = skill.get(id)?.tags || "";
    return tags.includes("onet:skill") && FOUNDATION_SLUGS.has(id);
  };
  // Threshold default 0 = strict zero-overlap trigger (original semantics). Raising it
  // (e.g. 0.15) dropped legitimate cross-topic prereqs (metacademy regressed). Keep strict.
  const MIN_OVERLAP = Number(Deno.env.get("MIN_TOPIC_OVERLAP") ?? "0.0001");
  const significantTokens = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) if (w.length >= 4 && !stopWords.has(w)) out.add(w);
    return out;
  };
  const outPerSkill = new Map<string, number>();
  for (const [s] of final) outPerSkill.set(s, (outPerSkill.get(s) ?? 0) + 1);
  const beforeCrossDomain = final.length;
  let droppedCrossDomain = 0, preservedLastEdge = 0, foundationExempt = 0;
  for (let i = final.length - 1; i >= 0; i--) {
    const [s, p] = final[i];
    if (isSeed(s, p)) continue;
    if (isFoundation(p)) { foundationExempt++; continue; }
    const srcTopics = skill.get(p)?.topics;
    const dstTopics = skill.get(s)?.topics;
    if (!srcTopics || !dstTopics) continue;
    if (srcTopics.size < 2 || dstTopics.size < 2) continue;
    let topicOverlap = 0;
    for (const t of srcTopics) if (dstTopics.has(t)) topicOverlap++;
    const frac = topicOverlap / Math.min(srcTopics.size, dstTopics.size);
    if (frac >= MIN_OVERLAP) continue;
    // Slug-token overlap fallback (keeps edges where labels share significant words)
    const srcTok = significantTokens(p);
    const dstTok = significantTokens(s);
    let tokOverlap = 0;
    for (const t of srcTok) if (dstTok.has(t)) tokOverlap++;
    if (tokOverlap > 0) continue;
    if ((outPerSkill.get(s) ?? 0) <= 1) { preservedLastEdge++; continue; }
    final.splice(i, 1);
    outPerSkill.set(s, (outPerSkill.get(s) ?? 0) - 1);
    droppedCrossDomain++;
  }
  console.log(`[stage 6] cross-domain filter (overlap<${MIN_OVERLAP}): dropped ${droppedCrossDomain} of ${beforeCrossDomain} (preserved ${preservedLastEdge} last-edge, ${foundationExempt} foundation-exempt)`);

  // --- Seed-edge ingestion from stage 1e (expert-labeled ground truth) ---
  // Expert labels beat inferred difficulty/band. We accept even when rawDiff disagrees
  // (logs as override); the cycle-breaker below handles any cycles this introduces.
  let seedAdded = 0, seedSkippedMissing = 0, seedSkippedDup = 0, seedHoldout = 0, seedDiffOverride = 0;
  try {
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length);
    const existingEdges = new Set(final.map(([s, p]) => `${s}\t${p}`));
    // Apply dedupe alias if present so seed endpoints match the canonical id
    let alias = new Map<string, string>();
    try {
      const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
      for (let i = 1; i < aliasLines.length; i++) {
        const [d, c] = aliasLines[i].split("\t");
        alias.set(d, c);
      }
    } catch { alias = new Map(); }
    for (let i = 1; i < seedLines.length; i++) {
      const c = seedLines[i].split("\t");
      const src = alias.get(c[0]) ?? c[0];
      const dst = alias.get(c[1]) ?? c[1];
      const holdout = c[4] === "1";
      if (holdout) { seedHoldout++; continue; }
      if (!skill.has(src) || !skill.has(dst)) { seedSkippedMissing++; continue; }
      if (src === dst) { seedSkippedDup++; continue; }
      const rs = rawDiff.get(src) ?? 0, rd = rawDiff.get(dst) ?? 0;
      const bs = band.get(src) ?? 0, bd = band.get(dst) ?? 0;
      if (rs >= rd || bs > bd) seedDiffOverride++;
      const key = `${dst}\t${src}`; // edge schema: skill_id \t prereq_id (dst has src as prereq)
      if (existingEdges.has(key)) { seedSkippedDup++; continue; }
      final.push([dst, src]);
      existingEdges.add(key);
      seedAdded++;
    }
  } catch { /* no seed edges */ }
  console.log(`[stage 6] seed edges: added=${seedAdded} skipped_missing=${seedSkippedMissing} dup=${seedSkippedDup} holdout=${seedHoldout} diff_override=${seedDiffOverride}`);

  // A4: bidirectional low-confidence filter. If LLM picked A as prereq of B AND B as prereq
  // of A, the direction is ambiguous. Keep only the direction consistent with raw difficulty
  // (higher-diff skill has lower-diff prereq). Seeds exempt.
  {
    // Reconstruct raw LLM picks (before any filter) from pick map
    const rawLlmPairs = new Set<string>();
    for (const [id, resp] of pick) {
      if (!resp || resp === "none") continue;
      if (/-/.test(resp) || /[a-z]/.test(resp)) {
        for (const pid of resp.split(",")) if (pid) rawLlmPairs.add(`${id}\t${pid}`);
      } else {
        const cands = candidates.get(id) ?? [];
        const picks = parsePrereqResponse(resp, cands.length);
        for (const p of picks) {
          const prereqId = order[cands[p]];
          if (prereqId) rawLlmPairs.add(`${id}\t${prereqId}`);
        }
      }
    }
    let dropped = 0, synonymDropped = 0;
    // Mark (unordered) bidirectional pairs whose slugs look synonymous → drop BOTH directions (P3).
    // Signal: slug-token Jaccard ≥ 0.5 OR one tokens ⊂ other — these are near-duplicate labels
    // that survived stage 3b dedupe (e.g. forestry ↔ forest-management).
    const synonymUnordered = new Set<string>();
    {
      const seenPairs = new Set<string>();
      for (const [s, p] of final) {
        if (isSeed(s, p)) continue;
        if (!rawLlmPairs.has(`${p}\t${s}`)) continue;
        const key = s < p ? `${s}\t${p}` : `${p}\t${s}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const a = sigSlugToks(s), b = sigSlugToks(p);
        if (a.size === 0 || b.size === 0) continue;
        let inter = 0;
        for (const t of a) if (b.has(t)) inter++;
        const jacc = inter / (a.size + b.size - inter);
        const aSubB = [...a].every((t) => b.has(t));
        const bSubA = [...b].every((t) => a.has(t));
        if (jacc >= 0.5 || aSubB || bSubA) synonymUnordered.add(key);
      }
    }
    for (let i = final.length - 1; i >= 0; i--) {
      const [s, p] = final[i];
      if (isSeed(s, p)) continue;
      const unordered = s < p ? `${s}\t${p}` : `${p}\t${s}`;
      if (synonymUnordered.has(unordered)) {
        final.splice(i, 1); synonymDropped++; continue;
      }
      // Check reverse direction: skill p picked s as prereq
      if (!rawLlmPairs.has(`${p}\t${s}`)) continue;
      // Both directions were picked. Keep direction consistent with rawDiff: prereq should have lower raw.
      const rs = rawDiff.get(s) ?? 0, rp = rawDiff.get(p) ?? 0;
      // If the current direction s→p (prereq p, skill s) has rawDiff(p) > rawDiff(s), that's inverted.
      if (rp > rs + 0.2) {
        final.splice(i, 1);
        dropped++;
      }
    }
    if (dropped || synonymDropped) console.log(`[stage 6] A4 bidirectional filter: dropped ${dropped} ambiguous + ${synonymDropped} synonym-pair (both directions)`);
  }

  // --- Cycle-breaker: enforce strict DAG (P1) ---
  // Previous version dropped one edge per SCC per iteration and capped iterations at 50 —
  // dense near-duplicate SCCs left thousands of back-edges intact (~80k nodes in cycles).
  // New approach: for each SCC, order nodes by rawDiff ascending and drop ALL back-edges
  // (edges where prereq-rawDiff ≥ child-rawDiff in the SCC's internal linearization).
  // Iterate until no SCC of size ≥2 remains. Seed edges preferred-kept — dropped last.
  let cyclesBroken = 0, cyclesSeedDropped = 0;
  const cycleCutLog: string[] = []; // E4: log which edges were cut for debugging
  for (let iter = 0; iter < 100; iter++) {
    // Build adjacency: prereq p → skill s (final stores [s, p])
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) {
      const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr);
    }
    // Tarjan SCC (iterative)
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let idx = 0;
    const sccs: string[][] = [];
    const nodes = new Set<string>();
    for (const [s, p] of final) { nodes.add(s); nodes.add(p); }
    function strongconnect(v0: string) {
      // Iterative DFS
      const callStack: { node: string; iter: Iterator<string>; minLink: number }[] = [];
      index.set(v0, idx); lowlink.set(v0, idx); idx++;
      stack.push(v0); onStack.add(v0);
      callStack.push({ node: v0, iter: (adj.get(v0) || [])[Symbol.iterator](), minLink: lowlink.get(v0)! });
      while (callStack.length) {
        const top = callStack[callStack.length - 1];
        const next = top.iter.next();
        if (next.done) {
          lowlink.set(top.node, top.minLink);
          if (lowlink.get(top.node) === index.get(top.node)) {
            const comp: string[] = [];
            while (true) {
              const w = stack.pop()!; onStack.delete(w); comp.push(w);
              if (w === top.node) break;
            }
            if (comp.length > 1) sccs.push(comp);
          }
          callStack.pop();
          if (callStack.length) {
            const parent = callStack[callStack.length - 1];
            parent.minLink = Math.min(parent.minLink, top.minLink);
          }
          continue;
        }
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, idx); lowlink.set(w, idx); idx++;
          stack.push(w); onStack.add(w);
          callStack.push({ node: w, iter: (adj.get(w) || [])[Symbol.iterator](), minLink: lowlink.get(w)! });
        } else if (onStack.has(w)) {
          top.minLink = Math.min(top.minLink, index.get(w)!);
        }
      }
    }
    for (const n of nodes) if (!index.has(n)) strongconnect(n);
    if (sccs.length === 0) break;
    // For each SCC: prefer linearization that keeps all seed edges forward. If seed edges
    // form internal cycles among themselves (rare but possible), fall back to rawDiff ordering.
    // Strategy per SCC:
    //   1. Build subgraph of seed edges only.
    //   2. If seed subgraph is a DAG, topo-sort the SCC with seed edges as "must-be-forward"
    //      constraints (using Kahn on seed-only edges; ties broken by rawDiff ascending).
    //   3. Drop all inferred back-edges in that linearization.
    //   4. If still cyclic (seed edges themselves form a cycle), drop the weakest seed edge in it.
    const toDrop = new Set<string>();
    for (const scc of sccs) {
      const sccSet = new Set(scc);
      const internal: { s: string; p: string; gap: number; seed: boolean }[] = [];
      for (const [s, p] of final) {
        if (!sccSet.has(s) || !sccSet.has(p)) continue;
        const gap = (rawDiff.get(s) ?? 0) - (rawDiff.get(p) ?? 0);
        internal.push({ s, p, gap, seed: isSeed(s, p) });
      }
      // Kahn topo on seed edges only (p→s means s depends on p). Ties broken by rawDiff.
      const seedInDeg = new Map<string, number>();
      const seedAdj = new Map<string, string[]>();
      for (const n of scc) seedInDeg.set(n, 0);
      for (const e of internal) if (e.seed) {
        const arr = seedAdj.get(e.p) ?? []; arr.push(e.s); seedAdj.set(e.p, arr);
        seedInDeg.set(e.s, (seedInDeg.get(e.s) ?? 0) + 1);
      }
      const rankFor = new Map<string, number>();
      const ready: string[] = [...scc].filter((n) => (seedInDeg.get(n) ?? 0) === 0);
      ready.sort((a, b) => (rawDiff.get(a) ?? 0) - (rawDiff.get(b) ?? 0));
      let rank = 0;
      const seedCycleNodes = new Set(scc);
      while (ready.length) {
        const u = ready.shift()!;
        rankFor.set(u, rank++);
        seedCycleNodes.delete(u);
        for (const v of seedAdj.get(u) ?? []) {
          seedInDeg.set(v, (seedInDeg.get(v) ?? 0) - 1);
          if (seedInDeg.get(v) === 0) {
            // insert in rawDiff order
            let ins = 0;
            while (ins < ready.length && (rawDiff.get(ready[ins]) ?? 0) <= (rawDiff.get(v) ?? 0)) ins++;
            ready.splice(ins, 0, v);
          }
        }
      }
      // Nodes left in seedCycleNodes participate in a seed-only cycle; fall back to rawDiff order for them.
      const leftover = [...seedCycleNodes].sort((a, b) => (rawDiff.get(a) ?? 0) - (rawDiff.get(b) ?? 0));
      for (const n of leftover) rankFor.set(n, rank++);
      // Drop back-edges: inferred first.
      let droppedThisScc = 0;
      for (const e of internal) {
        const rs = rankFor.get(e.s)!, rp = rankFor.get(e.p)!;
        if (rp >= rs) {
          toDrop.add(`${e.s}\t${e.p}`);
          if (e.seed) cyclesSeedDropped++;
          cycleCutLog.push(`${e.s}\t${e.p}\t${e.seed ? "seed" : "inferred"}\t${e.gap.toFixed(3)}`);
          droppedThisScc++;
        }
      }
      if (droppedThisScc === 0 && internal.length) {
        // Shouldn't happen — if SCC exists, at least one edge must be a back-edge under any linear order.
        // But safety: drop weakest inferred edge.
        internal.sort((a, b) => (a.seed === b.seed ? a.gap - b.gap : a.seed ? 1 : -1));
        const e = internal[0];
        toDrop.add(`${e.s}\t${e.p}`);
        if (e.seed) cyclesSeedDropped++;
        cycleCutLog.push(`${e.s}\t${e.p}\t${e.seed ? "seed" : "inferred"}\t${e.gap.toFixed(3)}`);
      }
    }
    const before = final.length;
    for (let i = final.length - 1; i >= 0; i--) {
      if (toDrop.has(`${final[i][0]}\t${final[i][1]}`)) final.splice(i, 1);
    }
    cyclesBroken += before - final.length;
    if (before === final.length) break; // safety: no progress
  }
  console.log(`[stage 6] cycle-breaker dropped ${cyclesBroken} edges (${cyclesSeedDropped} seed)`);

  // --- Post-condition: assert DAG. If not, log and force-drop remaining SCC edges. ---
  {
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) { const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr); }
    const inDeg = new Map<string, number>();
    const allNodes = new Set<string>();
    for (const [s, p] of final) { allNodes.add(s); allNodes.add(p); }
    for (const n of allNodes) inDeg.set(n, 0);
    for (const [s] of final) inDeg.set(s, (inDeg.get(s) ?? 0) + 1);
    const q = [...allNodes].filter((n) => (inDeg.get(n) ?? 0) === 0);
    let removed = 0;
    const removedSet = new Set<string>(q);
    while (q.length) {
      const u = q.shift()!; removed++;
      for (const v of adj.get(u) ?? []) {
        inDeg.set(v, (inDeg.get(v) ?? 0) - 1);
        if (inDeg.get(v) === 0 && !removedSet.has(v)) { removedSet.add(v); q.push(v); }
      }
    }
    const stillInCycle = allNodes.size - removed;
    if (stillInCycle > 0) {
      // Drop ALL edges with both endpoints in remaining cycle set.
      const stuck = new Set<string>();
      for (const n of allNodes) if (!removedSet.has(n)) stuck.add(n);
      const before = final.length;
      for (let i = final.length - 1; i >= 0; i--) {
        const [s, p] = final[i];
        if (stuck.has(s) && stuck.has(p)) final.splice(i, 1);
      }
      console.log(`[stage 6] DAG post-condition: forced-dropped ${before - final.length} edges from ${stillInCycle} still-cyclic nodes`);
    } else {
      console.log(`[stage 6] DAG post-condition: OK (${allNodes.size} nodes, ${final.length} edges)`);
    }
  }
  if (cycleCutLog.length) {
    Deno.writeTextFileSync(`${BUILD}/6_cycle_cuts.tsv`, "skill_id\tprereq_id\tkind\tgap\n" + cycleCutLog.join("\n") + "\n");
  }

  // Write final edges
  const enc = new TextEncoder();
  const fh = Deno.openSync(`${BUILD}/6_edges.tsv`, { create: true, write: true, truncate: true });
  fh.writeSync(enc.encode("skill_id\tprereq_id\n"));
  for (const [s, p] of final) fh.writeSync(enc.encode(`${s}\t${p}\n`));
  fh.close();

  // Rebuild hub report
  const finalHubs = new Map<string, number>();
  for (const [, p] of final) finalHubs.set(p, (finalHubs.get(p) ?? 0) + 1);
  const topHubs = [...finalHubs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  // Seed survival = seed edges present in final / seed edges loaded (pre-holdout)
  let seedInFinal = 0;
  for (const [s, p] of final) if (isSeed(s, p)) seedInFinal++;

  writeStats(6, {
    before_edges: beforeTotal,
    dropped_tech: droppedTech,
    dropped_per_topic: droppedPerTopic,
    dropped_hub: droppedHub,
    dropped_cross_domain: droppedCrossDomain,
    seed_loaded: seedLoaded,
    seed_added: seedAdded,
    seed_in_final: seedInFinal,
    seed_survival_rate: seedLoaded ? +(seedInFinal / seedLoaded).toFixed(3) : 0,
    seed_skipped_missing: seedSkippedMissing,
    seed_diff_override: seedDiffOverride,
    seed_held_out: seedHoldout,
    cycles_broken: cyclesBroken,
    cycles_seed_dropped: cyclesSeedDropped,
    band_seed_exempt: bandSeedExempt,
    tech_seed_exempt: techSeedExempt,
    hub_seed_exempt: hubSeedExempt,
    foundation_exempt: foundationExempt,
    heuristic_orphan_fixed: orphanFixed,
    final_edges: final.length,
    skills_with_prereqs: new Set(final.map((e) => e[0])).size,
    skills_lost_all_prereqs: lostAll,
    orphan_rate: 1 - new Set(final.flatMap((e) => [e[0], e[1]])).size / skill.size,
    top_hubs_after: topHubs.map(([id, n]) => [id, n, skill.get(id)?.title.slice(0, 60)]),
  });
}

// ---------- stage 7: finalize skills.tsv ----------

function stage7Finalize() {
  const taggedLines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const thdr = taggedLines[0].split("\t");
  const iTitle = thdr.indexOf("title");
  const iDesc = thdr.indexOf("description");
  const iOcc = thdr.indexOf("occupations");
  const iTop = thdr.indexOf("topics");
  const iTags = thdr.indexOf("tags");
  const skills = taggedLines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[iTitle], description: c[iDesc], occupations: c[iOcc], topics: c[iTop], tags: iTags >= 0 ? (c[iTags] || "") : "" };
  });

  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const diff = new Map<string, number>();
  for (let i = 1; i < diffLines.length; i++) {
    const c = diffLines[i].split("\t");
    diff.set(c[0], Number(c[1]));
  }

  // Load alias map (dropped_id → canonical_id) for final-pass remap of any stale edges.
  const aliasMap = new Map<string, string>();
  try {
    const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    for (let i = 1; i < aliasLines.length; i++) {
      const [drop, keep] = aliasLines[i].split("\t");
      if (drop && keep) aliasMap.set(drop, keep);
    }
  } catch { /* none */ }
  const remap = (id: string) => aliasMap.get(id) ?? id;

  const skillIdSet = new Set<string>(skills.map((s) => s.id));
  const edgeLines = Deno.readTextFileSync(`${BUILD}/6_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
  const prereqs = new Map<string, string[]>();
  let edgeRemapped = 0, edgeOrphanDropped = 0;
  for (const l of edgeLines) {
    let [s, p] = l.split("\t");
    const s2 = remap(s), p2 = remap(p);
    if (s2 !== s || p2 !== p) edgeRemapped++;
    if (!skillIdSet.has(s2) || !skillIdSet.has(p2)) { edgeOrphanDropped++; continue; }
    if (s2 === p2) { edgeOrphanDropped++; continue; }
    s = s2; p = p2;
    const arr = prereqs.get(s) ?? [];
    if (!arr.includes(p)) arr.push(p);
    prereqs.set(s, arr);
  }
  console.log(`[stage 7] edge remap: ${edgeRemapped} rewritten, ${edgeOrphanDropped} orphan/self dropped`);

  // --- Description enrichment via Wikipedia REST summaries (for skills with thin descriptions) ---
  const wikiSummary = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(`${BUILD}/1h_wiki_summaries.tsv`).split("\n")) {
      if (!line) continue;
      const [id, ...rest] = line.split("\t");
      const text = rest.join("\t");
      if (id && text) wikiSummary.set(id, text);
    }
    console.log(`[stage 7] loaded ${wikiSummary.size} Wikipedia summaries`);
  } catch { /* skip */ }

  // --- Topic enrichment via Wikidata P279 parent labels, + framework stoplist ---
  const idToQid = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`).split("\n")) {
      if (!line) continue;
      try { const d: { id: string; qid?: string } = JSON.parse(line); if (d.qid) idToQid.set(d.id, d.qid); } catch { /* skip */ }
    }
  } catch { /* no wiki */ }
  const qidParents = new Map<string, string[]>();
  try {
    for (const line of Deno.readTextFileSync(`${BUILD}/1g_wd_parents.jsonl`).split("\n")) {
      if (!line) continue;
      try { const d: { qid: string; parents: string[] } = JSON.parse(line); qidParents.set(d.qid, d.parents); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  const qidLabel = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(`${BUILD}/1i_qid_labels.tsv`).split("\n")) {
      if (!line) continue;
      const [qid, label] = line.split("\t");
      if (qid && label) qidLabel.set(qid, label);
    }
  } catch { /* skip */ }

  // Framework/standards stoplist — regex on topic slug
  const frameworkRe = /-standards|-20\d\d|^sced-|^content-khan|^ccss$|^ngss$|next-generation-science|k-5-mathematics|adult-basic-education|cte-standards|curriculum|course-codes|^skills$|^content$|^learning-stage-/;
  // Wikipedia-category junk patterns (C1/B3). These are DBpedia/Wikidata category artifacts that
  // leak as topics but are not real subject areas: "Rome officials and employees", "Flying machines",
  // "Photomechanical processes" etc. Kills these classes wholesale.
  const wikiCategoryRe = /-officials-and-employees$|-by-country$|-by-region$|-by-type$|-by-year$|-introduced-in-|-established-in-|-disestablished-in-|-founded-in-|-born-in-|-died-in-|-set-in-|^people-in-|-people$|-in-history$/;

  // Cap topics per skill after enrichment
  const TOPIC_CAP = 5;

  // Compute parent-QID frequency to drop universal abstractions (entity, object, …)
  const parentFreq = new Map<string, number>();
  for (const s of skills) {
    const qid = idToQid.get(s.id);
    if (!qid) continue;
    const parents = qidParents.get(qid) || [];
    for (const p of parents) parentFreq.set(p, (parentFreq.get(p) ?? 0) + 1);
  }
  const wikiSkillCount = skills.filter((s) => idToQid.has(s.id)).length;
  const abstractThreshold = Math.max(50, Math.floor(wikiSkillCount * 0.15));
  const blockedQids = new Set<string>();
  for (const [q, n] of parentFreq) if (n >= abstractThreshold) blockedQids.add(q);
  console.log(`[stage 7] blocking ${blockedQids.size} abstract parent QIDs (≥${abstractThreshold} skills, of ${wikiSkillCount} wiki-resolved)`);

  // --- Cruft-orphan drop: skills with no prereqs, no descendants, no coherent content ---
  // Must not drop canonical ids that other skills alias to.
  const aliasCanonicals = new Set<string>();
  try {
    const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    for (let i = 1; i < aliasLines.length; i++) aliasCanonicals.add(aliasLines[i].split("\t")[1]);
  } catch { /* none */ }
  const childCount = new Map<string, number>();
  for (const [, p] of prereqs) for (const pid of p) childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
  const isOrphanLeaf = (id: string) => (prereqs.get(id) || []).length === 0 && (childCount.get(id) ?? 0) === 0;
  const isCruft = (s: { id: string; title: string; description: string }) => {
    if (aliasCanonicals.has(s.id)) return false;
    if (s.id.split("-").length >= 5 && (s.description || "").length < 60) return true;
    if (/^review-records|^prepare-inserts|^seal-containers/.test(s.id)) return true;
    return false;
  };

  // --- P279 filter helpers ---
  const yearRe = /(^|-)(19|20)\d\d(-|$)|^\d+$/;
  const STOP = new Set(["the","a","an","of","to","for","in","on","and","or","with","by","at","from","as","is","be","that","this","these","those"]);
  const sigTokens = (id: string) => new Set(id.split("-").filter((t) => t.length >= 4 && !STOP.has(t)));

  // Compact display title for verbose OpenSALT/ONET-task entries.
  const deriveDisplay = (title: string, tags: string): string => {
    if (title.length <= 80) return title;
    // Prefer a code:XXX tag if present (OpenSALT humanCodingScheme)
    for (const t of tags.split(",")) {
      if (t.startsWith("code:")) {
        const code = t.slice(5).trim();
        if (code && code.length <= 80) return code;
      }
    }
    // Cut at first sentence boundary ≤80; reserve room for ellipsis on word-break
    const head = title.slice(0, 80);
    const lastDot = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    if (lastDot > 30) return head.slice(0, lastDot + 1).trim();
    const trim = title.slice(0, 79);
    const lastSpace = trim.lastIndexOf(" ");
    return (lastSpace > 30 ? trim.slice(0, lastSpace) : trim).trim() + "…";
  };

  // First pass: assemble candidate topic sets (skip emission until we know topic frequencies)
  type Row = { id: string; title: string; display: string; desc: string; d: number; ps: string; occ: string; topics: string[]; gStart: string; gEnd: string };
  const pending: Row[] = [];
  let wikiEnriched = 0, frameworkFiltered = 0, descEnriched = 0, dropped = 0, p279Filtered = 0, lcshEnriched = 0;
  // B2/B3: LCSH + DBpedia ancestor chain caches (stages 1j, 1k). Merged into one lookup map.
  const lcshTree = new Map<string, string[]>();
  const loadTree = (path: string) => {
    try {
      for (const line of Deno.readTextFileSync(path).split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        const slug = line.slice(0, tab);
        const anc = line.slice(tab + 1).split(",").filter(Boolean);
        if (slug && anc.length) {
          const existing = lcshTree.get(slug);
          lcshTree.set(slug, existing ? [...new Set([...existing, ...anc])] : anc);
        }
      }
    } catch { /* missing */ }
  };
  loadTree(`${BUILD}/1j_lcsh_tree.tsv`);
  loadTree(`${BUILD}/1k_dbpedia_tree.tsv`);
  console.log(`[stage 7] loaded ${lcshTree.size} LCSH+DBpedia ancestor chains`);
  for (const s of skills) {
    if (isOrphanLeaf(s.id) && isCruft(s)) { dropped++; continue; }
    const d = diff.get(s.id);
    if (d === undefined) throw new Error(`skill ${s.id} missing from difficulty.tsv`);
    const ps = (prereqs.get(s.id) ?? []).join(",");
    const existing = s.topics.split(",").filter(Boolean);
    // Skill's reference tokens: from id, title, description, occupations — used for P279-append overlap only
    const skillTokens = sigTokens(s.id);
    for (const tok of sigTokens(s.title.toLowerCase().replace(/\s+/g, "-"))) skillTokens.add(tok);
    for (const tok of sigTokens((s.description || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, "-"))) skillTokens.add(tok);
    for (const t of s.occupations.split(",").filter(Boolean)) for (const tok of sigTokens(t)) skillTokens.add(tok);
    // Filter existing topics: only drop obvious junk (year, all-short-tokens, framework stoplist). Don't require overlap — many legit topics don't share tokens.
    const filtered = existing.filter((t) => {
      if (frameworkRe.test(t)) { frameworkFiltered++; return false; }
      if (wikiCategoryRe.test(t)) { p279Filtered++; return false; } // C1 wiki-category junk
      if (yearRe.test(t)) { p279Filtered++; return false; }
      if (sigTokens(t).size === 0) { p279Filtered++; return false; }
      return true;
    });
    const qid = idToQid.get(s.id);
    const parents = qid ? (qidParents.get(qid) || []) : [];
    const parentTopics: string[] = [];
    for (const pQid of parents) {
      if (blockedQids.has(pQid)) continue;
      const lbl = qidLabel.get(pQid);
      if (!lbl) continue;
      const slug = slugify(lbl);
      if (!slug) continue;
      if (yearRe.test(slug)) { p279Filtered++; continue; }
      if (wikiCategoryRe.test(slug)) { p279Filtered++; continue; } // C1
      if (frameworkRe.test(slug)) { frameworkFiltered++; continue; }
      const parentToks = sigTokens(slug);
      let overlap = 0;
      for (const tok of parentToks) if (skillTokens.has(tok)) { overlap++; break; }
      if (!overlap) { p279Filtered++; continue; }
      parentTopics.push(slug);
      if (parentTopics.length >= 4) break;
    }
    if (parentTopics.length) wikiEnriched++;
    // B2: LCSH broader-chain enrichment. For each kept topic and the skill's own id/title,
    // look up ancestor chain from LCSH tree cache and append (token-overlap guarded).
    const lcshTopics: string[] = [];
    const lcshCandidates = [s.id, slugify(s.title), ...filtered];
    for (const cand of lcshCandidates) {
      const anc = lcshTree.get(cand);
      if (!anc) continue;
      for (const a of anc) {
        if (lcshTopics.includes(a)) continue;
        if (yearRe.test(a) || wikiCategoryRe.test(a) || frameworkRe.test(a)) continue;
        if (sigTokens(a).size === 0) continue;
        // overlap guard: ancestor slug must share a token with skill signature
        const aToks = sigTokens(a);
        let ovl = 0;
        for (const tok of aToks) if (skillTokens.has(tok)) { ovl++; break; }
        if (!ovl) continue;
        lcshTopics.push(a);
        if (lcshTopics.length >= 3) break;
      }
      if (lcshTopics.length >= 3) break;
    }
    if (lcshTopics.length) lcshEnriched++;
    const topics = [...new Set([...filtered, ...parentTopics, ...lcshTopics])].slice(0, TOPIC_CAP);
    let desc = s.description;
    const wikiText = wikiSummary.get(s.id);
    if (wikiText && desc.length < 80) { desc = wikiText; descEnriched++; }
    // Grade extraction from `grade:XX` tags (XX may be PK, K, 0..12)
    const gradeMap: Record<string, number> = { "PK": -1, "K": 0 };
    const grades: number[] = [];
    for (const tag of s.tags.split(",")) {
      if (!tag.startsWith("grade:")) continue;
      const v = tag.slice(6).toUpperCase();
      const n = gradeMap[v] ?? (/^\d+$/.test(v) ? Number(v) : NaN);
      if (!Number.isNaN(n)) grades.push(n);
    }
    const gStart = grades.length ? Math.min(...grades).toString() : "";
    const gEnd = grades.length ? Math.max(...grades).toString() : "";
    pending.push({ id: s.id, title: s.title, display: deriveDisplay(s.title, s.tags), desc, d, ps, occ: s.occupations, topics, gStart, gEnd });
  }

  // Second pass: compute global topic frequencies, drop singletons AND super-generic
  // topics (C2: doc-freq > 1% of skills). Super-generic topics like "skills" or
  // "content-khan-academy" add no information and dominate the tag space.
  const topicFreq = new Map<string, number>();
  for (const r of pending) for (const t of r.topics) topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
  const MAX_TOPIC_FREQ = Math.max(1200, Math.floor(pending.length * 0.013));
  const topicWhitelist = new Set([
    "mathematics","science","biology","chemistry","physics","engineering","technology",
    "economics","history","literature","philosophy","medicine","law","education",
    "problem-solving","critical-thinking","communication","management","leadership",
    "computer-science","software-engineering","data-analysis","statistics","research",
    "information-skills","management-skills","nondestructive-testing","mathematical-optimization",
    "handling-and-moving","personnel-management","working-with-machinery-and-specialised-equipment",
  ]);
  // Hard blocklist: Wikipedia/LCSH ancestors that slipped the pattern filter but are too broad.
  // "professional-employees", "persons", "scientists" etc. are top-of-hierarchy collective nouns.
  const topicBlocklist = new Set([
    "photomechanical-processes", "flying-machines", "rome-officials-and-employees",
    "traffic-regulations", "units-of-measurement",
    // LCSH top-of-hierarchy collective nouns (too broad to be useful):
    "professional-employees", "employees", "persons", "specialists", "scientists",
    "workers", "people", "occupations", "officials", "personnel", "staff",
    "professionals", "practitioners", "technicians", "operators",
    // Wikipedia/LCSH category artifacts (not meaningful skill topics):
    "judaism-customs-and-practices", "descriptive-cataloging", "ibm-computers",
    "wikiproject-countries-projects", "wikiproject-africa-projects",
    "computer-input-output-equipment", "history-of-technology",
    "personality-tests", "diagnostic-equipment-industry", "industrial-equipment-industry",
    "portable-computers", "telecommunication-equipment-industry",
    "law-interpretation-and-construction",
  ]);
  let singletonDropped = 0, genericDropped = 0;
  for (const r of pending) {
    const kept: string[] = [];
    for (const t of r.topics) {
      const f = topicFreq.get(t) ?? 0;
      if (f < 2) { singletonDropped++; continue; }
      if (topicBlocklist.has(t)) { genericDropped++; continue; }
      if (f > MAX_TOPIC_FREQ && !topicWhitelist.has(t)) { genericDropped++; continue; }
      kept.push(t);
    }
    r.topics = kept;
  }
  console.log(`[stage 7] topic freq cap: max=${MAX_TOPIC_FREQ} (1% of ${pending.length}), generic_dropped=${genericDropped}`);

  const rows = ["id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end"];
  for (const r of pending) {
    rows.push([r.id, r.title, r.display, r.desc, r.d.toString(), r.ps, r.occ, r.topics.join(","), r.gStart, r.gEnd].join("\t"));
  }
  Deno.writeTextFileSync("skills.tsv", rows.join("\n") + "\n");

  // Integrity assert: every emitted prereq id must exist in the emitted skill set.
  const emittedIdSet = new Set<string>();
  for (let i = 1; i < rows.length; i++) emittedIdSet.add(rows[i].split("\t")[0]);
  let violations = 0;
  for (const r of pending) {
    if (!r.ps) continue;
    for (const p of r.ps.split(",")) {
      if (!emittedIdSet.has(p)) {
        if (violations < 5) console.error(`[stage 7] orphan edge: ${r.id} → ${p}`);
        violations++;
      }
    }
  }
  if (violations > 0) throw new Error(`stage 7: ${violations} orphan prereq references`);
  console.log(`[stage 7] topic enrichment: wiki_enriched=${wikiEnriched}, framework_filtered=${frameworkFiltered}, p279_filtered=${p279Filtered}, singleton_dropped=${singletonDropped}, desc_enriched=${descEnriched}, cruft_dropped=${dropped}`);

  // gzip (keep original)
  new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] }).outputSync();
  const src = Deno.readFileSync("skills.tsv");

  // Reachability BFS from roots — use the post-remap prereqs map (filtered to emitted ids).
  const adj = new Map<string, string[]>();
  for (const [s, ps] of prereqs) {
    if (!emittedIdSet.has(s)) continue;
    for (const p of ps) {
      if (!emittedIdSet.has(p)) continue;
      const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr);
    }
  }
  const roots = skills.filter((s) => emittedIdSet.has(s.id) && !prereqs.has(s.id)).map((s) => s.id);
  const visited = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) if (!visited.has(v)) { visited.add(v); queue.push(v); }
  }

  const emitted = rows.length - 1;
  writeStats(7, {
    skills_emitted: emitted,
    skills_dropped_cruft: dropped,
    edges: [...prereqs.values()].reduce((s, a) => s + a.length, 0),
    skills_with_prereqs: prereqs.size,
    orphan_skills: emitted - prereqs.size,
    roots: roots.length,
    reachable_from_roots: visited.size,
    unreachable: emitted - visited.size,
    wiki_desc_enriched: descEnriched,
    wiki_topic_enriched: wikiEnriched,
    lcsh_topic_enriched: lcshEnriched,
    framework_topics_filtered: frameworkFiltered,
    p279_topics_filtered: p279Filtered,
    singleton_topics_dropped: singletonDropped,
    grade_populated: rows.slice(1).filter((r) => r.split("\t")[8] !== "").length,
    edge_remapped: edgeRemapped,
    edge_orphan_dropped: edgeOrphanDropped,
    file_bytes: src.byteLength,
  });
}

// ---------- stage 3b: dedupe near-identical skills (runs after tag, before difficulty) ----------

// One-time migration: convert 5_prereqs.tsv from positional indexes to resolved prereq ids.
// Old format: skill_id \t "1,3,5"  New format: skill_id \t prereq_id1,prereq_id2,prereq_id3
function migratePrereqsToResolvedIds() {
  const path = `${BUILD}/5_prereqs.tsv`;
  let text: string;
  try { text = Deno.readTextFileSync(path); } catch { return; }
  const lines = text.split("\n").filter((l) => l.length);
  if (!lines.length) return;
  // Detect format: if any non-none response starts with non-digit or contains hyphen → already resolved
  const sample = lines.slice(0, 50).map((l) => l.split("\t")[1] || "");
  const looksResolved = sample.some((s) => s && s !== "none" && /-/.test(s));
  if (looksResolved) return; // already migrated

  console.log(`[migration] converting ${lines.length} prereq responses to resolved-id format`);
  // Need: skill id order and candidates
  const taggedLines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
  const order: string[] = taggedLines.slice(1).map((l) => l.split("\t")[0]);
  const candLines = Deno.readTextFileSync(`${BUILD}/5_candidates.tsv`).split("\n").filter((l) => l.length);
  const candidates = new Map<string, number[]>();
  for (const line of candLines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    candidates.set(id, rest ? rest.split(",").map(Number) : []);
  }

  const resolved = new Map<string, string>();
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const resp = line.slice(tab + 1);
    const cands = candidates.get(id) ?? [];
    const picks = parsePrereqResponse(resp, cands.length);
    const prereqIds = picks.map((p) => order[cands[p]]).filter((x) => x);
    resolved.set(id, prereqIds.join(","));
  }
  const out = [...resolved.entries()].map(([id, v]) => `${id}\t${v}`).join("\n") + "\n";
  Deno.writeTextFileSync(path + ".bak", text);
  Deno.writeTextFileSync(path, out);
  console.log(`[migration] migrated ${resolved.size} rows; backup at ${path}.bak`);
}

function stage3bDedupe() {
  migratePrereqsToResolvedIds();
  const lines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
  const hdrCols = lines[0].split("\t");
  type Row = { id: string; title: string; description: string; sources: string; tags: string; occupations: string; topics: string };
  const rows: Row[] = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4], occupations: c[5], topics: c[6] };
  });

  // Load embeddings
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const DIM = EMBED_DIM;
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToIdx.set(ids[i], i);
  const vecs = new Float32Array(rows.length * DIM);
  for (let i = 0; i < rows.length; i++) {
    const embIdx = idToIdx.get(rows[i].id);
    if (embIdx === undefined) throw new Error(`no embedding for ${rows[i].id}`);
    vecs.set(normalize(emb.subarray(embIdx * DIM, (embIdx + 1) * DIM)), i * DIM);
  }

  const DEDUPE_COSINE = Number(Deno.env.get("DEDUPE_COSINE") ?? "0.96");

  // Merge map: idx → canonical idx
  const parent = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) parent[i] = i;
  function find(i: number): number { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // Canonical = shortest title (prefer well-formed ids: lowercase + hyphens only)
    const keep = rows[ra].title.length <= rows[rb].title.length ? ra : rb;
    const drop = keep === ra ? rb : ra;
    parent[drop] = keep;
  }

  // --- Pass 0: merge by shared Wikipedia article (authoritative) ---
  let qidMerges = 0;
  try {
    const wikiText = Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`);
    const idToQid = new Map<string, string>();
    for (const line of wikiText.split("\n")) {
      if (!line) continue;
      try {
        const d: { id: string; qid?: string } = JSON.parse(line);
        if (d.qid) idToQid.set(d.id, d.qid);
      } catch { /* skip */ }
    }
    const qidBuckets = new Map<string, number[]>();
    for (let i = 0; i < rows.length; i++) {
      const qid = idToQid.get(rows[i].id);
      if (!qid) continue;
      const arr = qidBuckets.get(qid) ?? []; arr.push(i); qidBuckets.set(qid, arr);
    }
    for (const [, idxs] of qidBuckets) {
      if (idxs.length < 2) continue;
      for (let k = 1; k < idxs.length; k++) {
        union(idxs[0], idxs[k]);
        qidMerges++;
      }
    }
    console.log(`[stage 3b] QID-based merges: ${qidMerges} (across ${qidBuckets.size} QID buckets)`);
  } catch { console.log(`[stage 3b] no 1f_wiki.jsonl; skipping QID merge`); }

  // --- Pass 0.5: token-sort signature merge (and/or swaps, word reorders) ---
  const SIG_STOP = new Set(["a","an","the","of","to","for","in","on","at","by","with","is","are","be","or","and","from","as","their","its","this","that","these","those"]);
  const tokenSigOf = (title: string): string => {
    const t = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const toks = t.split(/\s+/).filter((w) => w.length >= 3 && !SIG_STOP.has(w));
    toks.sort();
    return toks.join(" ");
  };
  const sigBuckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const sig = tokenSigOf(rows[i].title);
    if (!sig) continue;
    const arr = sigBuckets.get(sig) ?? []; arr.push(i); sigBuckets.set(sig, arr);
  }
  let sigMerges = 0;
  for (const [, idxs] of sigBuckets) {
    if (idxs.length < 2) continue;
    for (let k = 1; k < idxs.length; k++) { union(idxs[0], idxs[k]); sigMerges++; }
  }
  console.log(`[stage 3b] token-sort signature merges: ${sigMerges} (across ${sigBuckets.size} signature buckets)`);

  // Bucket by top-topic (pre-difficulty) — catches duplicates at any difficulty
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const topic = rows[i].topics.split(",")[0] || "_notopic";
    const arr = buckets.get(topic) ?? []; arr.push(i); buckets.set(topic, arr);
  }
  console.log(`[stage 3b] ${buckets.size} buckets, largest=${Math.max(...[...buckets.values()].map((a) => a.length))}`);

  // Jaccard similarity of title word sets — prevents merging semantically-close but lexically-unrelated items
  const wordSet = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 2 && !/^(the|a|an|of|for|and|to|in|on|at|by|with|is|are|be|or)$/.test(w)) out.add(w);
    }
    return out;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const JACCARD_MIN = Number(Deno.env.get("DEDUPE_JACCARD") ?? "0.7");
  const wordSets = rows.map((r) => wordSet(r.title));

  // Significant-token overlap (non-stopword, len≥3) — separate from raw Jaccard, used as
  // an additional precision gate to prevent embedding-drift false-merges in jargon-heavy fields.
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    }
    return out;
  };
  const sigSets = rows.map((r) => sigTokens(r.title));
  const SIG_OVERLAP_MIN = 0.4;

  let merged = 0, rejectedByJaccard = 0, rejectedByOverlap = 0, rejectedByLength = 0, skippedHuge = 0;
  for (const [, idxs] of buckets) {
    if (idxs.length < 2) continue;
    if (idxs.length > 1500) { skippedHuge++; continue; } // huge generic topics: skip to stay quadratic-tractable
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        // quick Jaccard gate before cosine (cheaper)
        const j = jaccard(wordSets[idxs[a]], wordSets[idxs[b]]);
        if (j < JACCARD_MIN) { rejectedByJaccard++; continue; }
        // Title-length-ratio guard: don't merge a long compliance statement with a short skill label.
        const la = rows[idxs[a]].title.length, lb = rows[idxs[b]].title.length;
        if (Math.max(la, lb) / Math.max(1, Math.min(la, lb)) > 3) { rejectedByLength++; continue; }
        // Significant-token overlap fraction (precision gate against jargon embedding drift)
        const sa = sigSets[idxs[a]], sb = sigSets[idxs[b]];
        if (sa.size && sb.size) {
          let inter = 0;
          for (const t of sa) if (sb.has(t)) inter++;
          const overlap = inter / Math.min(sa.size, sb.size);
          if (overlap < SIG_OVERLAP_MIN) { rejectedByOverlap++; continue; }
        }
        let sc = 0;
        const oa = idxs[a] * DIM, ob = idxs[b] * DIM;
        for (let d = 0; d < DIM; d++) sc += vecs[oa + d] * vecs[ob + d];
        if (sc < DEDUPE_COSINE) continue;
        union(idxs[a], idxs[b]);
        merged++;
      }
    }
  }
  console.log(`[stage 3b] skipped ${skippedHuge} oversize buckets`);
  console.log(`[stage 3b] rejected: jaccard=${rejectedByJaccard}, overlap=${rejectedByOverlap}, length=${rejectedByLength}`);
  console.log(`[stage 3b] ${merged} cosine+jaccard merges (on top of ${qidMerges} QID merges)`);

  // Build id → canonical_id alias map (preserves stable survivors)
  const alias = new Map<string, string>();
  let survivors = 0, dropped = 0;
  for (let i = 0; i < rows.length; i++) {
    const canonical = find(i);
    if (canonical === i) survivors++;
    else { alias.set(rows[i].id, rows[canonical].id); dropped++; }
  }
  console.log(`[stage 3b] survivors=${survivors}, dropped=${dropped}`);

  // Write deduped tagged.tsv with merged ext_ids + unioned occupations/topics from merged skills
  const groupBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    const arr = groupBy.get(c) ?? []; arr.push(i); groupBy.set(c, arr);
  }
  type Canon = { idx: number; occs: string[]; topics: string[]; allTags: string[] };
  const canons: Canon[] = [];
  for (const [canonicalIdx, groupIdxs] of groupBy) {
    const canonical = rows[canonicalIdx];
    const occs = new Set<string>();
    const topics = new Set<string>();
    const allTags = new Set<string>(canonical.tags.split(",").filter(Boolean));
    for (const i of groupIdxs) {
      for (const o of rows[i].occupations.split(",").filter((x) => x)) occs.add(o);
      for (const t of rows[i].topics.split(",").filter((x) => x)) topics.add(t);
      for (const tg of rows[i].tags.split(",").filter((x) => x)) allTags.add(tg);
    }
    canons.push({ idx: canonicalIdx, occs: [...occs].slice(0, 3), topics: [...topics].slice(0, 3), allTags: [...allTags] });
  }

  // --- Backfill tags for fully-untagged canonicals using embedding neighbors ---
  // Inverted index on significant title tokens restricts candidate pool per query.
  const BF_STOP = new Set(["a","an","the","of","to","for","in","on","and","or","with","at","by","from","as"]);
  const titleToks = (s: string): string[] => {
    const t = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return t.split(/\s+/).filter((w) => w.length >= 4 && !BF_STOP.has(w));
  };
  const tokToCanons = new Map<string, number[]>();
  for (let k = 0; k < canons.length; k++) {
    const t = rows[canons[k].idx].title;
    for (const tok of titleToks(t)) {
      const arr = tokToCanons.get(tok) ?? []; arr.push(k); tokToCanons.set(tok, arr);
    }
  }
  // C4: backfill empty dimensions (occs OR topics) independently. Was previously only run
  // for skills with BOTH empty; now processes any skill missing either. Lower similarity
  // threshold (0.6) since we're targeting a wider tail.
  let backfilledTopics = 0, backfilledOccs = 0, backfillTried = 0;
  const BF_SIM = 0.6;
  for (let k = 0; k < canons.length; k++) {
    const c = canons[k];
    const needTopics = c.topics.length === 0;
    const needOccs = c.occs.length === 0;
    if (!needTopics && !needOccs) continue;
    backfillTried++;
    const queryTitle = rows[c.idx].title;
    const qToks = titleToks(queryTitle);
    if (!qToks.length) continue;
    const pool = new Set<number>();
    for (const tok of qToks) {
      const arr = tokToCanons.get(tok);
      if (!arr) continue;
      if (arr.length > 2000) continue;
      for (const i of arr) if (i !== k) pool.add(i);
    }
    if (!pool.size) continue;
    const qOff = c.idx * DIM;
    const scored: [number, number][] = [];
    for (const i of pool) {
      const other = canons[i];
      // only consider neighbors that can supply what we need
      if (needTopics && other.topics.length === 0 && (!needOccs || other.occs.length === 0)) continue;
      if (!needTopics && needOccs && other.occs.length === 0) continue;
      let sc = 0;
      const oOff = other.idx * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[qOff + d] * vecs[oOff + d];
      if (sc >= BF_SIM) scored.push([i, sc]);
    }
    if (scored.length < 3) continue;
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, 10);
    const topicVotes = new Map<string, number>();
    const occVotes = new Map<string, number>();
    for (const [i, w] of top) {
      for (const t of canons[i].topics) topicVotes.set(t, (topicVotes.get(t) ?? 0) + w);
      for (const o of canons[i].occs) occVotes.set(o, (occVotes.get(o) ?? 0) + w);
    }
    const pickTop = (m: Map<string, number>, minVotes: number, cap: number): string[] => {
      const entries = [...m.entries()].filter(([, v]) => v >= minVotes).sort((a, b) => b[1] - a[1]);
      return entries.slice(0, cap).map(([k]) => k);
    };
    const minW = 3 * BF_SIM;
    if (needTopics) {
      const newTopics = pickTop(topicVotes, minW, 3);
      if (newTopics.length) { c.topics = newTopics; backfilledTopics++; }
    }
    if (needOccs) {
      const newOccs = pickTop(occVotes, minW, 2);
      if (newOccs.length) { c.occs = newOccs; backfilledOccs++; }
    }
  }
  console.log(`[stage 3b] tag backfill: tried ${backfillTried}, topics+=${backfilledTopics}, occs+=${backfilledOccs}`);

  const outLines = [hdrCols.join("\t")];
  for (const c of canons) {
    const canonical = rows[c.idx];
    outLines.push([
      canonical.id, canonical.title, canonical.description,
      canonical.sources, c.allTags.join(","),
      c.occs.join(","), c.topics.join(","),
    ].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/3b_tagged_deduped.tsv`, outLines.join("\n") + "\n");

  // Write alias file (both directions)
  const aliasLines = ["dropped_id\tcanonical_id"];
  for (const [drop, keep] of alias) aliasLines.push(`${drop}\t${keep}`);
  Deno.writeTextFileSync(`${BUILD}/3b_aliases.tsv`, aliasLines.join("\n") + "\n");

  writeStats(35, {
    before: rows.length,
    dropped,
    after: survivors,
    reduction_pct: 100 * dropped / rows.length,
    buckets: buckets.size,
    skipped_huge_buckets: skippedHuge,
    dedupe_cosine: DEDUPE_COSINE,
    jaccard_min: JACCARD_MIN,
    sig_merges: sigMerges,
    backfill_tried: backfillTried,
    backfilled_topics: backfilledTopics,
    backfilled_occs: backfilledOccs,
  });
}

// ---------- stage 1e: seed edges from expert-labeled prereq datasets ----------

// Load current skill id space. Prefer deduped output if present.
function loadSkillIndex(): { idSet: Set<string>; titleToId: Map<string, string>; slugToId: Map<string, string> } {
  const path = taggedTsvPath();
  const lines = Deno.readTextFileSync(path).split("\n").filter((l) => l.length);
  const idSet = new Set<string>();
  const titleToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const [id, title] = lines[i].split("\t");
    if (!id) continue;
    idSet.add(id);
    const t = (title || "").toLowerCase().trim();
    if (t && !titleToId.has(t)) titleToId.set(t, id);
    slugToId.set(id, id); // id is already a slug
    const altSlug = slugify(title || "");
    if (altSlug && !slugToId.has(altSlug)) slugToId.set(altSlug, id);
  }
  return { idSet, titleToId, slugToId };
}

// Resolve a free-form concept label (Wikipedia title, Khan slug, Chinese phrase, etc.) to an id.
function resolveConcept(
  raw: string,
  idx: { idSet: Set<string>; titleToId: Map<string, string>; slugToId: Map<string, string> },
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/_/g, " ").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const lc = cleaned.toLowerCase();
  if (idx.titleToId.has(lc)) return idx.titleToId.get(lc)!;
  const slug = slugify(cleaned);
  if (idx.idSet.has(slug)) return slug;
  if (idx.slugToId.has(slug)) return idx.slugToId.get(slug)!;
  // Try the raw slug (without paren stripping)
  const rawSlug = slugify(raw.replace(/_/g, " "));
  if (idx.idSet.has(rawSlug)) return rawSlug;
  if (idx.slugToId.has(rawSlug)) return idx.slugToId.get(rawSlug)!;
  return null;
}

function h32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

async function stage1eSeedEdges() {
  console.log("[stage 1e] seeding edges from expert-labeled datasets…");
  const idx = loadSkillIndex();
  console.log(`[stage 1e] skill index: ${idx.idSet.size} ids`);

  // Collect raw pairs first; resolve in 2 passes (exact → embedding fallback)
  type RawPair = { rawSrc: string; rawDst: string; source: string; raw: string };
  const rawPairs: RawPair[] = [];
  const perSource: Record<string, { total: number; resolved: number; holdout: number; fallback: number }> = {};
  const addRaw = (rawSrc: string, rawDst: string, source: string, raw: string) => {
    rawPairs.push({ rawSrc, rawDst, source, raw });
    (perSource[source] ??= { total: 0, resolved: 0, holdout: 0, fallback: 0 }).total++;
  };

  // 1. Khan Academy khandata.tsv
  {
    const lines = Deno.readTextFileSync("data/khanacademy/khandata.tsv").split("\n").filter((l) => l.length);
    const header = lines[0].split("\t");
    const iName = header.indexOf("Data Name");
    const iPre = header.indexOf("Prereq(s)");
    const iCode = header.indexOf("Code");
    const iDisp = header.indexOf("Display Name");
    const codeToName = new Map<string, string>();
    const nameToDisplay = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      if (c[iCode] && c[iName]) codeToName.set(c[iCode].trim(), c[iName].trim());
      if (c[iName] && c[iDisp]) nameToDisplay.set(c[iName].trim(), c[iDisp].trim());
    }
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      const target = (c[iName] || "").trim();
      const preReqs = (c[iPre] || "").trim();
      if (!target || !preReqs || preReqs === "root") continue;
      const dstLabel = nameToDisplay.get(target) || target;
      for (const p of preReqs.split(";").map((x) => x.trim()).filter(Boolean)) {
        const pName = codeToName.get(p) || p;
        const srcLabel = nameToDisplay.get(pName) || pName;
        addRaw(srcLabel, dstLabel, "khan", `${pName}->${target}`);
      }
    }
  }

  // 2. AL-CPL .preqs per domain
  for (const domain of ["data_mining", "geometry", "physics", "precalculus"]) {
    const path = `data/al-cpl/data/${domain}.preqs`;
    let text: string;
    try { text = Deno.readTextFileSync(path); } catch { continue; }
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [pre, tgt] = line.split(",");
      if (!pre || !tgt) continue;
      addRaw(pre, tgt, `alcpl_${domain}`, line);
    }
  }

  // 3. Metacademy Wikipedia-mapped pairs
  {
    const text = Deno.readTextFileSync("data/metacademy/Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv");
    const rows = parseCsv(text);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const pre = r[0];
      const tgt = r[3];
      if (!pre || !tgt) continue;
      addRaw(pre, tgt, "metacademy", `${pre}->${tgt}`);
    }
  }

  // 4. MOOCCubeX cs/math/psy — gzipped JSONL, Chinese → translations.json → English
  const translations: Record<string, string> = (() => {
    try { return JSON.parse(Deno.readTextFileSync("data/mooccubex/translations.json")); } catch { return {}; }
  })();
  for (const domain of ["cs", "math", "psy"]) {
    const gzPath = `data/mooccubex/${domain}.json.gz`;
    let bytes: Uint8Array;
    try { bytes = Deno.readFileSync(gzPath); } catch { continue; }
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj: { c1?: string; c2?: string; ground_truth?: number };
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.ground_truth !== 1 || !obj.c1 || !obj.c2) continue;
      const pre = translations[obj.c1] || obj.c1;
      const tgt = translations[obj.c2] || obj.c2;
      addRaw(pre, tgt, `moocx_${domain}`, `${obj.c1}->${obj.c2}`);
    }
  }

  // 5. OpenSALT precedes associations
  {
    const dir = "data/opensalt";
    for (const f of Deno.readDirSync(dir)) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      let doc: { CFItems?: { identifier: string; humanCodingScheme?: string; fullStatement?: string }[]; CFAssociations?: { associationType?: string; originNodeURI?: { identifier?: string; title?: string }; destinationNodeURI?: { identifier?: string; title?: string } }[] };
      try { doc = JSON.parse(Deno.readTextFileSync(`${dir}/${f.name}`)); } catch { continue; }
      const itemMap = new Map<string, { code: string; statement: string }>();
      for (const it of doc.CFItems || []) {
        itemMap.set(it.identifier, { code: it.humanCodingScheme || "", statement: it.fullStatement || "" });
      }
      for (const a of doc.CFAssociations || []) {
        if ((a.associationType || "").toLowerCase() !== "precedes") continue;
        const o = a.originNodeURI || {}, d = a.destinationNodeURI || {};
        const labelOf = (x: { identifier?: string; title?: string }) => {
          if (x.identifier && itemMap.has(x.identifier)) {
            const { statement } = itemMap.get(x.identifier)!;
            return statement || x.title || x.identifier || "";
          }
          return x.title || x.identifier || "";
        };
        addRaw(labelOf(o), labelOf(d), "opensalt_precedes", `${o.identifier || o.title}->${d.identifier || d.title}`);
      }
    }
  }

  // 6. OpenSALT within-framework grade ordering (A2): for each framework with CFAssociations
  //    of type "isChildOf", group leaf standards by subject thread (via code prefix) and emit
  //    earlier-grade → later-grade prereq edges for same-parent siblings across adjacent grades.
  //    Only emits pairs with shared token overlap to avoid spurious cross-subject edges.
  {
    const dir = "data/opensalt";
    let emitted = 0;
    const STOPT = new Set(["the","a","an","of","in","on","for","to","and","or","is","at","by","with","from","as","be","that","this","which","can","will","should","about","each","student","students","their","they","them","are","use","uses"]);
    const sigT = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPT.has(w)));
    for (const f of Deno.readDirSync(dir)) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      let doc: { CFItems?: { identifier: string; humanCodingScheme?: string; fullStatement?: string; educationLevel?: string[] }[] };
      try { doc = JSON.parse(Deno.readTextFileSync(`${dir}/${f.name}`)); } catch { continue; }
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
        nodes.push({ label: it.fullStatement.slice(0, 120), grade: minG, code: it.humanCodingScheme || "" });
      }
      if (nodes.length < 10) continue;
      // Group by grade; within framework, emit earlier-grade → later-grade pairs with token overlap.
      // Require ≥3 shared significant tokens (was ≥2) and cap per (parent_grade, child_grade) at 5
      // to prevent fan-out spam from generic vocab overlaps.
      nodes.sort((a, b) => a.grade - b.grade);
      const PAIR_CAP = 5;
      const perGradePair = new Map<string, number>();
      for (let i = 0; i < nodes.length; i++) {
        const ai = nodes[i];
        const ta = sigT(ai.label);
        if (ta.size < 3) continue;
        // Look ahead to skills at grade+1..grade+3 with token overlap
        for (let j = i + 1; j < nodes.length; j++) {
          const aj = nodes[j];
          if (aj.grade <= ai.grade) continue;
          if (aj.grade > ai.grade + 3) break;
          const tb = sigT(aj.label);
          let overlap = 0;
          for (const t of ta) if (tb.has(t)) overlap++;
          if (overlap < 3) continue; // tightened: ≥3 shared significant tokens
          const k = `${ai.grade}->${aj.grade}`;
          const c = perGradePair.get(k) ?? 0;
          if (c >= PAIR_CAP) continue;
          perGradePair.set(k, c + 1);
          addRaw(ai.label, aj.label, "opensalt_grade", `${ai.code || "c"}_g${ai.grade}->${aj.code || "c"}_g${aj.grade}`);
          emitted++;
          if (emitted > 50000) break; // safety cap
        }
        if (emitted > 50000) break;
      }
      if (emitted > 50000) break;
    }
    console.log(`[stage 1e] opensalt_grade: emitted ${emitted} grade-ordering pairs`);
  }

  console.log(`[stage 1e] collected ${rawPairs.length} raw pairs across ${Object.keys(perSource).length} sources`);

  // Pass 1: exact resolution. Collect unresolved labels for embedding fallback.
  const labelToId = new Map<string, string | null>(); // memoized resolution
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
  console.log(`[stage 1e] pass 1 resolved ${labelToId.size - unresolved.size}/${labelToId.size} labels exactly; ${unresolved.size} remaining`);

  // Pass 2: embedding fallback. Embed unresolved labels via Ollama, find nearest skill embedding.
  // Cosine alone is noisy: "earning" cosine-matches many unrelated concepts via weak semantic overlap.
  // Require token overlap between label and resolved skill title to filter false positives.
  const FALLBACK_THRESHOLD = 0.90;
  const STOP = new Set(["the","a","an","of","in","on","for","to","and","or","is","at","by","with","from","as","be","that","this"]);
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const t of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) {
      if (t.length >= 3 && !STOP.has(t)) out.add(t);
    }
    return out;
  };
  const titleById = new Map<string, string>();
  {
    const tlines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
    for (let i = 1; i < tlines.length; i++) {
      const [id, title] = tlines[i].split("\t");
      if (id) titleById.set(id, title || "");
    }
  }
  if (unresolved.size > 0) {
    // Load skill embeddings
    const embIds = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
    const embBin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
    const skillVecs = new Float32Array(embBin.buffer, embBin.byteOffset, embBin.byteLength / 4);
    console.log(`[stage 1e] loaded ${embIds.length} skill embeddings for fallback`);
    // Normalize skill vectors in-place copy
    const nSkills = embIds.length;
    const nvecs = new Float32Array(nSkills * EMBED_DIM);
    for (let i = 0; i < nSkills; i++) {
      nvecs.set(normalize(skillVecs.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM)), i * EMBED_DIM);
    }
    // Only consider embeddings for ids still in idx.idSet (stage 3b may have deduped)
    const activeIds: string[] = [];
    const activeVecs: Float32Array[] = [];
    for (let i = 0; i < nSkills; i++) {
      if (idx.idSet.has(embIds[i])) {
        activeIds.push(embIds[i]);
        activeVecs.push(nvecs.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM));
      }
    }
    const matIds = activeIds;
    const mat = new Float32Array(matIds.length * EMBED_DIM);
    for (let i = 0; i < matIds.length; i++) mat.set(activeVecs[i], i * EMBED_DIM);
    console.log(`[stage 1e] active skill vectors: ${matIds.length}`);

    // Embed unresolved labels in parallel (Ollama is local, CPU-bound)
    const labels = [...unresolved];
    const labelVecs = new Float32Array(labels.length * EMBED_DIM);
    const CONCURRENCY = 16;
    let done = 0;
    const t0 = performance.now();
    for (let start = 0; start < labels.length; start += CONCURRENCY) {
      const batch = labels.slice(start, start + CONCURRENCY);
      const results = await Promise.all(batch.map(async (lbl) => {
        try { return await embedOne(lbl); } catch { return null; }
      }));
      for (let j = 0; j < results.length; j++) {
        const v = results[j];
        if (!v) continue;
        labelVecs.set(normalize(v), (start + j) * EMBED_DIM);
      }
      done += batch.length;
      if (done % 500 === 0 || done === labels.length) {
        const rate = done / ((performance.now() - t0) / 1000);
        console.log(`[stage 1e] embedded ${done}/${labels.length} (${rate.toFixed(1)}/s)`);
      }
    }

    // For each label, find best skill. Dot product (both normalized).
    const dim = EMBED_DIM;
    let fallbackMatched = 0;
    for (let li = 0; li < labels.length; li++) {
      const lv = labelVecs.subarray(li * dim, (li + 1) * dim);
      if (lv[0] === 0 && lv[1] === 0) continue; // failed embed
      let best = -1, bestScore = FALLBACK_THRESHOLD;
      for (let si = 0; si < matIds.length; si++) {
        const sv = mat.subarray(si * dim, (si + 1) * dim);
        let dot = 0;
        for (let k = 0; k < dim; k++) dot += lv[k] * sv[k];
        if (dot > bestScore) { bestScore = dot; best = si; }
      }
      if (best >= 0) {
        // Token-overlap guard: at least one significant token shared between label and skill title.
        const labelToks = sigTokens(labels[li]);
        const titleToks = sigTokens(titleById.get(matIds[best]) || matIds[best]);
        let overlap = 0;
        for (const t of labelToks) if (titleToks.has(t)) overlap++;
        if (overlap === 0 || labelToks.size === 0) continue;
        labelToId.set(labels[li], matIds[best]);
        fallbackMatched++;
      }
    }
    console.log(`[stage 1e] fallback matched ${fallbackMatched}/${labels.length} at cosine ≥ ${FALLBACK_THRESHOLD} + token-overlap guard`);
  }

  // Pass 3: emit edges using labelToId
  type Edge = { src: string; dst: string; source: string; confidence: number; holdout: boolean; fallback: boolean };
  const edgesArr: Edge[] = [];
  for (const p of rawPairs) {
    const src = labelToId.get(p.rawSrc);
    const dst = labelToId.get(p.rawDst);
    if (!src || !dst) continue;
    if (src === dst) continue;
    const srcExact = resolveConcept(p.rawSrc, idx) === src;
    const dstExact = resolveConcept(p.rawDst, idx) === dst;
    const fallback = !(srcExact && dstExact);
    // E1: holdout 20% (was 10%). Doubles eval denominators for more stable recall metrics.
    const holdout = (h32(p.source + "|" + p.raw) % 5) === 0;
    const confidence = fallback ? 0.85 : 1.0;
    edgesArr.push({ src, dst, source: p.source, confidence, holdout, fallback });
    const s = perSource[p.source];
    s.resolved++;
    if (holdout) s.holdout++;
    if (fallback) s.fallback++;
  }

  // Dedupe
  const seen = new Map<string, Edge>();
  for (const e of edgesArr) {
    const k = `${e.src}\t${e.dst}\t${e.source}`;
    const prev = seen.get(k);
    if (!prev || (prev.fallback && !e.fallback)) seen.set(k, e); // prefer non-fallback
  }
  const uniq = [...seen.values()];

  const out = ["src_id\tdst_id\tsource\tconfidence\tholdout\tfallback"];
  for (const e of uniq) out.push(`${e.src}\t${e.dst}\t${e.source}\t${e.confidence.toFixed(2)}\t${e.holdout ? "1" : "0"}\t${e.fallback ? "1" : "0"}`);
  Deno.writeTextFileSync(`${BUILD}/1e_seed_edges.tsv`, out.join("\n") + "\n");

  writeStats(110, {
    total_raw_pairs: rawPairs.length,
    total_resolved_edges: uniq.length,
    exact_edges: uniq.filter((e) => !e.fallback).length,
    fallback_edges: uniq.filter((e) => e.fallback).length,
    holdout_edges: uniq.filter((e) => e.holdout).length,
    unique_labels: labelToId.size,
    labels_resolved: [...labelToId.values()].filter((v) => v !== null).length,
    per_source: perSource,
    resolve_rate: Object.fromEntries(
      Object.entries(perSource).map(([k, s]) => [k, s.total ? +(s.resolved / s.total).toFixed(3) : 0]),
    ),
  });
}

// ---------- stage 1f: resolve each skill to a Wikipedia article + Wikidata QID ----------

// Strict exact-title resolution only. MediaWiki fuzzy search returns unrelated popular articles
// (e.g. "manage musical staff" → "Matilda the Musical"), which poisons downstream. Skip those —
// better to have no Wiki match than a wrong one. Only ~40% of skills expected to resolve; that's fine.
// Cache: JSONL one line per skill. Resumable.
async function stage1fWikiResolve() {
  console.log("[stage 1f] resolving skills to Wikipedia articles (strict)…");
  const idx = loadSkillIndex();
  const allIds = [...idx.idSet];
  const titleByIdLocal = new Map<string, string>();
  {
    const tlines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
    for (let i = 1; i < tlines.length; i++) {
      const [id, title] = tlines[i].split("\t");
      if (id) titleByIdLocal.set(id, title || "");
    }
  }

  const cachePath = `${BUILD}/1f_wiki.jsonl`;
  const done = new Set<string>();
  try {
    const text = Deno.readTextFileSync(cachePath);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { done.add(JSON.parse(line).id); } catch { /* skip malformed */ }
    }
  } catch { /* fresh */ }
  const todo = allIds.filter((id) => !done.has(id));
  console.log(`[stage 1f] cache: ${done.size} resolved; ${todo.length} remaining`);
  if (todo.length === 0) {
    writeStats(111, { total_skills: allIds.length, resolved: done.size, remaining: 0 });
    return;
  }

  const fh = Deno.openSync(cachePath, { append: true, create: true, write: true });
  const enc = new TextEncoder();

  // Strategy: batch up to 50 titles per MW API call using action=query&titles=A|B|C
  // MediaWiki redirects resolved automatically. Only keep articles that exist (no page missing).
  // Also fetch pageprops.wikibase_item in same call.
  const BATCH = 50;
  const CONCURRENCY = 3; // polite
  const UA = "skill-tree/1.0 (research; https://github.com/)";
  const t0 = performance.now();
  let progress = 0, matched = 0, missed = 0, errors = 0;

  // Canonicalize a skill title into a plausible Wikipedia article title.
  // Capitalize first letter, replace dashes/underscores, trim.
  const toArticleTitle = (raw: string): string => {
    const s = raw.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s[0].toUpperCase() + s.slice(1);
  };

  async function fetchBatch(batch: string[]): Promise<Map<string, { wiki_title: string; pageid: number; qid?: string }>> {
    const titleToIds = new Map<string, string[]>();
    for (const id of batch) {
      const at = toArticleTitle(titleByIdLocal.get(id) || id.replace(/-/g, " "));
      if (!at) continue;
      const arr = titleToIds.get(at) ?? []; arr.push(id); titleToIds.set(at, arr);
    }
    const titles = [...titleToIds.keys()];
    if (titles.length === 0) return new Map();
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(titles.join("|"))}&origin=*`;
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-encoding": "gzip" } });
    if (!r.ok) {
      if (r.status === 429) await new Promise((res) => setTimeout(res, 2000));
      throw new Error(`http ${r.status}`);
    }
    const j = await r.json();
    const out = new Map<string, { wiki_title: string; pageid: number; qid?: string }>();

    // Build map from requested title (before redirect) → final pageid/title
    const normalizedMap = new Map<string, string>(); // requested → normalized
    for (const n of j.query?.normalized || []) normalizedMap.set(n.from, n.to);
    const redirectMap = new Map<string, string>(); // normalized → redirect target
    for (const r of j.query?.redirects || []) redirectMap.set(r.from, r.to);
    const pages = j.query?.pages || {};
    const titleToPage = new Map<string, { pageid: number; title: string; qid?: string; missing: boolean }>();
    for (const pid in pages) {
      const p = pages[pid];
      titleToPage.set(p.title, {
        pageid: p.pageid,
        title: p.title,
        qid: p.pageprops?.wikibase_item,
        missing: "missing" in p,
      });
    }

    for (const [requested, ids] of titleToIds) {
      const norm = normalizedMap.get(requested) || requested;
      const target = redirectMap.get(norm) || norm;
      const page = titleToPage.get(target);
      if (!page || page.missing || !page.pageid) continue;
      for (const id of ids) {
        out.set(id, { wiki_title: page.title, pageid: page.pageid, qid: page.qid });
      }
    }
    return out;
  }

  for (let start = 0; start < todo.length; start += BATCH * CONCURRENCY) {
    const group = todo.slice(start, start + BATCH * CONCURRENCY);
    const batches: string[][] = [];
    for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(async (b) => {
      try { return { batch: b, hits: await fetchBatch(b) }; }
      catch (_e) { errors++; return { batch: b, hits: new Map<string, { wiki_title: string; pageid: number; qid?: string }>() }; }
    }));
    for (const { batch, hits } of results) {
      for (const id of batch) {
        const h = hits.get(id);
        const rec = h
          ? { id, wiki_title: h.wiki_title, pageid: h.pageid, qid: h.qid, ts: Date.now() }
          : { id, ts: Date.now() };
        fh.writeSync(enc.encode(JSON.stringify(rec) + "\n"));
        if (h) matched++; else missed++;
      }
    }
    progress += group.length;
    if (progress % 500 < BATCH * CONCURRENCY || progress === todo.length) {
      const rate = progress / ((performance.now() - t0) / 1000);
      const eta = (todo.length - progress) / rate;
      console.log(`[stage 1f] ${progress}/${todo.length} (${rate.toFixed(0)}/s, eta ${(eta / 60).toFixed(1)} min, matched=${matched} missed=${missed} errors=${errors})`);
    }
  }
  fh.close();

  writeStats(111, {
    total_skills: allIds.length,
    previously_resolved: done.size,
    newly_processed: todo.length,
    matched_this_run: matched,
    missed_this_run: missed,
    errors_this_run: errors,
    resolve_rate: todo.length ? +(matched / todo.length).toFixed(3) : 0,
    seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 1j: LCSH broader-chain tree cache (B2) ----------
// Streams LCSH gzipped N-Triples; builds URI → { label, parents[] }; writes slug → ancestor_slugs[]
// so stage 7 can enrich topic chains without re-reading 95MB gz file every run.
async function stage1jLcshTree() {
  console.log("[stage 1j] building LCSH broader-chain cache…");
  const labels = new Map<string, string>(); // uri → prefLabel
  const parents = new Map<string, string[]>(); // uri → parent_uris
  const PREF = "http://www.w3.org/2004/02/skos/core#prefLabel";
  const BROADER = "http://www.w3.org/2004/02/skos/core#broader";
  const rxPref = /^<([^>]+)>\s+<[^>]+prefLabel>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/;
  const rxBroader = /^<([^>]+)>\s+<[^>]+broader>\s+<([^>]+)>\s*\.$/;
  let lines = 0;
  await streamLines(["sh", "-c", "gunzip -c data/lcsh/subjects.skosrdf.nt.gz"], (line) => {
    lines++;
    if (lines % 2000000 === 0) console.log(`  ${lines} lines, ${labels.size} labels, ${parents.size} with parents`);
    if (line.length < 60 || line[0] !== "<") return;
    if (line.includes(PREF)) {
      const m = rxPref.exec(line);
      if (m) {
        const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        // Reject noisy parenthesized forms and very long labels; keep human-readable subject headings
        if (lbl.length >= 2 && lbl.length <= 80 && !lbl.includes("--")) labels.set(m[1], lbl);
      }
    } else if (line.includes(BROADER)) {
      const m = rxBroader.exec(line);
      if (m) {
        const arr = parents.get(m[1]) ?? []; arr.push(m[2]); parents.set(m[1], arr);
      }
    }
  });
  console.log(`[stage 1j] parsed: ${labels.size} labels, ${parents.size} concepts with parents`);

  // Walk each concept's broader chain up to depth 4, collect ancestor labels (dedup, preserve order)
  const DEPTH = 4;
  const slugToAncestors = new Map<string, string[]>();
  for (const [uri, lbl] of labels) {
    const slug = slugify(lbl);
    if (!slug || slug.length > 80) continue;
    const seen = new Set<string>([uri]);
    const anc: string[] = [];
    let frontier = parents.get(uri) || [];
    for (let d = 0; d < DEPTH && frontier.length; d++) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pLbl = labels.get(p);
        if (pLbl) {
          const pSlug = slugify(pLbl);
          if (pSlug && pSlug !== slug && !anc.includes(pSlug)) anc.push(pSlug);
        }
        for (const pp of (parents.get(p) || [])) next.push(pp);
      }
      frontier = next;
    }
    if (anc.length) slugToAncestors.set(slug, anc.slice(0, 6));
  }
  console.log(`[stage 1j] slugs with ancestor chains: ${slugToAncestors.size}`);

  // Write cache: slug \t anc1,anc2,...
  const rows: string[] = [];
  for (const [slug, anc] of slugToAncestors) rows.push(`${slug}\t${anc.join(",")}`);
  Deno.writeTextFileSync(`${BUILD}/1j_lcsh_tree.tsv`, rows.join("\n") + "\n");
  writeStats(1113, {
    labels: labels.size,
    concepts_with_parents: parents.size,
    slugs_with_ancestors: slugToAncestors.size,
  });
}

// ---------- stage 1k: DBpedia SKOS broader tree cache (B3) ----------
// Turtle format: <subject> dcterms:subject/skos:broader <object> ; <subject> skos:prefLabel "..."@en
async function stage1kDbpediaTree() {
  console.log("[stage 1k] building DBpedia SKOS broader-chain cache…");
  const labels = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const PREF = "skos/core#prefLabel";
  const BROADER = "skos/core#broader";
  // N-triples format with full URIs (not Turtle prefixes)
  const rxPref = /^<([^>]+)>\s+<[^>]+prefLabel>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/;
  const rxBroader = /^<([^>]+)>\s+<[^>]+broader>\s+<([^>]+)>\s*\.$/;
  let lines = 0;
  await streamLines(["sh", "-c", "bzcat data/dbpedia/skos_categories_en.ttl.bz2"], (line) => {
    lines++;
    if (lines % 2000000 === 0) console.log(`  ${lines} lines, ${labels.size} labels`);
    if (line.length < 50) return;
    if (line.includes(PREF)) {
      const m = rxPref.exec(line);
      if (m) {
        const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (lbl.length >= 2 && lbl.length <= 80) labels.set(m[1], lbl);
      }
    } else if (line.includes(BROADER)) {
      const m = rxBroader.exec(line);
      if (m) {
        const arr = parents.get(m[1]) ?? []; arr.push(m[2]); parents.set(m[1], arr);
      }
    }
  });
  console.log(`[stage 1k] parsed: ${labels.size} labels, ${parents.size} with parents`);

  // Wikipedia-category pattern filter — kill junk during tree build
  const JUNK = /_by_country$|_by_region$|_by_type$|_by_year$|_introduced_in_|_established_in_|_disestablished_in_|_founded_in_|_born_in_|_died_in_|_set_in_|^Category:People_in_|_people$|_in_history$/i;
  const DEPTH = 3;
  const slugToAncestors = new Map<string, string[]>();
  for (const [uri, lbl] of labels) {
    if (JUNK.test(uri) || JUNK.test(lbl)) continue;
    const slug = slugify(lbl);
    if (!slug || slug.length > 80) continue;
    const seen = new Set<string>([uri]);
    const anc: string[] = [];
    let frontier = parents.get(uri) || [];
    for (let d = 0; d < DEPTH && frontier.length; d++) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (JUNK.test(p)) continue;
        const pLbl = labels.get(p);
        if (pLbl && !JUNK.test(pLbl)) {
          const pSlug = slugify(pLbl);
          if (pSlug && pSlug !== slug && !anc.includes(pSlug)) anc.push(pSlug);
        }
        for (const pp of (parents.get(p) || [])) next.push(pp);
      }
      frontier = next;
    }
    if (anc.length) slugToAncestors.set(slug, anc.slice(0, 5));
  }
  console.log(`[stage 1k] slugs with ancestor chains: ${slugToAncestors.size}`);
  // Stream-write to avoid OOM (1M+ rows join too large for single buffer)
  const outPath = `${BUILD}/1k_dbpedia_tree.tsv`;
  const fh = Deno.openSync(outPath, { create: true, write: true, truncate: true });
  const encOut = new TextEncoder();
  for (const [slug, anc] of slugToAncestors) {
    fh.writeSync(encOut.encode(`${slug}\t${anc.join(",")}\n`));
  }
  fh.close();
  writeStats(1114, {
    labels: labels.size,
    concepts_with_parents: parents.size,
    slugs_with_ancestors: slugToAncestors.size,
  });
}

// ---------- stage 1f2: fuzzy retry — altLabels + title variants (B1) ----------
async function stage1f2WikiRetry() {
  console.log("[stage 1f2] fuzzy retry for unmatched skills…");
  // Load current state of 1f cache
  const cachePath = `${BUILD}/1f_wiki.jsonl`;
  const resolved = new Map<string, { wiki_title?: string; qid?: string }>();
  try {
    const text = Deno.readTextFileSync(cachePath);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        resolved.set(d.id, { wiki_title: d.wiki_title, qid: d.qid });
      } catch { /* skip */ }
    }
  } catch { throw new Error("run stage 1f first"); }

  const idx = loadSkillIndex();
  const unmatched: string[] = [];
  for (const id of idx.idSet) {
    const r = resolved.get(id);
    if (!r || !r.wiki_title) unmatched.push(id);
  }
  console.log(`[stage 1f2] unmatched: ${unmatched.length} / ${idx.idSet.size}`);
  if (!unmatched.length) {
    writeStats(1112, { unmatched: 0, new_matches: 0 });
    return;
  }

  // Collect alternate labels per skill id
  const titleById = new Map<string, string>();
  const altsById = new Map<string, string[]>();
  {
    const tlines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
    const hdr = tlines[0].split("\t");
    const iDesc = hdr.indexOf("description");
    for (let i = 1; i < tlines.length; i++) {
      const c = tlines[i].split("\t");
      if (c[0]) titleById.set(c[0], c[1] || "");
      // Use first sentence of description as another candidate if short
      const desc = c[iDesc] || "";
      const firstSent = desc.split(/[.!?]\s/)[0];
      if (firstSent && firstSent.length < 60 && firstSent.length > 4) {
        const arr = altsById.get(c[0]) ?? []; arr.push(firstSent); altsById.set(c[0], arr);
      }
    }
  }

  // ESCO altLabels from source CSV
  try {
    const rows = parseCsv(Deno.readTextFileSync("data/esco/skills_en.csv"));
    const hdr = rows[0];
    const iLabel = hdr.indexOf("preferredLabel");
    const iAlt = hdr.indexOf("altLabels");
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const pref = (r[iLabel] || "").trim();
      const alt = (r[iAlt] || "").trim();
      if (!pref || !alt) continue;
      const id = slugify(pref);
      if (!idx.idSet.has(id)) continue;
      const labels = alt.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 2 && s.length < 80);
      if (!labels.length) continue;
      const arr = altsById.get(id) ?? []; for (const l of labels) arr.push(l); altsById.set(id, arr);
    }
  } catch { /* no esco */ }

  // Lightcast: already well-named, skip.
  // ONET: element name is already title. Try ESCO-style variant "X (computing)" strip: remove parenthetical
  for (const id of unmatched) {
    const t = titleById.get(id);
    if (!t) continue;
    const noParen = t.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (noParen && noParen !== t) {
      const arr = altsById.get(id) ?? []; arr.push(noParen); altsById.set(id, arr);
    }
    // Strip verb prefix for ESCO-style action skills
    const verbStripped = t.replace(/^(manage|perform|provide|ensure|apply|use|develop|maintain|implement|assess|evaluate)\s+/i, "").trim();
    if (verbStripped && verbStripped !== t && verbStripped.length > 4) {
      const arr = altsById.get(id) ?? []; arr.push(verbStripped); altsById.set(id, arr);
    }
  }

  const toArticleTitle = (raw: string): string => {
    const s = raw.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s[0].toUpperCase() + s.slice(1);
  };

  // Build queue: (id, [candidate titles]). Pass to batch-resolver.
  type Task = { id: string; cands: string[] };
  const tasks: Task[] = [];
  for (const id of unmatched) {
    const alts = altsById.get(id) ?? [];
    if (!alts.length) continue;
    const cands = [...new Set(alts.map(toArticleTitle).filter(Boolean))].slice(0, 3);
    if (cands.length) tasks.push({ id, cands });
  }
  console.log(`[stage 1f2] tasks with alt candidates: ${tasks.length}`);

  const BATCH = 50;
  const CONCURRENCY = 3;
  const UA = "skill-tree/1.0 (research)";
  const fh = Deno.openSync(cachePath, { append: true });
  const enc = new TextEncoder();
  const t0 = performance.now();
  let progress = 0, newMatches = 0, errors = 0;

  // Token overlap guard: matched article's title must share a significant token with our skill title
  const STOP = new Set(["the","a","an","of","to","for","in","on","and","or","with","at","by","from","as","is"]);
  const sigSet = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));

  async function resolveBatch(taskBatch: Task[]): Promise<Map<string, { title: string; pageid: number; qid?: string }>> {
    // Flatten candidate titles across tasks; dedupe
    const titleToTasks = new Map<string, string[]>();
    for (const t of taskBatch) {
      for (const c of t.cands) {
        const arr = titleToTasks.get(c) ?? []; arr.push(t.id); titleToTasks.set(c, arr);
      }
    }
    const titles = [...titleToTasks.keys()];
    if (!titles.length) return new Map();
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(titles.join("|"))}&origin=*`;
    const r = await fetch(url, { headers: { "user-agent": UA } });
    if (!r.ok) {
      if (r.status === 429) await new Promise((res) => setTimeout(res, 2000));
      throw new Error(`http ${r.status}`);
    }
    const j = await r.json();
    const normalizedMap = new Map<string, string>();
    for (const n of j.query?.normalized || []) normalizedMap.set(n.from, n.to);
    const redirectMap = new Map<string, string>();
    for (const rd of j.query?.redirects || []) redirectMap.set(rd.from, rd.to);
    const pages = j.query?.pages || {};
    const titleToPage = new Map<string, { pageid: number; title: string; qid?: string; missing: boolean }>();
    for (const pid in pages) {
      const p = pages[pid];
      titleToPage.set(p.title, {
        pageid: p.pageid,
        title: p.title,
        qid: p.pageprops?.wikibase_item,
        missing: "missing" in p,
      });
    }
    const hits = new Map<string, { title: string; pageid: number; qid?: string }>();
    for (const [requested, ids] of titleToTasks) {
      const norm = normalizedMap.get(requested) || requested;
      const target = redirectMap.get(norm) || norm;
      const page = titleToPage.get(target);
      if (!page || page.missing || !page.pageid) continue;
      // Token overlap guard: wiki article title must share a token with SKILL title (not candidate)
      for (const id of ids) {
        if (hits.has(id)) continue;
        const skillToks = sigSet(titleById.get(id) || id.replace(/-/g, " "));
        const wikiToks = sigSet(page.title);
        let overlap = 0;
        for (const tok of skillToks) if (wikiToks.has(tok)) overlap++;
        if (overlap === 0 && skillToks.size > 0) continue; // strict overlap guard
        hits.set(id, { title: page.title, pageid: page.pageid, qid: page.qid });
      }
    }
    return hits;
  }

  for (let start = 0; start < tasks.length; start += BATCH * CONCURRENCY) {
    const group = tasks.slice(start, start + BATCH * CONCURRENCY);
    const batches: Task[][] = [];
    for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(async (b) => {
      try { return await resolveBatch(b); }
      catch { errors++; return new Map<string, { title: string; pageid: number; qid?: string }>(); }
    }));
    for (const hits of results) {
      for (const [id, h] of hits) {
        fh.writeSync(enc.encode(JSON.stringify({ id, wiki_title: h.title, pageid: h.pageid, qid: h.qid, ts: Date.now(), via: "alt" }) + "\n"));
        newMatches++;
      }
    }
    progress += group.length;
    if (progress % 500 < BATCH * CONCURRENCY) {
      const rate = progress / ((performance.now() - t0) / 1000);
      console.log(`[stage 1f2] ${progress}/${tasks.length} (${rate.toFixed(0)}/s, new_matches=${newMatches}, errors=${errors})`);
    }
  }
  fh.close();
  writeStats(1112, {
    unmatched,
    tasks: tasks.length,
    new_matches: newMatches,
    errors,
    seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 1g: fetch Wikidata P279/P31 parent chains for resolved QIDs ----------

async function stage1gWdParents() {
  console.log("[stage 1g] fetching Wikidata parent chains…");
  const wiki: { id: string; qid?: string }[] = [];
  try {
    const text = Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { wiki.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch {
    throw new Error("stage 1f must run first");
  }
  const qids = new Set<string>();
  for (const w of wiki) if (w.qid) qids.add(w.qid);
  console.log(`[stage 1g] unique QIDs: ${qids.size}`);

  const cachePath = `${BUILD}/1g_wd_parents.jsonl`;
  const done = new Set<string>();
  try {
    const text = Deno.readTextFileSync(cachePath);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { done.add(JSON.parse(line).qid); } catch { /* skip */ }
    }
  } catch { /* fresh */ }
  const todo = [...qids].filter((q) => !done.has(q));
  console.log(`[stage 1g] remaining: ${todo.length}`);
  if (todo.length === 0) {
    writeStats(112, { total_qids: qids.size, resolved: done.size, remaining: 0 });
    return;
  }

  const fh = Deno.openSync(cachePath, { append: true, create: true, write: true });
  const enc = new TextEncoder();
  const CONCURRENCY = 4; // SPARQL endpoint rate-limits around 30 req/s; be polite
  const t0 = performance.now();

  // VALUES-batched SPARQL: ~30 QIDs per query. Transitive P279* closure up to 5 hops.
  const BATCH = 25;
  async function fetchBatch(batch: string[]): Promise<Map<string, string[]>> {
    const values = batch.map((q) => `wd:${q}`).join(" ");
    const query = `
      SELECT ?item ?parent WHERE {
        VALUES ?item { ${values} }
        ?item wdt:P279*|wdt:P31/wdt:P279* ?parent .
        FILTER(?parent != ?item)
      }
      LIMIT 5000
    `;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { "user-agent": "skill-tree/1.0 (research)", accept: "application/sparql-results+json" } });
    if (!r.ok) throw new Error(`sparql ${r.status}`);
    const j = await r.json();
    const out = new Map<string, string[]>();
    for (const b of batch) out.set(b, []);
    for (const row of j.results?.bindings || []) {
      const item = (row.item?.value || "").split("/").pop();
      const parent = (row.parent?.value || "").split("/").pop();
      if (!item || !parent || !out.has(item)) continue;
      out.get(item)!.push(parent);
    }
    return out;
  }

  let progress = 0;
  for (let start = 0; start < todo.length; start += BATCH * CONCURRENCY) {
    const group = todo.slice(start, start + BATCH * CONCURRENCY);
    const batches: string[][] = [];
    for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(async (b) => {
      try { return await fetchBatch(b); } catch (_e) { return new Map<string, string[]>(b.map((q) => [q, []])); }
    }));
    for (const m of results) {
      for (const [qid, parents] of m) {
        fh.writeSync(enc.encode(JSON.stringify({ qid, parents }) + "\n"));
      }
    }
    progress += group.length;
    const rate = progress / ((performance.now() - t0) / 1000);
    console.log(`[stage 1g] ${progress}/${todo.length} (${rate.toFixed(1)}/s)`);
  }
  fh.close();

  writeStats(112, {
    total_qids: qids.size,
    previously_resolved: done.size,
    processed_this_run: todo.length,
    seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 1h: Wikipedia lead-paragraph summaries for resolved articles ----------

async function stage1hWikiDescs() {
  console.log("[stage 1h] fetching Wikipedia summary lead paragraphs…");
  const wiki: { id: string; wiki_title?: string }[] = [];
  try {
    const text = Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { wiki.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch {
    throw new Error("stage 1f must run first");
  }
  const todo0 = wiki.filter((w) => w.wiki_title);

  const cachePath = `${BUILD}/1h_wiki_summaries.tsv`;
  const done = new Set<string>();
  try {
    const text = Deno.readTextFileSync(cachePath);
    for (const line of text.split("\n")) {
      if (!line) continue;
      const id = line.split("\t")[0];
      if (id) done.add(id);
    }
  } catch { /* fresh */ }
  const todo = todo0.filter((w) => !done.has(w.id));
  console.log(`[stage 1h] todo: ${todo.length} (cached ${done.size})`);
  if (todo.length === 0) {
    writeStats(113, { total_candidates: todo0.length, resolved: done.size, remaining: 0 });
    return;
  }

  const fh = Deno.openSync(cachePath, { append: true, create: true, write: true });
  const enc = new TextEncoder();
  const CONCURRENCY = 8;
  const t0 = performance.now();
  let progress = 0, got = 0, failed = 0;

  async function fetchOne(w: { id: string; wiki_title?: string }): Promise<{ id: string; extract: string }> {
    const title = w.wiki_title!;
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    try {
      const r = await fetch(url, { headers: { "user-agent": "skill-tree/1.0 (research)" } });
      if (!r.ok) return { id: w.id, extract: "" };
      const j = await r.json();
      return { id: w.id, extract: (j.extract || "").replace(/[\t\n\r]+/g, " ").slice(0, 2000) };
    } catch {
      return { id: w.id, extract: "" };
    }
  }

  for (let start = 0; start < todo.length; start += CONCURRENCY) {
    const batch = todo.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchOne));
    for (const r of results) {
      fh.writeSync(enc.encode(`${r.id}\t${r.extract}\n`));
      if (r.extract) got++; else failed++;
    }
    progress += batch.length;
    if (progress % 400 === 0 || progress === todo.length) {
      const rate = progress / ((performance.now() - t0) / 1000);
      const eta = (todo.length - progress) / rate;
      console.log(`[stage 1h] ${progress}/${todo.length} (${rate.toFixed(1)}/s, eta ${(eta / 60).toFixed(1)} min, got=${got} failed=${failed})`);
    }
  }
  fh.close();

  writeStats(113, {
    total_candidates: todo0.length,
    previously_resolved: done.size,
    processed_this_run: todo.length,
    got_extract: got,
    failed: failed,
    seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 1i: resolve Wikidata QID → English label ----------

async function stage1iQidLabels() {
  console.log("[stage 1i] fetching Wikidata labels for parent QIDs…");
  const qids = new Set<string>();
  try {
    const text = Deno.readTextFileSync(`${BUILD}/1g_wd_parents.jsonl`);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const d: { qid: string; parents: string[] } = JSON.parse(line);
        qids.add(d.qid);
        for (const p of d.parents) qids.add(p);
      } catch { /* skip */ }
    }
  } catch { throw new Error("stage 1g must run first"); }
  console.log(`[stage 1i] unique QIDs needing labels: ${qids.size}`);

  const cachePath = `${BUILD}/1i_qid_labels.tsv`;
  const done = new Set<string>();
  try {
    const text = Deno.readTextFileSync(cachePath);
    for (const line of text.split("\n")) {
      const [qid] = line.split("\t");
      if (qid) done.add(qid);
    }
  } catch { /* fresh */ }
  const todo = [...qids].filter((q) => !done.has(q));
  console.log(`[stage 1i] remaining: ${todo.length}`);
  if (todo.length === 0) {
    writeStats(114, { total_qids: qids.size, resolved: done.size, remaining: 0 });
    return;
  }

  const fh = Deno.openSync(cachePath, { append: true, create: true, write: true });
  const enc = new TextEncoder();
  const BATCH = 50;
  const CONCURRENCY = 3;
  const UA = "skill-tree/1.0 (research; https://github.com/)";
  const t0 = performance.now();
  let progress = 0, got = 0;

  async function fetchBatch(batch: string[]): Promise<Map<string, string>> {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${batch.join("|")}&props=labels&languages=en&origin=*`;
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-encoding": "gzip" } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = await r.json();
    const out = new Map<string, string>();
    for (const qid in j.entities || {}) {
      const label = j.entities[qid]?.labels?.en?.value;
      if (label) out.set(qid, label);
    }
    return out;
  }

  for (let start = 0; start < todo.length; start += BATCH * CONCURRENCY) {
    const group = todo.slice(start, start + BATCH * CONCURRENCY);
    const batches: string[][] = [];
    for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(async (b) => {
      try { return { b, hits: await fetchBatch(b) }; }
      catch { return { b, hits: new Map<string, string>() }; }
    }));
    for (const { b, hits } of results) {
      for (const qid of b) {
        const label = hits.get(qid) || "";
        fh.writeSync(enc.encode(`${qid}\t${label}\n`));
        if (label) got++;
      }
    }
    progress += group.length;
    if (progress % 600 < BATCH * CONCURRENCY || progress === todo.length) {
      const rate = progress / ((performance.now() - t0) / 1000);
      const eta = (todo.length - progress) / rate;
      console.log(`[stage 1i] ${progress}/${todo.length} (${rate.toFixed(0)}/s, eta ${(eta / 60).toFixed(1)} min, got=${got})`);
    }
  }
  fh.close();

  writeStats(114, {
    total_qids: qids.size,
    previously_resolved: done.size,
    processed_this_run: todo.length,
    got_label: got,
    seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 8: eval suite — quality measures against ground truth + graph shape ----------

async function stage8Eval() {
  console.log("[stage 8] computing quality measures…");

  // Load final skills.tsv
  const sLines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
  type FRow = { id: string; title: string; difficulty: number; prereqs: string[]; topics: string[]; occupations: string[] };
  const rows: FRow[] = sLines.slice(1).map((l) => {
    const c = l.split("\t");
    return {
      id: c[0], title: c[1], difficulty: Number(c[4]),
      prereqs: c[5] ? c[5].split(",").filter(Boolean) : [],
      occupations: c[6] ? c[6].split(",").filter(Boolean) : [],
      topics: c[7] ? c[7].split(",").filter(Boolean) : [],
    };
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  console.log(`[stage 8] loaded ${rows.length} skills`);

  // Edge set (normalized: prereq → skill direction; "src has prereq dst"? no: skill prereqs[] contains prereq ids)
  // An edge prereq → skill means prereq comes BEFORE skill.
  const edgePair = new Set<string>();
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const r of rows) {
    for (const p of r.prereqs) {
      edgePair.add(`${p}→${r.id}`);
      outDeg.set(p, (outDeg.get(p) ?? 0) + 1);
      inDeg.set(r.id, (inDeg.get(r.id) ?? 0) + 1);
    }
  }
  const edges = [...edgePair];
  console.log(`[stage 8] ${edges.length} edges`);

  // Apply alias if present so seed-edge endpoint ids resolve
  const alias = new Map<string, string>();
  try {
    const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    for (let i = 1; i < aliasLines.length; i++) {
      const [d, c] = aliasLines[i].split("\t");
      alias.set(d, c);
    }
  } catch { /* none */ }
  const canon = (id: string) => alias.get(id) ?? id;

  const results: Record<string, unknown> = {};

  // ---- 1-3. Ground-truth precision/recall from held-out seed edges ----
  {
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
    const bySrc: Record<string, { total: number; matched: number }> = {};
    for (const line of seedLines) {
      const c = line.split("\t");
      const src = canon(c[0]), dst = canon(c[1]), src_tag = c[2], holdout = c[4] === "1";
      if (!holdout) continue;
      const group = src_tag.startsWith("alcpl_") ? "alcpl"
        : src_tag.startsWith("moocx_") ? "moocx"
        : src_tag === "opensalt_grade" ? "opensalt_grade"
        : src_tag;
      bySrc[group] ??= { total: 0, matched: 0 };
      bySrc[group].total++;
      if (edgePair.has(`${src}→${dst}`)) bySrc[group].matched++;
    }
    // Precision not computable without negative samples; just report recall on held-out.
    results.holdout_recall = Object.fromEntries(
      Object.entries(bySrc).map(([k, v]) => [k, { recall: v.total ? +(v.matched / v.total).toFixed(3) : 0, matched: v.matched, total: v.total }]),
    );
  }

  // ---- 4. Khan ordering Kendall-τ ----
  {
    const khan = Deno.readTextFileSync("data/khanacademy/khandata.tsv").split("\n").filter((l) => l.length);
    const h = khan[0].split("\t");
    const iName = h.indexOf("Data Name"), iHPos = h.indexOf("H-Position"), iDisp = h.indexOf("Display Name");
    type Kr = { name: string; hpos: number; display: string };
    const khanRows: Kr[] = [];
    for (let i = 1; i < khan.length; i++) {
      const c = khan[i].split("\t");
      const hp = Number(c[iHPos]);
      if (!c[iName] || !Number.isFinite(hp)) continue;
      khanRows.push({ name: c[iName].trim(), hpos: hp, display: (c[iDisp] || "").trim() });
    }
    // Try to resolve to our ids: exact slug, then display slug
    const resolved: { diff: number; hpos: number }[] = [];
    for (const k of khanRows) {
      const cand1 = k.name;
      const cand2 = slugify(k.display);
      const id = byId.has(cand1) ? cand1 : byId.has(cand2) ? cand2 : null;
      if (!id) continue;
      const r = byId.get(id)!;
      resolved.push({ diff: r.difficulty, hpos: k.hpos });
    }
    results.khan_tau = {
      resolved_count: resolved.length,
      kendall_tau: resolved.length > 5 ? kendallTau(resolved.map((r) => r.hpos), resolved.map((r) => r.diff)) : null,
    };
  }

  // ---- 7. Depth distribution via topological sort (longest path from roots) ----
  {
    const depth = new Map<string, number>();
    // Topo sort: for each skill, depth = max(prereq.depth) + 1
    const order: string[] = [...byId.keys()].sort((a, b) => (byId.get(a)!.difficulty) - (byId.get(b)!.difficulty));
    let maxD = 0;
    for (const id of order) {
      const r = byId.get(id)!;
      let d = 0;
      for (const p of r.prereqs) {
        const pd = depth.get(p) ?? 0;
        if (pd + 1 > d) d = pd + 1;
      }
      depth.set(id, d);
      if (d > maxD) maxD = d;
    }
    const depths = [...depth.values()];
    results.depth_distribution = {
      p50: pct(depths, 0.50),
      p95: pct(depths, 0.95),
      max: Math.max(...depths, 0),
    };
  }

  // ---- 8. Branching factor histogram ----
  {
    const inVals = [...inDeg.values()], outVals = [...outDeg.values()];
    results.branching = {
      in_degree: { p50: pct(inVals, 0.50), p95: pct(inVals, 0.95), max: Math.max(...inVals, 0) },
      out_degree: { p50: pct(outVals, 0.50), p95: pct(outVals, 0.95), max: Math.max(...outVals, 0) },
      top_out_degree: [...outDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([id, n]) => [id, n, byId.get(id)?.title?.slice(0, 60)]),
    };
  }

  // ---- 9. Reachability from roots ----
  {
    const roots = rows.filter((r) => r.prereqs.length === 0).map((r) => r.id);
    const children = new Map<string, string[]>();
    for (const r of rows) for (const p of r.prereqs) {
      const arr = children.get(p) ?? []; arr.push(r.id); children.set(p, arr);
    }
    const visited = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of children.get(u) ?? []) if (!visited.has(v)) { visited.add(v); queue.push(v); }
    }
    results.reachability = { roots: roots.length, reachable: visited.size, total: rows.length, pct: +(visited.size / rows.length).toFixed(3) };
  }

  // ---- 10. Cycle assertion ----
  {
    // Kahn's-like: repeatedly remove zero-in-degree nodes; any remaining → cycle.
    const inD = new Map<string, number>();
    for (const r of rows) inD.set(r.id, r.prereqs.length);
    const queue: string[] = [];
    for (const [id, n] of inD) if (n === 0) queue.push(id);
    const children = new Map<string, string[]>();
    for (const r of rows) for (const p of r.prereqs) {
      const arr = children.get(p) ?? []; arr.push(r.id); children.set(p, arr);
    }
    let removed = 0;
    while (queue.length) {
      const u = queue.shift()!; removed++;
      for (const v of children.get(u) ?? []) {
        inD.set(v, (inD.get(v) ?? 0) - 1);
        if (inD.get(v) === 0) queue.push(v);
      }
    }
    results.cycles = { dag: removed === rows.length, leftover_after_kahn: rows.length - removed };
  }

  // ---- 11. Topic frequency — flag framework-origin labels ----
  {
    const topicFreq = new Map<string, number>();
    for (const r of rows) for (const t of r.topics) topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
    const top = [...topicFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const frameworkish = top.filter(([t]) => /-standards|-20\d\d|sced|content-khan|ccss|ngss|next-generation/.test(t));
    results.topics = {
      unique: topicFreq.size,
      top_20: top,
      framework_in_top_20: frameworkish.length,
      framework_ids: frameworkish.map(([t]) => t),
    };
  }

  // ---- 13. Tag entropy per skill (average) ----
  {
    const occFreq = new Map<string, number>();
    const topicFreq2 = new Map<string, number>();
    for (const r of rows) {
      for (const o of r.occupations) occFreq.set(o, (occFreq.get(o) ?? 0) + 1);
      for (const t of r.topics) topicFreq2.set(t, (topicFreq2.get(t) ?? 0) + 1);
    }
    // IDF-like: rarer tag = higher information
    const total = rows.length;
    const idf = (f: number) => Math.log(total / Math.max(f, 1));
    let occH = 0, topH = 0, nOcc = 0, nTop = 0;
    for (const r of rows) {
      for (const o of r.occupations) { occH += idf(occFreq.get(o) ?? 1); nOcc++; }
      for (const t of r.topics) { topH += idf(topicFreq2.get(t) ?? 1); nTop++; }
    }
    results.tag_information = {
      occ_avg_idf: nOcc ? +(occH / nOcc).toFixed(3) : 0,
      topic_avg_idf: nTop ? +(topH / nTop).toFixed(3) : 0,
    };
  }

  // ---- 14. Wikipedia coverage ----
  {
    let matched = 0;
    try {
      const text = Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`);
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { if (JSON.parse(line).wiki_title) matched++; } catch { /* skip */ }
      }
    } catch { /* no 1f */ }
    results.wiki_coverage = { total_skills: rows.length, wiki_matched: matched, pct: rows.length ? +(matched / rows.length).toFixed(3) : 0 };
  }

  // ---- 15. Orphan breakdown ----
  {
    const orphans = rows.filter((r) => r.prereqs.length === 0);
    const wiki = new Set<string>();
    try {
      const text = Deno.readTextFileSync(`${BUILD}/1f_wiki.jsonl`);
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { const d = JSON.parse(line); if (d.wiki_title) wiki.add(d.id); } catch { /* skip */ }
      }
    } catch { /* skip */ }
    let withWiki = 0, withoutWiki = 0;
    for (const o of orphans) (wiki.has(o.id) ? withWiki++ : withoutWiki++);
    results.orphan_breakdown = {
      total_orphans: orphans.length,
      with_wiki: withWiki,
      without_wiki: withoutWiki,
      orphan_rate: +(orphans.length / rows.length).toFixed(4),
    };
  }

  // ---- 15b. Precision eval via Apfel (E2) — sample N inferred edges, LLM-judges plausibility ----
  {
    const N_SAMPLE = Number(Deno.env.get("PRECISION_SAMPLE") ?? "0"); // set to 200+ to enable
    const ENDPOINT = Deno.env.get("APFEL_ENDPOINT") ?? "http://127.0.0.1:11435/v1/chat/completions";
    if (N_SAMPLE > 0) {
      // Resume from cache if present
      const cachePath = `${BUILD}/8_precision_cache.tsv`;
      const cache = new Map<string, { verdict: string; reason: string }>();
      try {
        for (const line of Deno.readTextFileSync(cachePath).split("\n")) {
          if (!line) continue;
          const c = line.split("\t");
          cache.set(`${c[0]}→${c[1]}`, { verdict: c[2], reason: c[3] || "" });
        }
      } catch { /* fresh */ }
      // Deterministic sample
      const allEdges = edges.slice();
      const sampleStep = Math.max(1, Math.floor(allEdges.length / N_SAMPLE));
      const sampled: string[] = [];
      for (let i = 0; i < allEdges.length; i += sampleStep) sampled.push(allEdges[i]);
      const todo = sampled.filter((e) => !cache.has(e));
      console.log(`[stage 8 precision] sampled ${sampled.length}, cached ${sampled.length - todo.length}, to run ${todo.length}`);
      const fh = Deno.openSync(cachePath, { append: true, create: true, write: true });
      const enc = new TextEncoder();
      async function judge(edgeKey: string): Promise<{ verdict: string; reason: string }> {
        const [src, dst] = edgeKey.split("→");
        const s = byId.get(src), d = byId.get(dst);
        if (!s || !d) return { verdict: "skip", reason: "missing skill" };
        const prompt = `Judge whether learning skill A is a reasonable prerequisite for learning skill B.

A: ${s.title}
B: ${d.title}

Reply with exactly one of: YES (A is a plausible prerequisite of B), NO (A is not a prerequisite of B), or UNRELATED (A and B aren't in related domains).`;
        const res = await fetch(ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "apple-foundationmodel",
            messages: [{ role: "user", content: prompt }],
            temperature: 0, max_tokens: 20,
          }),
        });
        if (!res.ok) throw new Error(`apfel ${res.status}`);
        const j = await res.json();
        const reply = (j.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
        const verdict = reply.startsWith("YES") ? "yes"
          : reply.startsWith("UNRELATED") ? "unrelated"
          : reply.startsWith("NO") ? "no"
          : "unclear";
        return { verdict, reason: reply.slice(0, 80).replace(/[\t\n\r]/g, " ") };
      }
      const CONCURRENCY = 8;
      const queue = [...todo];
      let done = 0, errors = 0;
      async function worker() {
        while (queue.length) {
          const e = queue.shift();
          if (!e) return;
          try {
            const v = await judge(e);
            cache.set(e, v);
            const [src, dst] = e.split("→");
            fh.writeSync(enc.encode(`${src}\t${dst}\t${v.verdict}\t${v.reason}\n`));
            done++;
            if (done % 50 === 0) console.log(`[stage 8 precision] ${done}/${todo.length}`);
          } catch { errors++; }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      fh.close();
      // Compute precision = yes / (yes + no + unrelated). "unclear" excluded.
      let yes = 0, no = 0, unrelated = 0, unclear = 0;
      for (const e of sampled) {
        const v = cache.get(e);
        if (!v) continue;
        if (v.verdict === "yes") yes++;
        else if (v.verdict === "no") no++;
        else if (v.verdict === "unrelated") unrelated++;
        else unclear++;
      }
      const denom = yes + no + unrelated;
      results.precision_eval = {
        sampled: sampled.length,
        yes, no, unrelated, unclear,
        precision: denom ? +(yes / denom).toFixed(3) : 0,
        errors,
      };
    }
  }

  // ---- 16. Source attribution — per-source edge counts + per-edge dump (E3) ----
  {
    const seedEdges = new Set<string>();
    try {
      const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
      for (const line of seedLines) {
        const c = line.split("\t");
        if (c[4] === "1") continue;
        seedEdges.add(`${canon(c[0])}→${canon(c[1])}`);
      }
    } catch { /* skip */ }
    // Load raw LLM inferences from stage 5 to attribute "inferred" vs "heuristic" edges
    const inferred = new Set<string>();
    try {
      const prereqLines = Deno.readTextFileSync(`${BUILD}/5_prereqs.tsv`).split("\n").filter((l) => l.length);
      const pick = new Map<string, string>();
      for (const line of prereqLines) {
        const tab = line.indexOf("\t");
        pick.set(line.slice(0, tab), line.slice(tab + 1));
      }
      for (const [id, resp] of pick) {
        if (!resp || resp === "none") continue;
        for (const pid of resp.split(",")) if (pid) inferred.add(`${canon(pid)}→${canon(id)}`);
      }
    } catch { /* skip */ }
    let seed = 0, inf = 0, heuristic = 0;
    const sourceMap = new Map<string, string>();
    for (const e of edges) {
      const src = seedEdges.has(e) ? "seed" : inferred.has(e) ? "inferred" : "heuristic";
      sourceMap.set(e, src);
      if (src === "seed") seed++; else if (src === "inferred") inf++; else heuristic++;
    }
    // Dump: build/8_edge_sources.tsv
    const dumpLines = ["skill_id\tprereq_id\tsource"];
    for (const r of rows) for (const p of r.prereqs) {
      const src = sourceMap.get(`${p}→${r.id}`) ?? "unknown";
      dumpLines.push(`${r.id}\t${p}\t${src}`);
    }
    Deno.writeTextFileSync(`${BUILD}/8_edge_sources.tsv`, dumpLines.join("\n") + "\n");
    results.source_attribution = {
      seed_edges_in_final: seed, inferred_edges: inf, heuristic_edges: heuristic,
      total: edges.length,
    };
  }

  // ---- 18. Cross-domain leakage (topic Jaccard on edges) ----
  {
    const samples = Math.min(edges.length, 5000);
    // Deterministic sample
    const stepSize = Math.max(1, Math.floor(edges.length / samples));
    const jacs: number[] = [];
    for (let i = 0; i < edges.length; i += stepSize) {
      const [src, dst] = edges[i].split("→");
      const s = byId.get(src), d = byId.get(dst);
      if (!s || !d) continue;
      const a = new Set(s.topics), b = new Set(d.topics);
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      jacs.push(inter / (a.size + b.size - inter));
    }
    results.domain_leakage = {
      sampled: jacs.length,
      p10: pct(jacs, 0.10), p50: pct(jacs, 0.50), p90: pct(jacs, 0.90),
      mean: jacs.length ? +(jacs.reduce((a, b) => a + b, 0) / jacs.length).toFixed(3) : 0,
    };
  }

  writeStats(8, results);
}

function kendallTau(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = Math.sign(x[i] - x[j]);
      const b = Math.sign(y[i] - y[j]);
      if (a === 0 || b === 0) continue;
      if (a === b) concordant++; else discordant++;
    }
  }
  const total = concordant + discordant;
  return total ? +((concordant - discordant) / total).toFixed(3) : 0;
}

// ---------- dispatch ----------

const stages: Record<string, () => void | Promise<void>> = {
  list: stage1List,
  infill: stage1bInfill,
  summarize: stage1cSummarize,
  "onet-desc": stage1dOnetDesc,
  "seed-edges": stage1eSeedEdges,
  "wiki-resolve": stage1fWikiResolve,
  "wiki-retry": stage1f2WikiRetry,
  "lcsh-tree": stage1jLcshTree,
  "dbpedia-tree": stage1kDbpediaTree,
  "wd-parents": stage1gWdParents,
  "wiki-descs": stage1hWikiDescs,
  "qid-labels": stage1iQidLabels,
  embed: stage2Embed,
  tag: stage3Tag,
  dedupe: stage3bDedupe,
  difficulty: stage4Difficulty,
  prereq: stage5Prereq,
  "prereq-ollama": stage5OllamaPrereq,
  "prereq-apfel": stage5ApfelPrereq,
  "summarize-apfel": stage1cApfelSummarize,
  "infill-apfel": stage1bApfelInfill,
  "infill-apfel-all": stage1bApfelInfillAll,
  postproc: stage6PostProc,
  finalize: stage7Finalize,
  eval: stage8Eval,
};

const arg = Deno.args[0];
if (arg) {
  const fn = stages[arg];
  if (!fn) throw new Error(`unknown stage: ${arg}. known: ${Object.keys(stages).join(", ")}`);
  await fn();
} else {
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n=== ${name} ===`);
    await fn();
  }
}
