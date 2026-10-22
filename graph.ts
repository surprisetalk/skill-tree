import {
  BUILD,
  CACHE_PATH,
  col,
  EMBED_DIM,
  embedBatch,
  gradeToDifficulty,
  isJunkTopic,
  LIST_HEADER,
  need,
  normalize,
  normalizedEmbeddingsForSkills,
  readCsv,
  readRows,
  readSeeds,
  readTagged,
  readTree,
  readTsv,
  resolveConcept,
  SIG_STOP,
  skillIndex,
  slugify,
  STOPWORDS,
  stronglyConnected,
  TAGGED,
  Tagged,
  TAGGED_HEADER,
  TOPIC_REFS,
  writeStats,
} from "./lib.ts";

// ---------- stage embed ----------

function buildEmbedContent(title: string, desc: string, tags: string): string {
  // nomic-embed-text returns a constant-ish vector for short inputs (confirmed via Ollama API).
  // Pad short content with the tag breadcrumb so the pooling has enough tokens to differentiate.
  const base = desc ? `${title}\n${desc}` : title;
  if (base.length >= 40) return base;
  const tagHint = tags ? tags.replace(/,/g, " ").slice(0, 300) : "";
  return tagHint
    ? `${base}. ${tagHint}`
    : `${base}. Skill: ${title}. ${title}.`;
}

function paddedEmbedContent(title: string, desc: string, tags: string): string {
  const tagHint = tags ? tags.replace(/,/g, " ").slice(0, 400) : "";
  const d = desc ? ` ${desc}` : "";
  return `Skill: ${title}.${d} Context: ${tagHint || title}. Topic: ${title}.`;
}

function embedSignature(v: Float32Array): string {
  let s = "";
  for (let k = 0; k < 16; k++) s += v[k].toFixed(3) + ",";
  return s;
}

export async function stageEmbed() {
  const skills = readRows(`${BUILD}/1_skills.tsv`, LIST_HEADER).map((
    [id, title, description, , tags],
  ) => ({
    id,
    title,
    description,
    tags,
    content: buildEmbedContent(title, description, tags),
  }));
  console.log(`[embed] ${skills.length} skills`);

  const t0 = performance.now();
  const vecs = await embedBatch(skills.map((s) => s.content), "embed");

  // Duplicate-vector detection: nomic-embed-text collapses short inputs to near-identical vectors.
  // Group by 16-float signature, re-embed groups with >5 members using padded content.
  const bucket = new Map<string, number[]>();
  for (let i = 0; i < vecs.length; i++) {
    const sig = embedSignature(vecs[i]);
    const arr = bucket.get(sig);
    if (arr) arr.push(i);
    else bucket.set(sig, [i]);
  }
  const dupGroupsInitial = [...bucket.values()].filter((idxs) =>
    idxs.length > 5
  );
  console.log(
    `[embed] ${dupGroupsInitial.length} duplicate-vector groups before retry`,
  );

  let retried = 0;
  if (dupGroupsInitial.length > 0) {
    const retryIdxs: number[] = [];
    const retryContents: string[] = [];
    for (const idxs of dupGroupsInitial) {
      for (const i of idxs) {
        retryIdxs.push(i);
        retryContents.push(
          paddedEmbedContent(
            skills[i].title,
            skills[i].description,
            skills[i].tags,
          ),
        );
      }
    }
    const retriedVecs = await embedBatch(retryContents, "embed-retry");
    for (let k = 0; k < retryIdxs.length; k++) {
      vecs[retryIdxs[k]] = retriedVecs[k];
    }
    retried = retryIdxs.length;
  }

  // Post-retry scan — anything still in a large duplicate group is pathological.
  bucket.clear();
  for (let i = 0; i < vecs.length; i++) {
    const sig = embedSignature(vecs[i]);
    const arr = bucket.get(sig);
    if (arr) arr.push(i);
    else bucket.set(sig, [i]);
  }
  const dupGroupsFinal = [...bucket.values()].filter((idxs) => idxs.length > 5);
  const pathological: string[] = [];
  for (const idxs of dupGroupsFinal) {
    for (const i of idxs) pathological.push(skills[i].id);
  }
  Deno.writeTextFileSync(
    `${BUILD}/2_pathological.tsv`,
    pathological.length ? pathological.join("\n") + "\n" : "",
  );
  console.log(
    `[embed] ${dupGroupsFinal.length} duplicate-vector groups after retry; ${pathological.length} pathological skills`,
  );

  const bin = new Float32Array(skills.length * EMBED_DIM);
  let nans = 0;
  for (let i = 0; i < skills.length; i++) {
    const v = vecs[i];
    for (let j = 0; j < EMBED_DIM; j++) if (!Number.isFinite(v[j])) nans++;
    bin.set(v, i * EMBED_DIM);
  }
  if (nans > 0) {
    throw new Error(
      `embed: expected finite vectors, received ${nans} NaN/Inf values. Delete ${CACHE_PATH} and rerun: deno run -A pipeline.ts embed`,
    );
  }
  Deno.writeFileSync(`${BUILD}/2_embeddings.bin`, new Uint8Array(bin.buffer));
  Deno.writeTextFileSync(
    `${BUILD}/2_ids.tsv`,
    skills.map((s) => s.id).join("\n") + "\n",
  );
  console.log(
    `[embed] ${skills.length} vectors, ${retried} re-embedded, in ${
      ((performance.now() - t0) / 1000).toFixed(0)
    }s`,
  );
}

// ---------- stage tag ----------

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
  const esco = readCsv("data/esco/occupations_en.csv");
  const el = col(esco, "preferredLabel", "data/esco/occupations_en.csv"),
    ed = col(esco, "description", "data/esco/occupations_en.csv");
  for (let i = 1; i < esco.length; i++) {
    push(esco[i][el] || "", esco[i][ed] || "");
  }
  const onet = readTsv("data/onet/Occupation Data.txt");
  const ot = col(onet, "Title", "data/onet/Occupation Data.txt"),
    od = col(onet, "Description", "data/onet/Occupation Data.txt");
  for (let i = 1; i < onet.length; i++) {
    push(onet[i][ot] || "", onet[i][od] || "");
  }
  console.log(`[tag] occupation refs: ${refs.length}`);
  return refs;
}

// Drop geographic/temporal/biographical categories — they provide zero signal for skills
// and cause false positives like polyline → "railway-lines-in-europe".
const TOPIC_BADCAT2 =
  /(\b(in|of|from|by|for)\b\s+(Europe|Asia|Africa|America|Oceania|Antarctica|England|France|Germany|China|Japan|India|Russia|USSR|USA|Britain|Scotland|Ireland|Italy|Spain|Canada|Australia|Mexico|Brazil|Argentina|Iran|Iraq|Egypt|Turkey|Greece))|(\bcentury|centuries|\bdecade|\b\d{4}s\b|\b\d{3,4}\s*(BC|AD|BCE|CE)\b)|(\bpeople\b|\bbiography|\bbiographies|\bdeaths\b|\bbirths\b|\bmarriage|\bfamily\b)|(\bdisasters|\bincidents|\baccidents|\bwars\b|\bbattles|\belections)|^(19|20)\d{2}s?\b|^\d{1,2}(st|nd|rd|th)\s*(century|millennium)/i;

function parseEscoSkillTopics(): Map<string, string[]> {
  const rows = readCsv("data/esco/broaderRelationsSkillPillar_en.csv");
  const iC = col(
      rows,
      "conceptLabel",
      "data/esco/broaderRelationsSkillPillar_en.csv",
    ),
    iCu = col(
      rows,
      "conceptUri",
      "data/esco/broaderRelationsSkillPillar_en.csv",
    ),
    iB = col(
      rows,
      "broaderLabel",
      "data/esco/broaderRelationsSkillPillar_en.csv",
    ),
    iBu = col(
      rows,
      "broaderUri",
      "data/esco/broaderRelationsSkillPillar_en.csv",
    );
  const label = new Map<string, string>(),
    parents = new Map<string, string[]>();
  for (let i = 1; i < rows.length; i++) {
    const cU = rows[i][iCu],
      cL = rows[i][iC],
      pU = rows[i][iBu],
      pL = rows[i][iB];
    if (cU && cL) label.set(cU, cL);
    if (pU && pL) label.set(pU, pL);
    if (cU && pU) {
      const arr = parents.get(cU) ?? [];
      arr.push(pU);
      parents.set(cU, arr);
    }
  }
  const GENERIC = new Set([
    "knowledge",
    "skill",
    "generic programmes and qualifications",
  ]);
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
        if (pl && !GENERIC.has(pl.toLowerCase()) && topics.indexOf(pl) < 0) {
          topics.push(pl);
        }
      }
      cursor = ps[0];
    }
    if (topics.length) out.set(slugify(lbl), topics);
  }
  return out;
}

// O*NET element id → element name.
function onetElementNames(): Map<string, string> {
  const path = "data/onet/Content Model Reference.txt";
  const rows = readTsv(path);
  const iE = col(rows, "Element ID", path),
    iN = col(rows, "Element Name", path);
  return new Map(rows.slice(1).map((r) => [r[iE], r[iN]]));
}

function parseOnetSkillOccupations(): Map<string, string[]> {
  const occTitles = new Map<string, string>();
  {
    const path = "data/onet/Occupation Data.txt";
    const rows = readTsv(path);
    const iC = col(rows, "O*NET-SOC Code", path), iT = col(rows, "Title", path);
    for (const r of rows.slice(1)) {
      if (r[iC] && r[iT]) occTitles.set(r[iC], r[iT]);
    }
  }
  const cmr = onetElementNames();
  const bySkill = new Map<string, Map<string, number>>();
  for (const fname of ["Skills.txt", "Knowledge.txt", "Abilities.txt"]) {
    const rows = readTsv(`data/onet/${fname}`);
    const iS = col(rows, "O*NET-SOC Code", `data/onet/${fname}`),
      iE = col(rows, "Element ID", `data/onet/${fname}`),
      iSc = col(rows, "Scale ID", `data/onet/${fname}`),
      iV = col(rows, "Data Value", `data/onet/${fname}`);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][iSc] !== "IM") continue;
      const name = cmr.get(rows[i][iE]);
      const occ = occTitles.get(rows[i][iS]);
      if (!name || !occ) continue;
      const v = Number(rows[i][iV]);
      if (!Number.isFinite(v)) continue;
      const key = slugify(name);
      let m = bySkill.get(key);
      if (!m) {
        m = new Map();
        bySkill.set(key, m);
      }
      m.set(occ, Math.max(m.get(occ) ?? 0, v));
    }
  }
  const out = new Map<string, string[]>();
  for (const [key, m] of bySkill) {
    out.set(
      key,
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k),
    );
  }
  return out;
}

function parseEscoSkillOccupations(): Map<string, string[]> {
  const rows = readCsv("data/esco/occupationSkillRelations_en.csv");
  const iO = col(
      rows,
      "occupationLabel",
      "data/esco/occupationSkillRelations_en.csv",
    ),
    iS = col(rows, "skillLabel", "data/esco/occupationSkillRelations_en.csv"),
    iT = col(rows, "relationType", "data/esco/occupationSkillRelations_en.csv");
  const m = new Map<string, Set<string>>();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][iT] !== "essential") continue;
    const slug = slugify(rows[i][iS] || "");
    const occ = rows[i][iO];
    if (!slug || !occ) continue;
    let s = m.get(slug);
    if (!s) {
      s = new Set();
      m.set(slug, s);
    }
    s.add(occ);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  return out;
}

export async function stageTag() {
  const skills = readRows(`${BUILD}/1_skills.tsv`, LIST_HEADER).map((
    [id, title, description, sources, tags],
  ) => ({ id, title, description, sources, tags }));
  const skillVecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));

  const occRefs = parseOccupationRefs();
  const topicRefs = Deno.readTextFileSync(need(TOPIC_REFS)).split("\n")
    .filter((l) => l.length).map((label) => ({ label, desc: "" }));
  // Retroactively filter topic refs by geographic/temporal patterns. Their embeddings are
  // already in the cache, so we keep them in-place but mark them as "poisoned" so they
  // are never matched.
  const topicPoisoned = new Uint8Array(topicRefs.length);
  let topicDropped = 0;
  for (let i = 0; i < topicRefs.length; i++) {
    if (TOPIC_BADCAT2.test(topicRefs[i].label)) {
      topicPoisoned[i] = 1;
      topicDropped++;
    }
  }
  console.log(
    `[tag] poisoned ${topicDropped}/${topicRefs.length} topic refs (geographic/temporal)`,
  );
  const occVecs = await embedBatch(occRefs.map((r) => r.label), "tag:occ");
  const topicVecs = await embedBatch(
    topicRefs.map((r) => r.label),
    "tag:topic",
  );

  const packNorm = (vecs: Float32Array[], refs: { label: string }[]) => {
    const buf = new Float32Array(vecs.length * EMBED_DIM);
    for (let i = 0; i < vecs.length; i++) {
      buf.set(normalize(vecs[i], `ref "${refs[i].label}"`), i * EMBED_DIM);
    }
    return buf;
  };
  const occMat = packNorm(occVecs, occRefs);
  const topicMat = packNorm(topicVecs, topicRefs);

  const OCC_K = 2;
  const TOPIC_K = 3;
  const OCC_TH = 0.60;
  const TOPIC_TH = 0.62;
  const IDF_MAX = 0.015;

  const TAG_STOP = new Set([
    ...STOPWORDS,
    "are",
    "these",
    "those",
    "their",
    "its",
    "into",
    "such",
    "than",
    "then",
    "also",
    "over",
    "under",
    "about",
    "above",
    "below",
    "between",
    "through",
    "during",
    "after",
    "before",
    "because",
    "while",
    "other",
    "which",
    "where",
    "when",
    "what",
    "each",
    "both",
    "some",
    "most",
    "many",
    "much",
    "more",
    "less",
    "only",
    "very",
    "just",
    "can",
    "should",
    "would",
    "could",
    "may",
    "might",
    "will",
    "shall",
    "does",
    "did",
    "done",
    "has",
    "have",
    "had",
  ]);
  const tokenize = (s: string): Set<string> => {
    const out = new Set<string>();
    const norm = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
      .filter(Boolean);
    for (const w of norm) {
      if (w.length < 4) continue;
      if (TAG_STOP.has(w)) continue;
      out.add(w);
      // singular/plural normalization: add stem without trailing s
      if (w.length >= 5 && w.endsWith("s") && !w.endsWith("ss")) {
        out.add(w.slice(0, -1));
      }
    }
    return out;
  };
  const skillToks = skills.map((s) => tokenize(`${s.title} ${s.description}`));
  // Build a corpus-frequency table so "common" words (line, data, system, device…) don't
  // satisfy the lexical guard on their own.
  const docFreq = new Map<string, number>();
  for (const toks of skillToks) {
    for (const t of toks) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const COMMON_CUTOFF = Math.max(500, Math.floor(skills.length * 0.01));
  const commonWord = (t: string): boolean =>
    (docFreq.get(t) ?? 0) > COMMON_CUTOFF;

  const oversamplePass = (
    refMat: Float32Array,
    refCount: number,
    refs: { label: string }[],
    keep: number,
    th: number,
    poisoned?: Uint8Array,
  ) => {
    const out: { idx: number; score: number }[][] = new Array(skills.length);
    const refHits = new Int32Array(refCount);
    const refToks = refs.map((r) => tokenize(r.label));
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * EMBED_DIM;
      const skToks = skillToks[i];
      const top: { idx: number; score: number }[] = [];
      for (let r = 0; r < refCount; r++) {
        if (poisoned && poisoned[r]) continue;
        let hits = 0;
        let rareHit = false;
        for (const t of refToks[r]) {
          if (!skToks.has(t)) continue;
          hits++;
          if (!commonWord(t)) rareHit = true;
        }
        if (!rareHit && hits < 2) continue;
        let s = 0;
        const rOff = r * EMBED_DIM;
        for (let d = 0; d < EMBED_DIM; d++) {
          s += skillVecs[sOff + d] * refMat[rOff + d];
        }
        if (s < th) continue;
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

  const pruneMask = (
    refHits: Int32Array,
    refs: { label: string }[],
    label: string,
  ): Uint8Array => {
    const maxHits = Math.floor(skills.length * IDF_MAX);
    const mask = new Uint8Array(refs.length);
    let dropped = 0;
    for (let r = 0; r < refs.length; r++) {
      if (refHits[r] > maxHits) dropped++;
      else mask[r] = 1;
    }
    console.log(
      `[tag] ${label}: pruned ${dropped}/${refs.length} refs (>${maxHits} hits)`,
    );
    return mask;
  };

  const OVERSAMPLE = 5;
  console.log(
    `[tag] matching ${skills.length}×${occRefs.length} occs`,
  );
  const occPass = oversamplePass(
    occMat,
    occRefs.length,
    occRefs,
    OCC_K * OVERSAMPLE,
    OCC_TH,
  );
  const occMask = pruneMask(occPass.refHits, occRefs, "occ");
  console.log(
    `[tag] matching ${skills.length}×${topicRefs.length} topics`,
  );
  const topicPass = oversamplePass(
    topicMat,
    topicRefs.length,
    topicRefs,
    TOPIC_K * OVERSAMPLE,
    TOPIC_TH,
    topicPoisoned,
  );
  const topicMask = pruneMask(topicPass.refHits, topicRefs, "topic");

  const directEsco = parseEscoSkillOccupations();
  const directOnet = parseOnetSkillOccupations();
  const directEscoTopics = parseEscoSkillTopics();
  const DIRECT_OCC_CAP = 3, DIRECT_TOPIC_CAP = 3;

  const MANAGER_RE =
    /-manager$|-manager-|-director$|-director-|-supervisor$|-supervisor-/;
  // A hex suffix marks an overflow-hashed ESCO title.
  const HEX_SUFFIX_RE = /-[a-f0-9]{6}$/;

  type Picked = { slug: string; score: number };
  const pickedOccs: Picked[][] = new Array(skills.length);
  const pickedTopics: Picked[][] = new Array(skills.length);

  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    // Khan and low-grade OpenSALT skills get no occupation.
    const grades: number[] = [];
    for (const m of s.tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    const maxGrade = grades.length ? Math.max(...grades) : -1;
    const khanSlug = /^khan-|-khan-|-khan$/.test(s.id) ||
      s.title.toLowerCase().startsWith("khan");
    const lowGradeOnly = maxGrade >= 0 && maxGrade <= 9 && // diff 9 = grade 8
      !s.sources.includes("onet") && !s.sources.includes("esco");
    const skipOccs = khanSlug || lowGradeOnly;

    let occs: Picked[] = skipOccs ? [] : occPass.out[i]
      .filter((r) => occMask[r.idx])
      .map((r) => ({ slug: slugify(occRefs[r.idx].label), score: r.score }))
      .filter((p) => p.slug && !HEX_SUFFIX_RE.test(p.slug))
      .filter((p) => !MANAGER_RE.test(p.slug) || p.score >= 0.95);
    {
      const seen = new Map<string, number>();
      for (const p of occs) {
        seen.set(p.slug, Math.max(seen.get(p.slug) ?? 0, p.score));
      }
      occs = [...seen.entries()].map(([slug, score]) => ({ slug, score }))
        .sort((a, b) => b.score - a.score).slice(0, OCC_K);
    }

    let topics: Picked[] = topicPass.out[i]
      .filter((r) => topicMask[r.idx])
      .map((r) => ({ slug: slugify(topicRefs[r.idx].label), score: r.score }))
      .filter((p) => !!p.slug);

    const wordCount = s.title.split(/\s+/).filter((w) => w.length > 1).length;
    if (wordCount <= 2) {
      const titleToks = new Set(
        slugify(s.title).split("-").filter((w) => w.length >= 4),
      );
      topics = topics.filter((p) => {
        for (const tok of p.slug.split("-")) {
          if (tok.length >= 4 && titleToks.has(tok)) return true;
        }
        return false;
      });
    }
    {
      const seen = new Map<string, number>();
      for (const p of topics) {
        seen.set(p.slug, Math.max(seen.get(p.slug) ?? 0, p.score));
      }
      topics = [...seen.entries()].map(([slug, score]) => ({ slug, score }))
        .sort((a, b) => b.score - a.score).slice(0, TOPIC_K);
    }

    if (s.sources.includes("esco") && !skipOccs) {
      const dOcc = directEsco.get(s.id);
      if (dOcc?.length) {
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map((o) => slugify(o))
          .filter((sl) => sl && !HEX_SUFFIX_RE.test(sl));
        const existing = new Set(occs.map((p) => p.slug));
        const merged: Picked[] = [
          ...direct.filter((sl) => !existing.has(sl)).map((sl) => ({
            slug: sl,
            score: 1.0,
          })),
          ...occs,
        ];
        occs = merged.slice(0, DIRECT_OCC_CAP);
      }
      const dTopic = directEscoTopics.get(s.id);
      if (dTopic?.length) {
        const direct = dTopic.slice(0, DIRECT_TOPIC_CAP).map((t) => slugify(t))
          .filter(Boolean);
        const existing = new Set(topics.map((p) => p.slug));
        const merged: Picked[] = [
          ...direct.filter((sl) => !existing.has(sl)).map((sl) => ({
            slug: sl,
            score: 1.0,
          })),
          ...topics,
        ];
        topics = merged.slice(0, DIRECT_TOPIC_CAP);
      }
    }
    if (s.sources.includes("onet") && !skipOccs) {
      const dOcc = directOnet.get(s.id);
      if (dOcc?.length) {
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map((o) => slugify(o))
          .filter((sl) => sl && !HEX_SUFFIX_RE.test(sl));
        const existing = new Set(occs.map((p) => p.slug));
        const merged: Picked[] = [
          ...direct.filter((sl) => !existing.has(sl)).map((sl) => ({
            slug: sl,
            score: 1.0,
          })),
          ...occs,
        ];
        occs = merged.slice(0, DIRECT_OCC_CAP);
      }
    }
    pickedOccs[i] = occs;
    pickedTopics[i] = topics;
  }

  const OCC_FREQ_CAP = 500;
  const occToSkills = new Map<string, { i: number; score: number }[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const p of pickedOccs[i]) {
      let arr = occToSkills.get(p.slug);
      if (!arr) {
        arr = [];
        occToSkills.set(p.slug, arr);
      }
      arr.push({ i, score: p.score });
    }
  }
  const freqDrops = new Map<number, Set<string>>();
  let freqCapped = 0;
  for (const [slug, arr] of occToSkills) {
    if (arr.length <= OCC_FREQ_CAP) continue;
    arr.sort((a, b) => b.score - a.score);
    for (let k = OCC_FREQ_CAP; k < arr.length; k++) {
      let set = freqDrops.get(arr[k].i);
      if (!set) {
        set = new Set();
        freqDrops.set(arr[k].i, set);
      }
      set.add(slug);
      freqCapped++;
    }
  }
  if (freqCapped > 0) {
    console.log(
      `[tag] occupation freq cap dropped ${freqCapped} assignments (cap=${OCC_FREQ_CAP})`,
    );
  }

  const rows: string[] = [
    "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
  ];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const dropSet = freqDrops.get(i);
    const occSlugs = pickedOccs[i].filter((p) => !(dropSet?.has(p.slug))).map((
      p,
    ) => p.slug);
    const topicSlugs = pickedTopics[i].map((p) => p.slug);
    rows.push(
      [
        s.id,
        s.title,
        s.description,
        s.sources,
        s.tags,
        occSlugs.join(","),
        topicSlugs.join(","),
      ].join("\t"),
    );
  }
  Deno.writeTextFileSync(`${BUILD}/3_tagged.tsv`, rows.join("\n") + "\n");
  // A stale deduped file would let later stages skip the new tags.
  try {
    Deno.removeSync(TAGGED);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

// ---------- stage dedupe ----------

export function stageDedupe() {
  const rows = readTagged(`${BUILD}/3_tagged.tsv`);
  const vecs = normalizedEmbeddingsForSkills(rows.map((r) => r.id));
  const DEDUPE_COSINE = 0.96;

  // Antonym/modifier pairs that must NOT be merged with each other.
  // When A and B share all other tokens but one is in one group and the other is in another,
  // we treat them as distinct concepts.
  const ANTONYM_GROUPS: string[][] = [
    ["theoretical", "practical", "applied"],
    [
      "commercial",
      "industrial",
      "residential",
      "military",
      "civil",
      "consumer",
    ],
    ["1d", "2d", "3d", "4d"],
    ["first", "second", "third", "fourth", "fifth"],
    ["introductory", "advanced", "intermediate", "beginner", "basic"],
    ["micro", "macro", "nano", "mini", "mega"],
    ["pre", "post", "anti", "pro", "non", "sub", "super"],
    ["internal", "external"],
    ["public", "private"],
    ["input", "output"],
    ["front", "back", "side", "top", "bottom"],
    ["positive", "negative", "neutral"],
    ["online", "offline"],
    ["qualitative", "quantitative"],
    ["domestic", "international", "foreign"],
    ["static", "dynamic"],
    ["manual", "automatic", "automated"],
    ["wired", "wireless"],
    ["analog", "digital"],
    ["primary", "secondary", "tertiary"],
    ["open", "closed"],
    ["augmented", "mixed", "virtual"],
    ["ac", "dc"],
    ["z", "c", "bash", "fish", "ksh", "zsh"],
  ];
  const antonymGroupOf = new Map<string, number>();
  ANTONYM_GROUPS.forEach((g, gi) =>
    g.forEach((w) => antonymGroupOf.set(w, gi))
  );
  const antonymClash = (titleA: string, titleB: string): boolean => {
    const tA = titleA.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const tB = titleB.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const groupsA = new Map<number, Set<string>>();
    const groupsB = new Map<number, Set<string>>();
    for (const t of tA) {
      const g = antonymGroupOf.get(t);
      if (g === undefined) continue;
      if (!groupsA.has(g)) groupsA.set(g, new Set());
      groupsA.get(g)!.add(t);
    }
    for (const t of tB) {
      const g = antonymGroupOf.get(t);
      if (g === undefined) continue;
      if (!groupsB.has(g)) groupsB.set(g, new Set());
      groupsB.get(g)!.add(t);
    }
    for (const [g, setA] of groupsA) {
      const setB = groupsB.get(g);
      if (!setB) continue;
      let sameWord = false;
      for (const w of setA) {
        if (setB.has(w)) {
          sameWord = true;
          break;
        }
      }
      if (!sameWord) return true; // different antonym word in same group
    }
    return false;
  };

  const sourceCount = (r: Tagged): number => {
    if (!r.sources) return 0;
    return r.sources.split(",").filter(Boolean).length;
  };

  const parent = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  // A strict token superset is a specialization (power-bi of power), not a duplicate.
  const titleTokSet = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    }
    return out;
  };
  function union(a: number, b: number): boolean {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    if (antonymClash(rows[ra].title, rows[rb].title)) return false;
    const sa = sourceCount(rows[ra]);
    const sb = sourceCount(rows[rb]);
    let keep: number;
    if (sa !== sb) keep = sa > sb ? ra : rb;
    else {
      // Subset-aware tiebreak: prefer the canonical whose tokens are NOT a strict subset.
      // Falls back to shortest title when neither is a proper subset.
      const tA = titleTokSet(rows[ra].title), tB = titleTokSet(rows[rb].title);
      let aSubsetB = tA.size > 0 && tA.size < tB.size;
      for (const t of tA) {
        if (!tB.has(t)) {
          aSubsetB = false;
          break;
        }
      }
      let bSubsetA = tB.size > 0 && tB.size < tA.size;
      for (const t of tB) {
        if (!tA.has(t)) {
          bSubsetA = false;
          break;
        }
      }
      if (aSubsetB && !bSubsetA) keep = rb;
      else if (bSubsetA && !aSubsetB) keep = ra;
      else keep = rows[ra].title.length <= rows[rb].title.length ? ra : rb;
    }
    parent[keep === ra ? rb : ra] = keep;
    return true;
  }

  // Token-sort signature merge
  const tokenSig = (title: string): string => {
    const toks = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(
      /\s+/,
    )
      .filter((w) => w.length >= 2 && !SIG_STOP.has(w))
      .filter((w) => w.length >= 3 || /[0-9]/.test(w));
    toks.sort();
    return toks.join(" ");
  };
  const sigBuckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const sig = tokenSig(rows[i].title);
    if (!sig) continue;
    const arr = sigBuckets.get(sig) ?? [];
    arr.push(i);
    sigBuckets.set(sig, arr);
  }
  let sigMerges = 0, sigBlocked = 0;
  for (const idxs of sigBuckets.values()) {
    if (idxs.length < 2) continue;
    for (let k = 1; k < idxs.length; k++) {
      if (union(idxs[0], idxs[k])) sigMerges++;
      else sigBlocked++;
    }
  }
  console.log(
    `[dedupe] token-sort merges: ${sigMerges} (blocked ${sigBlocked} antonym-clash)`,
  );

  // Topic-bucket merge with jaccard + cosine
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const topic = rows[i].topics.split(",")[0] || "_notopic";
    const arr = buckets.get(topic) ?? [];
    arr.push(i);
    buckets.set(topic, arr);
  }
  const wordSet = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (
        w.length >= 2 &&
        !/^(the|a|an|of|for|and|to|in|on|at|by|with|is|are|be|or)$/.test(w)
      ) out.add(w);
    }
    return out;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const JACCARD_MIN = 0.7;
  const wordSets = rows.map((r) => wordSet(r.title));
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    }
    return out;
  };
  const sigSets = rows.map((r) => sigTokens(r.title));

  let merged = 0, skippedHuge = 0, cosBlocked = 0;
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    if (idxs.length > 1500) {
      skippedHuge++;
      continue;
    }
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (jaccard(wordSets[idxs[a]], wordSets[idxs[b]]) < JACCARD_MIN) {
          continue;
        }
        const la = rows[idxs[a]].title.length, lb = rows[idxs[b]].title.length;
        if (Math.max(la, lb) / Math.max(1, Math.min(la, lb)) > 3) continue;
        const sa = sigSets[idxs[a]], sb = sigSets[idxs[b]];
        if (sa.size && sb.size) {
          let inter = 0;
          for (const t of sa) if (sb.has(t)) inter++;
          if (inter / Math.min(sa.size, sb.size) < 0.4) continue;
        }
        let sc = 0;
        const oa = idxs[a] * EMBED_DIM, ob = idxs[b] * EMBED_DIM;
        for (let d = 0; d < EMBED_DIM; d++) sc += vecs[oa + d] * vecs[ob + d];
        if (sc < DEDUPE_COSINE) continue;
        if (union(idxs[a], idxs[b])) merged++;
        else cosBlocked++;
      }
    }
  }
  console.log(
    `[dedupe] cosine+jaccard merges: ${merged} (blocked ${cosBlocked} antonym, skipped ${skippedHuge} oversize buckets)`,
  );

  const alias = new Map<string, string>();
  let survivors = 0, dropped = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    if (c === i) survivors++;
    else {
      alias.set(rows[i].id, rows[c].id);
      dropped++;
    }
  }
  console.log(`[dedupe] survivors=${survivors}, dropped=${dropped}`);

  const groupBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    const arr = groupBy.get(c) ?? [];
    arr.push(i);
    groupBy.set(c, arr);
  }
  type Canon = {
    idx: number;
    occs: string[];
    topics: string[];
    allTags: string[];
  };
  const canons: Canon[] = [];
  for (const [cIdx, gIdxs] of groupBy) {
    const canonical = rows[cIdx];
    const occs = new Set<string>(), topics = new Set<string>();
    const allTags = new Set<string>(canonical.tags.split(",").filter(Boolean));
    for (const i of gIdxs) {
      for (const o of rows[i].occupations.split(",").filter(Boolean)) {
        occs.add(o);
      }
      for (const t of rows[i].topics.split(",").filter(Boolean)) topics.add(t);
      for (const tg of rows[i].tags.split(",").filter(Boolean)) allTags.add(tg);
    }
    canons.push({
      idx: cIdx,
      occs: [...occs].slice(0, 3),
      topics: [...topics].slice(0, 3),
      allTags: [...allTags],
    });
  }

  // Backfill tags for untagged canonicals
  const BF_STOP = new Set([
    "a",
    "an",
    "the",
    "of",
    "to",
    "for",
    "in",
    "on",
    "and",
    "or",
    "with",
    "at",
    "by",
    "from",
    "as",
  ]);
  const titleToks = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter((w) => w.length >= 4 && !BF_STOP.has(w));
  const tokToCanons = new Map<string, number[]>();
  for (let k = 0; k < canons.length; k++) {
    for (const tok of titleToks(rows[canons[k].idx].title)) {
      const arr = tokToCanons.get(tok) ?? [];
      arr.push(k);
      tokToCanons.set(tok, arr);
    }
  }
  let bfTopics = 0, bfOccs = 0, bfLcsh = 0;
  const BF_SIM = 0.6;
  const BF_SIM_ZZ = 0.55;
  for (let k = 0; k < canons.length; k++) {
    const c = canons[k];
    const needTopics = c.topics.length === 0, needOccs = c.occs.length === 0;
    if (!needTopics && !needOccs) continue;
    const zeroZero = needTopics && needOccs;
    const threshold = zeroZero ? BF_SIM_ZZ : BF_SIM;
    const qTit = rows[c.idx].title;
    const qToks = titleToks(qTit);
    if (!qToks.length) continue;
    const pool = new Set<number>();
    for (const tok of qToks) {
      const arr = tokToCanons.get(tok);
      if (!arr || arr.length > 2000) continue;
      for (const i of arr) if (i !== k) pool.add(i);
    }
    if (!pool.size) continue;
    const qOff = c.idx * EMBED_DIM;
    const scored: [number, number][] = [];
    for (const i of pool) {
      const other = canons[i];
      if (
        needTopics && other.topics.length === 0 &&
        (!needOccs || other.occs.length === 0)
      ) continue;
      if (!needTopics && needOccs && other.occs.length === 0) continue;
      let sc = 0;
      const oOff = other.idx * EMBED_DIM;
      for (let d = 0; d < EMBED_DIM; d++) sc += vecs[qOff + d] * vecs[oOff + d];
      if (sc >= threshold) scored.push([i, sc]);
    }
    if (scored.length < 3) continue;
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, 10);
    const topicVotes = new Map<string, number>(),
      occVotes = new Map<string, number>();
    for (const [i, w] of top) {
      for (const t of canons[i].topics) {
        topicVotes.set(t, (topicVotes.get(t) ?? 0) + w);
      }
      for (const o of canons[i].occs) {
        occVotes.set(o, (occVotes.get(o) ?? 0) + w);
      }
    }
    const pickTop = (
      m: Map<string, number>,
      minV: number,
      cap: number,
    ): string[] =>
      [...m.entries()].filter(([, v]) => v >= minV).sort((a, b) => b[1] - a[1])
        .slice(0, cap).map(([k]) => k);
    const minW = 3 * threshold;
    if (needTopics) {
      const nt = pickTop(topicVotes, minW, 3);
      if (nt.length) {
        c.topics = nt;
        bfTopics++;
      }
    }
    if (needOccs) {
      const no = pickTop(occVotes, minW, 2);
      if (no.length) {
        c.occs = no;
        bfOccs++;
      }
    }
  }

  // Last-resort topic seed from LCSH / DBpedia ancestor trees
  const lcshTree = readTree(`${BUILD}/1j_lcsh_tree.tsv`);
  for (const [slug, anc] of readTree(`${BUILD}/1k_dbpedia_tree.tsv`)) {
    if (!lcshTree.has(slug)) lcshTree.set(slug, anc);
  }
  if (lcshTree.size > 0) {
    for (const c of canons) {
      if (c.topics.length > 0) continue;
      const r = rows[c.idx];
      for (const cand of [r.id, slugify(r.title)]) {
        const anc = lcshTree.get(cand);
        if (anc && anc.length) {
          // Filter before the slice, so junk cannot be the only topic.
          const clean = anc.filter((a) => !isJunkTopic(a));
          if (!clean.length) continue;
          c.topics = clean.slice(0, 3);
          bfLcsh++;
          break;
        }
      }
    }
  }
  console.log(
    `[dedupe] backfill: topics+=${bfTopics}, occs+=${bfOccs}, lcsh-topics+=${bfLcsh}`,
  );

  const outLines = [TAGGED_HEADER];
  for (const c of canons) {
    const r = rows[c.idx];
    outLines.push(
      [
        r.id,
        r.title,
        r.description,
        r.sources,
        c.allTags.join(","),
        c.occs.join(","),
        c.topics.join(","),
      ].join("\t"),
    );
  }
  Deno.writeTextFileSync(
    TAGGED,
    outLines.join("\n") + "\n",
  );

  const aliasLines = ["dropped_id\tcanonical_id"];
  for (const [drop, keep] of alias) aliasLines.push(`${drop}\t${keep}`);
  Deno.writeTextFileSync(
    `${BUILD}/3b_aliases.tsv`,
    aliasLines.join("\n") + "\n",
  );
}

// ---------- stage difficulty ----------

export function stageDifficulty() {
  const skills = readTagged();
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));

  const anchor = new Float32Array(skills.length);
  anchor.fill(Number.NaN);
  let gradeAnchored = 0, khanAnchored = 0;
  for (let i = 0; i < skills.length; i++) {
    const grades: number[] = [];
    for (const m of skills[i].tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (grades.length) {
      // The first grade that teaches it. A 3-12 span anchors at 3, not 12.
      anchor[i] = Math.min(...grades);
      gradeAnchored++;
    }
  }
  {
    const path = "data/khanacademy/khandata.tsv";
    const rows = readTsv(path);
    const iN = col(rows, "Data Name", path),
      iD = col(rows, "Display Name", path),
      iV = col(rows, "V-Position", path);
    const kidx = skillIndex(skills);
    const idToIdx = new Map(skills.map((s, i) => [s.id, i]));
    const labelsV: [string, number][] = [];
    let vMin = Infinity, vMax = -Infinity;
    for (const c of rows.slice(1)) {
      const v = Number(c[iV]);
      if (!Number.isFinite(v)) continue;
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
      if (c[iN]) labelsV.push([c[iN], v]);
      if (c[iD]) labelsV.push([c[iD], v]);
    }
    if (vMax > vMin) {
      const seen = new Set<string>();
      for (const [lbl, v] of labelsV) {
        const id = resolveConcept(lbl, kidx);
        if (!id || seen.has(id)) continue;
        const i = idToIdx.get(id);
        if (i === undefined || !Number.isNaN(anchor[i])) continue;
        anchor[i] = (v - vMin) / (vMax - vMin) * 12;
        khanAnchored++;
        seen.add(id);
      }
    }
  }

  let zoneAnchored = 0;
  {
    const zoneRows = readTsv("data/onet/Job Zones.txt");
    const iZs = col(zoneRows, "O*NET-SOC Code", "data/onet/Job Zones.txt"),
      iZz = col(zoneRows, "Job Zone", "data/onet/Job Zones.txt");
    const socToZone = new Map<string, number>();
    for (let i = 1; i < zoneRows.length; i++) {
      const soc = zoneRows[i][iZs], z = Number(zoneRows[i][iZz]);
      if (soc && Number.isFinite(z) && z >= 1 && z <= 5) socToZone.set(soc, z);
    }
    const cmr = onetElementNames();
    const skillZoneSum = new Map<string, { w: number; wz: number }>();
    for (const fname of ["Skills.txt", "Knowledge.txt", "Abilities.txt"]) {
      const rows = readTsv(`data/onet/${fname}`);
      const iS = col(rows, "O*NET-SOC Code", `data/onet/${fname}`),
        iE = col(rows, "Element ID", `data/onet/${fname}`),
        iSc = col(rows, "Scale ID", `data/onet/${fname}`),
        iV = col(rows, "Data Value", `data/onet/${fname}`);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][iSc] !== "IM") continue;
        const name = cmr.get(rows[i][iE]);
        const zone = socToZone.get(rows[i][iS]);
        if (!name || zone === undefined) continue;
        const w = Number(rows[i][iV]);
        if (!Number.isFinite(w) || w <= 0) continue;
        const key = slugify(name);
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += w;
        e.wz += w * zone;
        skillZoneSum.set(key, e);
      }
    }
    // O*NET Tasks: each task statement is linked to exactly one SOC, so we can
    // anchor each task directly via its SOC's zone. Same for DWAs via Task→DWA.
    const taskSocByTid = new Map<string, string>();
    const taskTextByTid = new Map<string, string>();
    {
      const rows = readTsv("data/onet/Task Statements.txt");
      const iS = col(rows, "O*NET-SOC Code", "data/onet/Task Statements.txt"),
        iTid = col(rows, "Task ID", "data/onet/Task Statements.txt"),
        iTask = col(rows, "Task", "data/onet/Task Statements.txt");
      for (let i = 1; i < rows.length; i++) {
        const tid = rows[i][iTid], task = rows[i][iTask], soc = rows[i][iS];
        if (!tid || !task || !soc) continue;
        if (!taskSocByTid.has(tid)) {
          taskSocByTid.set(tid, soc);
          taskTextByTid.set(tid, task);
        }
        const key = slugify(task);
        const zone = socToZone.get(soc);
        if (zone === undefined) continue;
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += 1;
        e.wz += zone;
        skillZoneSum.set(key, e);
      }
    }
    {
      const dwaPath = "data/onet/DWA Reference.txt";
      const dwaRows = readTsv(dwaPath);
      const iDwa = col(dwaRows, "DWA ID", dwaPath),
        iTitle = col(dwaRows, "DWA Title", dwaPath);
      const dwaTitle = new Map<string, string>();
      for (const r of dwaRows.slice(1)) {
        if (r[iDwa] && r[iTitle]) dwaTitle.set(r[iDwa], r[iTitle]);
      }
      const t2d = readTsv("data/onet/Tasks to DWAs.txt");
      const iTid = col(t2d, "Task ID", "data/onet/Tasks to DWAs.txt"),
        iDid = col(t2d, "DWA ID", "data/onet/Tasks to DWAs.txt");
      for (let i = 1; i < t2d.length; i++) {
        const tid = t2d[i][iTid], did = t2d[i][iDid];
        const title = dwaTitle.get(did);
        const soc = taskSocByTid.get(tid);
        if (!title || !soc) continue;
        const zone = socToZone.get(soc);
        if (zone === undefined) continue;
        const key = slugify(title);
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += 1;
        e.wz += zone;
        skillZoneSum.set(key, e);
      }
    }

    const idToIdx = new Map<string, number>();
    for (let i = 0; i < skills.length; i++) idToIdx.set(skills[i].id, i);
    for (const [key, { w, wz }] of skillZoneSum) {
      const i = idToIdx.get(key);
      if (i === undefined || !Number.isNaN(anchor[i])) continue;
      anchor[i] = 11.5 + 1.5 * (wz / w);
      zoneAnchored++;
    }
  }

  const anchorIdxs: number[] = [];
  for (let i = 0; i < skills.length; i++) {
    if (!Number.isNaN(anchor[i])) anchorIdxs.push(i);
  }
  console.log(
    `[difficulty] anchors: grade=${gradeAnchored}, khan=${khanAnchored}, zone=${zoneAnchored}, total=${anchorIdxs.length}`,
  );
  // With no anchors of one kind, kNN still runs and every band skews.
  if (!gradeAnchored || !khanAnchored || !zoneAnchored) {
    throw new Error(
      `difficulty: expected grade, Khan, and Job Zone anchors, received grade=${gradeAnchored}, khan=${khanAnchored}, zone=${zoneAnchored}. Check the grade:* tags in ${TAGGED}, data/khanacademy/khandata.tsv, and data/onet/Job Zones.txt.`,
    );
  }

  const K = 15;
  const t0 = performance.now();
  const topicToAnchors = new Map<string, number[]>();
  for (let a = 0; a < anchorIdxs.length; a++) {
    const ai = anchorIdxs[a];
    for (const topic of skills[ai].topics.split(",")) {
      if (!topic) continue;
      let arr = topicToAnchors.get(topic);
      if (!arr) {
        arr = [];
        topicToAnchors.set(topic, arr);
      }
      arr.push(a);
    }
  }

  const candidates = (i: number): number[] => {
    const seen = new Set<number>();
    for (const topic of skills[i].topics.split(",")) {
      if (!topic) continue;
      const arr = topicToAnchors.get(topic);
      if (arr) { for (const a of arr) seen.add(a); }
    }
    return [...seen];
  };
  const out = new Float32Array(skills.length);
  let withinTopic = 0, globalFallback = 0;
  {
    const anchorMat = new Float32Array(anchorIdxs.length * EMBED_DIM);
    const anchorDiff = new Float32Array(anchorIdxs.length);
    for (let a = 0; a < anchorIdxs.length; a++) {
      anchorMat.set(
        vecs.subarray(
          anchorIdxs[a] * EMBED_DIM,
          (anchorIdxs[a] + 1) * EMBED_DIM,
        ),
        a * EMBED_DIM,
      );
      anchorDiff[a] = anchor[anchorIdxs[a]];
    }
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * EMBED_DIM;
      const top: { score: number; a: number }[] = [];
      let pool: number[] | null = candidates(i);
      if (!pool.length) pool = null;
      if (pool) withinTopic++;
      else globalFallback++;
      const n = pool ? pool.length : anchorIdxs.length;
      for (let k = 0; k < n; k++) {
        const a = pool ? pool[k] : k;
        let sc = 0;
        const aOff = a * EMBED_DIM;
        for (let d = 0; d < EMBED_DIM; d++) {
          sc += vecs[sOff + d] * anchorMat[aOff + d];
        }
        if (top.length < K) {
          top.push({ score: sc, a });
          if (top.length === K) top.sort((x, y) => x.score - y.score);
        } else if (sc > top[0].score) {
          top[0] = { score: sc, a };
          top.sort((x, y) => x.score - y.score);
        }
      }
      let num = 0, den = 0;
      for (const { score, a } of top) {
        const w = Math.max(0, score) ** 2;
        num += w * anchorDiff[a];
        den += w;
      }
      out[i] = den > 0 ? num / den : (Number.isNaN(anchor[i]) ? 10 : anchor[i]);
      if ((i + 1) % 5000 === 0) console.log(`  ${i + 1}/${skills.length}`);
    }
  }

  const SMOOTH_W = 0.3;
  const smoothJitter = (out: Float32Array) => {
    const smoothed = new Float32Array(out);
    const topicSum = new Map<string, { sum: number; n: number }>();
    for (let i = 0; i < skills.length; i++) {
      for (const t of skills[i].topics.split(",")) {
        if (!t) continue;
        const e = topicSum.get(t) ?? { sum: 0, n: 0 };
        e.sum += out[i];
        e.n++;
        topicSum.set(t, e);
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

    const jittered = new Float32Array(skills.length);
    for (let i = 0; i < skills.length; i++) {
      let h = 0;
      for (let k = 0; k < skills[i].id.length; k++) {
        h = ((h * 31) + skills[i].id.charCodeAt(k)) | 0;
      }
      jittered[i] = smoothed[i] + (((h >>> 0) % 1000) / 1000 - 0.5) * 0.001;
    }
    return { smoothed, jittered };
  };
  const { smoothed, jittered } = smoothJitter(out);

  // Isotonic PAV
  const pairs: [number, number][] = [];
  for (const ai of anchorIdxs) pairs.push([jittered[ai], anchor[ai]]);
  pairs.sort((a, b) => a[0] - b[0]);
  type PavNode = { x: number; y: number; w: number };
  const pav: PavNode[] = [];
  for (const [x, y] of pairs) {
    let cur: PavNode = { x, y, w: 1 };
    while (pav.length && pav[pav.length - 1].y > cur.y) {
      const prev = pav.pop()!;
      cur = {
        x: prev.x,
        y: (prev.y * prev.w + cur.y * cur.w) / (prev.w + cur.w),
        w: prev.w + cur.w,
      };
    }
    pav.push(cur);
  }
  const pavX = pav.map((p) => p.x), pavY = pav.map((p) => p.y);
  const tailStart = Math.max(
    0,
    pavX.length - Math.max(2, Math.floor(pavX.length * 0.1)),
  );
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
      if (pavX[mid] <= raw) lo = mid;
      else hi = mid;
    }
    const span = pavX[hi] - pavX[lo];
    const t = span > 0 ? (raw - pavX[lo]) / span : 0;
    return pavY[lo] + t * (pavY[hi] - pavY[lo]);
  };
  const calibrated = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const c = calibrate(jittered[i]);
    if (!Number.isFinite(c)) {
      throw new Error(
        `[difficulty] non-finite calibrated value for ${skills[i].id} (raw=${
          out[i]
        }, smoothed=${smoothed[i]}, jittered=${jittered[i]})`,
      );
    }
    calibrated[i] = c;
  }

  // Seed anchoring: a seed prereq sits 1.0 below its dependent. AL-CPL and
  // MOOCCubeX concepts land on the professional plateau, where about a quarter
  // of seeds otherwise reverse.
  let seedAnchorAdjusted = 0;
  let seedPairs: number[][] = [];
  let seedCyclePairs = 0, seedAnchorConflicts = 0;
  {
    const idToIdx = new Map(skills.map((s, i) => [s.id, i]));
    const allSeeds = readSeeds().flatMap(({ pre, dep }) => {
      const si = idToIdx.get(pre), di = idToIdx.get(dep);
      if (pre === dep) {
        throw new Error(
          `[difficulty] seed self-loop on ${pre}. Expected pre != dep. Received ${pre} > ${dep} in build/1e_seed_edges.tsv. Fix: drop the pair or its alias merge in stage seed-edges.`,
        );
      }
      if (si === undefined || di === undefined) {
        throw new Error(
          `[difficulty] seed id not in build/1_skills.tsv. Expected both ids of a seed pair in the skill table. Received ${pre} > ${dep} in build/1e_seed_edges.tsv. Fix: rerun stage seed-edges after the last dedupe.`,
        );
      }
      return [[si, di]];
    });
    // Seeds inside a cycle cannot order anything; postproc breaks them by rank.
    const adj = new Map<number, number[]>();
    for (const [si, di] of allSeeds) adj.set(si, [...adj.get(si) ?? [], di]);
    const cycleOf = new Map<number, number>();
    stronglyConnected(adj).forEach((comp, c) =>
      comp.forEach((n) => cycleOf.set(n, c))
    );
    seedCyclePairs =
      allSeeds.filter(([si, di]) =>
        cycleOf.has(si) && cycleOf.get(si) === cycleOf.get(di)
      ).length;
    const seeds = allSeeds.filter(([si, di]) =>
      !(cycleOf.has(si) && cycleOf.get(si) === cycleOf.get(di))
    );
    // A seed moves only the side with no grade anchor.
    seedAnchorConflicts =
      seeds.filter(([si, di]) =>
        !Number.isNaN(anchor[si]) && !Number.isNaN(anchor[di]) &&
        anchor[si] >= anchor[di]
      ).length;
    // One pass per chain link at most. The seeds are a DAG, so a pass that
    // still moves a skill after seeds.length + 1 passes is a bug.
    const lowered = new Set<number>();
    const settle = (v: Float32Array) => {
      for (let pass = 0;; pass++) {
        let moved = false;
        for (const [si, di] of seeds) {
          if (v[si] < v[di]) continue;
          if (Number.isNaN(anchor[si])) {
            v[si] = v[di] - 1.0;
            lowered.add(si);
          } else if (Number.isNaN(anchor[di])) {
            v[di] = v[si] + 1.0;
            lowered.add(di);
          } else continue;
          moved = true;
        }
        if (!moved) break;
        if (pass > seeds.length) {
          throw new Error(
            `[difficulty] seed order never settles after ${pass} passes over ${seeds.length} seeds. Expected a DAG outside the cycles. Received a pair chain that keeps moving. Fix: report a bug in the seed cycle filter.`,
          );
        }
      }
    };
    settle(out);
    if (lowered.size > 0) {
      const { smoothed, jittered } = smoothJitter(out);
      for (let i = 0; i < skills.length; i++) {
        const c = calibrate(jittered[i]);
        if (!Number.isFinite(c)) {
          throw new Error(
            `[difficulty] non-finite calibrated value for ${
              skills[i].id
            } after seed anchoring (raw=${out[i]}, smoothed=${
              smoothed[i]
            }, jittered=${jittered[i]})`,
          );
        }
        calibrated[i] = c;
      }
    }
    // Topic smoothing and PAV can lift a prereq over its dependent again.
    settle(calibrated);
    seedAnchorAdjusted = lowered.size;
    if (seedAnchorAdjusted > 0) {
      console.log(
        `[difficulty] seed-anchored ${seedAnchorAdjusted} prereqs below their dependents`,
      );
    }
    seedPairs = seeds;
  }

  const band = new Int32Array(skills.length);
  let healthCapped = 0;
  for (let i = 0; i < skills.length; i++) {
    let b = Math.max(1, Math.min(20, Math.round(calibrated[i]) + 1));
    // Medical O*NET neighbors pull K-12 health concepts up. Cap them at band 13.
    if (!Number.isNaN(anchor[i])) {
      const anchorBand = Math.round(anchor[i]) + 1;
      if (anchorBand <= 13 && b > 13) {
        b = 13;
        healthCapped++;
      }
    }
    if (!Number.isInteger(b) || b < 1 || b > 20) {
      throw new Error(
        `[difficulty] bad band for ${skills[i].id}: ${b} (calibrated=${
          calibrated[i]
        })`,
      );
    }
    band[i] = b;
  }
  // The band clamp at 1 and the health cap can tie a seed pair. Lower the
  // prereq; a dependent at band 1 has no room below, so raise it instead.
  let bandMoved = 0;
  for (let pass = 0;; pass++) {
    let moved = false;
    for (const [si, di] of seedPairs) {
      if (band[si] < band[di]) continue;
      if (!Number.isNaN(anchor[si]) && !Number.isNaN(anchor[di])) continue;
      if (!Number.isNaN(anchor[si]) || band[di] <= 1) band[di] = band[si] + 1;
      else band[si] = band[di] - 1;
      if (band[di] > 20) {
        throw new Error(
          `[difficulty] seed ${skills[si].id} > ${skills[di].id} needs band ${
            band[di]
          }. Expected bands 1-20. Received a seed chain deeper than 20 links. Fix: drop a reversed pair in build/1e_seed_edges.tsv.`,
        );
      }
      bandMoved++;
      moved = true;
    }
    if (!moved) break;
    if (pass > seedPairs.length) {
      throw new Error(
        `[difficulty] seed bands never settle after ${pass} passes over ${seedPairs.length} seeds. Expected a DAG in build/1e_seed_edges.tsv. Fix: find and drop one reversed pair.`,
      );
    }
  }
  if (bandMoved > 0) {
    console.log(
      `[difficulty] ${bandMoved} seed pairs moved to keep prereq band below dependent band`,
    );
  }
  const bandCounts = new Array(20).fill(0);
  for (const b of band) bandCounts[b - 1]++;
  if (healthCapped > 0) {
    console.log(
      `[difficulty] K-12 anchor band cap applied to ${healthCapped} skills`,
    );
  }

  const rows = ["id\tdifficulty\tdifficulty_raw"];
  for (let i = 0; i < skills.length; i++) {
    rows.push(`${skills[i].id}\t${band[i]}\t${out[i].toFixed(4)}`);
  }
  Deno.writeTextFileSync(`${BUILD}/4_difficulty.tsv`, rows.join("\n") + "\n");

  // Kendall-τ vs anchors
  let concordant = 0, discordant = 0;
  const sample: { raw: number; a: number }[] = [];
  for (let i = 0; i < skills.length; i++) {
    if (!Number.isNaN(anchor[i]) && anchor[i] < 14) {
      sample.push({ raw: out[i], a: anchor[i] });
    }
  }
  sample.length = Math.min(sample.length, 2000);
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const ds = Math.sign(sample[i].raw - sample[j].raw);
      const da = Math.sign(sample[i].a - sample[j].a);
      if (ds === 0 || da === 0) continue;
      if (ds === da) concordant++;
      else discordant++;
    }
  }
  const tau = concordant + discordant
    ? (concordant - discordant) / (concordant + discordant)
    : 0;

  // Grade-vs-band inversion audit: direct grade-anchored skills should have
  // a band close to the grade anchor. >5 bands off signals calibration
  // pathology (e.g. grade-1 skill landing at band 17).
  let gradeAnchoredSkills = 0, inversions = 0, worstInversion = 0;
  const invSamples: string[] = [];
  for (let i = 0; i < skills.length; i++) {
    const grades: number[] = [];
    for (const m of skills[i].tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (!grades.length) continue;
    gradeAnchoredSkills++;
    const anchorBand = Math.round(Math.max(...grades)) + 1;
    const gap = Math.abs(band[i] - anchorBand);
    if (gap > 5) {
      inversions++;
      worstInversion = Math.max(worstInversion, gap);
      if (invSamples.length < 10) {
        invSamples.push(
          `${skills[i].id}: grade→${anchorBand}, band=${band[i]}`,
        );
      }
    }
  }
  if (inversions > 0) {
    console.warn(
      `[difficulty] ${inversions} grade-vs-band inversions (>5 gap) out of ${gradeAnchoredSkills}; worst gap=${worstInversion}`,
    );
  }

  writeStats(4, {
    skills: skills.length,
    anchors: {
      grade: gradeAnchored,
      khan: khanAnchored,
      zone: zoneAnchored,
      total: anchorIdxs.length,
    },
    within_topic: withinTopic,
    global_fallbacks: globalFallback,
    band_distribution: bandCounts,
    kendall_tau_vs_anchor: tau,
    grade_anchored_skills: gradeAnchoredSkills,
    grade_band_inversions: inversions,
    grade_band_worst_gap: worstInversion,
    seed_pairs: seedPairs.length + seedCyclePairs,
    seed_cycle_pairs: seedCyclePairs,
    seed_anchor_conflicts: seedAnchorConflicts,
    grade_band_inversion_samples: invSamples,
    total_seconds: (performance.now() - t0) / 1000,
  });
}
