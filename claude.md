# claude.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project

skill-tree aggregates open datasets to build a skill prerequisite graph. Data
sources span occupational taxonomies, educational prerequisites, and knowledge
graphs. See `todo.md` for data source tracking, and `research.md` for the survey
of candidate sources, prior work, and design lessons.

## Datasets

All data lives in `data/`. Schemas below.

### data/esco/ — European Skills/Occupations (19 CSVs)

EU taxonomy of skills linked to occupations. Key files:

- **skills_en.csv** —
  `conceptType, conceptUri, skillType, reuseLevel, preferredLabel, altLabels, hiddenLabels, status, modifiedDate, scopeNote, definition, inScheme, description`
- **occupations_en.csv** —
  `conceptType, conceptUri, iscoGroup, preferredLabel, altLabels, hiddenLabels, status, modifiedDate, regulatedProfessionNote, scopeNote, definition, inScheme, description, code, naceCode`
- **occupationSkillRelations_en.csv** (largest) —
  `occupationUri, occupationLabel, relationType, skillType, skillUri, skillLabel`.
  relationType is "essential" or "optional"; skillType is "knowledge" or
  "skill/competence"
- **skillSkillRelations_en.csv** —
  `originalSkillUri, originalSkillType, relationType, relatedSkillType, relatedSkillUri`.
  Inter-skill relationships (optional, prerequisite)
- **broaderRelationsSkillPillar_en.csv** —
  `conceptType, conceptUri, conceptLabel, broaderType, broaderUri, broaderLabel`.
  Skill hierarchy
- **skillGroups_en.csv** — ISCED-F skill groupings with `code` field

All entities use URI identifiers for semantic linkage.

### data/onet/ — U.S. O*NET (TSV files)

Occupations with quantitative ratings. Common column structure:
`O*NET-SOC Code, Element ID, Element Name, Scale ID, Data Value, N, Standard Error, Lower CI Bound, Upper CI Bound, Recommend Suppress, Not Relevant, Date, Domain Source`.
Scale IDs: IM (Importance), LV (Level).

Key files:

- **Occupation Data.txt** — `O*NET-SOC Code, Title, Description`
- **Skills.txt** — skills rated per occupation
- **Knowledge.txt** — knowledge areas rated per occupation
- **Abilities.txt** — abilities rated per occupation
- **Work Activities.txt** (largest) — activity ratings
- **Task Statements.txt** —
  `O*NET-SOC Code, Task ID, Task, Task Type, Incumbents Responding, Date, Domain Source`
- **Task Ratings.txt** — frequency/importance ratings per task
- **Technology Skills.txt** — specific tools/software per occupation
- **Education, Training, and Experience.txt** — requirements
- **Interests.txt** — RIASEC codes

### data/lightcast/ — Lightcast Open Skills

**skills.json** — Array of skill objects:

```json
{
  "id": "KS126XS6CQCFGC3NG79X",
  "infoUrl": "https://skills.emsidata.com/skills/...",
  "name": ".NET Assemblies",
  "type": { "id": "ST1", "name": "Specialized Skill" }
}
```

Top-level also has `attributions` array.

### data/lcsh/ — Library of Congress Subject Headings (gzipped N-Triples)

SKOS concepts spanning all fields of knowledge, curated by the Library of
Congress. Downloaded from https://id.loc.gov/download/.

**subjects.skosrdf.nt.gz** — N-Triples RDF. Each subject heading is a
`skos:Concept` with:

- `skos:prefLabel` — canonical English label
- `skos:altLabel` — variant forms
- `skos:broader` / `skos:narrower` — hierarchical relations
- `skos:related` — associative relations
- `skos:inScheme` — all belong to `<http://id.loc.gov/authorities/subjects>`
- `skos:changeNote` — provenance/revision metadata via blank nodes

URI pattern: `http://id.loc.gov/authorities/subjects/sh{id}`

### data/dbpedia/ — DBpedia Category Hierarchy (bzip2 Turtle)

Wikipedia's category graph extracted by DBpedia (2016-10 release). Downloaded
from https://downloads.dbpedia.org/2016-10/core-i18n/en/.

**skos_categories_en.ttl.bz2** — SKOS categories with `skos:broader` edges. Each
category is a `skos:Concept` with `skos:prefLabel` and `skos:broader` links to
parent categories. URI pattern: `http://dbpedia.org/resource/Category:{Name}`

**article_categories_en.ttl.bz2** (gitignored) — maps Wikipedia articles to
categories via `dcterms:subject`. URI pattern:
`http://dbpedia.org/resource/{Article_Name}` →
`http://dbpedia.org/resource/Category:{Category_Name}`

### data/al-cpl/ — Expert Prerequisite Pairs

From github.com/harrylclc/AL-CPL-dataset. Expert-labeled concept prerequisite
pairs across 4 domains: Data Mining, Geometry, Physics, Precalculus. CC BY 4.0.

- **data/*.pairs** — all concept pairs considered: `ConceptA,ConceptB`
  (Wikipedia article titles)
- **data/*.preqs** — confirmed prerequisite pairs: `Target,Prerequisite`. The
  second column is a prerequisite of the first (subset of .pairs where experts
  agreed).
- **features/** — precomputed features for prerequisite prediction models

### data/metacademy/ — ML/AI Concept Prerequisite Graph

Two sources combined:

**metacademy-content/concepts/{name}/** — ML/AI concepts, each a directory with:

- `title.txt` — concept name
- `dependencies.txt` — prerequisite concepts as `tag: {concept_id}` + `reason:`
  pairs
- `summary.txt`, `goals.txt`, `resources.txt`

**Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv** — prerequisite
pairs mapped to Wikipedia:
`prereq_wiki_canonical_title preq, MA preq, MA concept, concept_wiki_canonical_title_concept`

### data/mooccubex/ — MOOCCubeX Prerequisites (JSONL, gzipped in git)

From github.com/THU-KEG/MOOCCubeX. Concept prerequisite pairs with model
predictions for CS, math, and psychology (Chinese university MOOCs). Each line
is a JSON object:

```json
{
  "c1": "函数的定义域",
  "c2": "欧拉函数",
  "ground_truth": 1,
  "text_predict": [0.03, 0.97],
  "graph_predict": [0.02, 0.98]
}
```

- `c1` → `c2` prerequisite direction; `ground_truth`: 1 = confirmed prerequisite
- **cs.json.gz**, **math.json.gz**, **psy.json.gz**
- Uncompressed .json files are gitignored
- Stage `enrich` translates the Chinese labels with Ollama into
  `build/1f_translate.tsv`. Stage `seed-edges` throws on a label with no
  translation.

### data/courses/ — University Course Prerequisites (CSV, gzipped in git)

From data.mendeley.com/datasets/fs2hvkps7z (CC BY 4.0): catalogs of 13
universities, 32 editions. `data/download.ts` checks the SHA-256 of each file,
then keeps the gzip only. Uncompressed .csv files are gitignored.

- **courses.csv.gz** — one row per course per edition. Stage `seed-edges` reads
  `dataset, code, title`.
- **prereq_edges.csv.gz** —
  `institution, dataset, edition, source_prereq, target_course, group_index, is_alternative, timing, min_grade`.
  A code means one course only inside its `dataset`. `timing` is `before`,
  `concurrent`, or `before_or_concurrent`; only `before` is a prereq. Rows of
  one OR group (`is_alternative` 1) each make a pair.
- `readCoursePairs` (`lib.ts`) joins codes to titles, strips course wrapping
  with `courseTopic` ("Calculus III for Engineers" → "Calculus"), and dedupes by
  topic pair. A code with no course, two titles, an empty title, or a code-only
  title ("CEN 271"), and a pair of one topic ("Calculus I" → "Calculus II"), go
  to `1e_unresolved.tsv` with that reason.

### data/khanacademy/ — Khan Academy Math Prerequisite Graph (TSV)

Community-mapped prerequisite graph of Khan Academy math exercises, from
counting (K) through calculus (AP). Source:
[Google Sheets data map](https://docs.google.com/spreadsheets/d/1YiRwrDAuLx7K2NmPySs1K1GpR7Kxzfk5KjDTxpvP0rM/).

**khandata.tsv** — columns:
`Code, Data Name, Prereq(s), H-Position, V-Position, Display Name, Link to Practice problem`

- `Code` — numeric ID
- `Data Name` — exercise slug (e.g. `counting-out-1-20-objects`)
- `Prereq(s)` — semicolon-separated prerequisite references; mixed numeric Codes
  and Data Name slugs
- `H-Position, V-Position` — layout coordinates for visualization (`x` =
  unpositioned)
- `Display Name` — human-readable exercise title
- `root` in Prereq(s) means no prerequisites

### data/digcomp/ — DigComp 3.0 Data Supplement (JSON-LD)

EU digital competence framework for adults, CC BY 4.0. **digcomp3.jsonld** holds
`@graph` nodes of `@type` CompetenceArea (5), Competence (21), ProficiencyLevel,
CompetenceStatement, LearningOutcome, and Glossary. A LearningOutcome has
`description`, `type`, `competence_area_id`, `competence_id`, and
`four_levels_proficiency_name` (Basic, Intermediate, Advanced, Highly advanced).

### data/certatlas/ — Certification Exam Objectives (gzipped JSON, MIT)

From github.com/hans6883/cert-atlas (QuizForge). **exams.json.gz** is one array
that `data/download.ts` slims from the repo's per-exam files:
`{id, name, body, domains: [{name, objectives: [{title, sub: string[]}]}]}`. It
omits `weight_percent` and Microsoft and AWS exams, whose site terms bar reuse.
Run `gzip -dc data/certatlas/exams.json.gz | jq length` for the exam count.

### data/learningcommons/ — Learning Commons Knowledge Graph (gzipped JSON lines)

US state standards and learning components, v1.16.0, CC BY 4.0 on every row.
`data/download.ts` streams the 986 MB export and keeps **graph.jsonl.gz**, a
filtered extract that git tracks. One JSON object per line, `k` names the kind:

- `attributions` — `statements[]`, each row cites one by index (`attribution`).
- `component` — `id, text, grades[]`. `grades` is the union of the grades of the
  standards it `supports`.
- `item` — `id, text, code, type, grades[]`: a `StandardsFrameworkItem` of a
  framework with `isCurrent` true. The export's own groupings are left out.
- `edge` — `rel, from, to`, only `buildsTowards` (Coherence Map, source is the
  prereq) and `hasStandardAlignment` (state to CCSS) between kept items.

The version sits in one constant, `LC_VERSION`, in `data/download.ts`.

### data/lecturebank/ — LectureBank Expert Prerequisite Pairs (gitignored clone)

From github.com/Yale-LILY/LectureBank. The repo states no licence, so git does
not track the clone; `data/download.ts` clones it (depth 1). Stage `seed-edges`
does not read it: the pairs are held out for `deno task status`. All files sit
under `LB-Paper/`:

- **208topics.csv** + **prerequisite_annotation.csv** (LB1),
  **LectureBank2/data/322topics_final.tsv** + **final_new_annotation.csv**
  (LB2), **LectureBankCD/data/{CV,BIO}.topics.tsv** +
  **{CV,BIO}.annotation.csv**.
- An annotation row `A,B,1` means topic A is a prerequisite of topic B. A file
  lists every ordered pair of its topics, so a `0` is a real negative.
- `readLectureBank` (`lib.ts`) reads the four sets. A row that names a topic id
  with no name in its topic file is counted and dropped (LB1 ids 210 and 211).

### data/bncc/ — Brazil's National Curriculum (BNCC, gzipped JSON)

From github.com/bncc-dev/bncc-dados at the commit pinned in `data/download.ts`.
Data CC BY 4.0: credit "bncc.dev (maintained by Profy)" with a link to the repo.
Git tracks the gzips, because jj refuses a new file over 1 MiB.

- **educacao-infantil.json.gz** — `objetivos[]`: `codigo, texto, grupo_etario`.
- **ensino-fundamental.json.gz** — `habilidades[]`: `codigo, texto, anos[]`.
- **ensino-medio.json.gz** — `habilidades[]`: `codigo, texto, area`.
- The code holds grade and subject: `EF67LP08` is grades 6–7, Portuguese.
  `EI01`–`EI03` are age bands to 5 years (grade PK). `EM13` is grades 10–12.
- Stage `enrich` translates each `texto` with Ollama into
  `build/1g_bncc_translate.tsv`, keyed by code. Stage `list` throws on a code
  with no translation.

### data/opensalt/ — OpenSALT Standards Frameworks (CASE JSON)

K-12 standards frameworks from opensalt.net in 1EdTech CASE format. Includes
CCSS Math, NGSS, state standards (Alabama, Georgia, Indiana, Virginia, Oklahoma,
Florida, etc.), plus specialty frameworks (CASEL, 21st Century Skills, AP CS).

**index.json** — list of all frameworks with `identifier` and `title`

**{uuid}.json** — each framework as a CASE package with:

- `CFDocument` — framework metadata
- `CFItems` — individual standards/competencies with GUIDs
- `CFAssociations` — relationships between items (including "precedes"
  prerequisite type)
- `CFDefinitions` — concept/license definitions

## Scripts

### pipeline.ts — Unified Skill Extraction Pipeline

`deno run -A pipeline.ts [stage]` runs one stage, or every stage in order:
`list`, `enrich`, `trees`, `embed`, `tag`, `dedupe`, `seed-edges`, `difficulty`,
`prereq`, `postproc`, `finalize`, `status`.

| File          | Holds                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| `pipeline.ts` | Entry point: stage dispatch and stage `status`.                        |
| `lib.ts`      | Names that two files share: text cleanup, TSV/CSV, Ollama, embeddings. |
| `sources.ts`  | Stages `list`, `enrich`, `trees`, `seed-edges`.                        |
| `graph.ts`    | Stages `embed`, `tag`, `dedupe`, `difficulty`.                         |
| `prereq.ts`   | Stages `prereq`, `postproc`, `finalize`.                               |

Parses datasets into a unified schema, embeds via Ollama `nomic-embed-text`,
assigns occupations/topics, dedupes, infers difficulty (isotonic PAV + kNN
smoothing), ranks prerequisites via Ollama `gpt-oss:20b`, breaks cycles, and
emits `skills.tsv`. Ollama runs at `localhost:11434`. Stage outputs live in
`build/`.

**Errors**: a missing build file names the stage that writes it. A missing cache
reads as empty. Any other read error, a ragged TSV or CSV row, or an Ollama call
that fails twice stops the stage.

**Build tables**: each TSV that one stage writes and a later stage reads has one
schema in `lib.ts`. `readTable` and `writeTable` check every cell, the header,
the key, and the final newline. `writeTable` writes `path.tmp`, then renames.
Stages `postproc` and `finalize` throw on an id outside `3b_tagged_deduped.tsv`.
A new build table gets a schema; a new id goes through `slugify`.

**Parsers**:

- Stage `list`: ESCO, O\*NET (Skills/Knowledge/Abilities/Tasks/DWAs/Tech),
  Lightcast, OpenSALT, Learning Commons, DigComp, Cert Atlas, BNCC, and the hubs
  in `data/_foundations.json`. Each BNCC objective is one skill with source
  `bncc`, tags `bncc:objective`, `bncc:subject:*`, `grade:*`, and
  `code:<codigo>`. Each Cert Atlas objective is one skill with source
  `certatlas`, no tags, and a description of exam, certifying body, domain, and
  sub-objectives; a title with no Latin letter is dropped and counted. Each
  DigComp LearningOutcome is one skill with tags `digcomp:outcome`,
  `digcomp:area:*`, `digcomp:competence:*`, and `digcomp:level:*`; stage
  `difficulty` anchors the level at job zone 1-4. OpenSALT statements parse as
  HTML with `deno-dom`; a `script`, `style`, or head element in one stops the
  stage. Learning Commons statements parse the same way and pass the same
  scaffolding filters (`cleanStandard`). A component is one skill with tags
  `learningcommons:component` and `grade:*`. A standard is one skill per
  distinct statement, tags `learningcommons:standard`, `grade:*`, and
  `code:<statementCode>`. A `buildsTowards` endpoint also gets
  `learningcommons:coherence` and skips the long-title drop. Other sources keep
  `<…>` as text.
- Stage `seed-edges`: Khan Academy, AL-CPL, Metacademy, MOOCCubeX, course
  prerequisites, OpenSALT precedes, OpenSALT within-framework grade ordering,
  Learning Commons `buildsTowards`. The last resolves through
  `build/1m_lc_ids.tsv` and `3b_aliases.tsv`, not by label. A pair with an end
  that stage `list` dropped goes to `build/1e_unresolved.tsv` with reason
  `no-skill`. Pairs resolve to skill IDs by exact match, then by embedding
  (cosine ≥ 0.90 and a shared token). Unresolved pairs go to
  `build/1e_unresolved.tsv` with a reason per label.
- Stage `trees`: LCSH (gunzip) and DBpedia (bzcat) SKOS broader chains, cached
  as `slug → ancestors[]`. The same pass picks each dump's 5000 most-used
  broader targets as the topic refs of stage `tag`.

**LLM enrichment** (stage `enrich`): fill missing Lightcast descriptions;
summarize long OpenSALT/O\*NET-task titles into 3-7 word names; expand short
O\*NET task statements and OpenSALT standards; translate MOOCCubeX labels and
BNCC objectives (first, since stage `list` needs them). Resumable via the
`1b`–`1g` caches. Stage `list` applies them on its next run.

**Prereq inference** (stage `prereq`): per-skill top-K candidates by cosine
similarity (within-topic + ancestor + cross-topic pools), then the LLM picks
true prerequisites. Resumable via `5_prereqs.tsv`. `SKIP_LLM=1` reuses that
cache as is, for a regression build without the generator.

**Merge step** (stage `dedupe`): token-sort signature merge + per-topic
Jaccard+cosine merge + Learning Commons candidates (a Learning Commons row and
an OpenSALT row that share a `code:*` tag, cosine ≥ 0.90; a
`hasStandardAlignment` pair, cosine ≥ 0.96). Canonical ID = shortest title.
Dropped IDs become aliases in `3b_aliases.tsv`; stages `postproc` and `finalize`
remap edges through it.

### data/download.ts — Dataset Downloader

`deno run --allow-read --allow-write --allow-net --allow-run data/download.ts`

Downloads all datasets from their sources. Implements caching (skips existing
files).

### Checks

- `deno task check` — fmt, lint, typecheck.
- `deno task test` — runs stage `list` for real (no Ollama) and asserts on its
  output, plus fixture runs of the other stages. Keep it under 10 s: start each
  fixture run at module load so the runs overlap.
- `deno task status` — grades the last full build; exits 1 when any condition
  scores below 1.0. snitch runs it hourly. Three conditions grade the edges
  against the LectureBank pairs: the matched-pair count, precision, and recall.
  `status` resolves the topic names with `resolveConcept`, then
  `embeddingFallback` (`lib.ts`, shared with stage `seed-edges`; it calls Ollama
  for names with no exact skill, and the embedding cache keeps later runs
  offline). Precision counts the `skills.tsv` edges whose pair an expert
  annotated. Recall counts the positive pairs inside the transitive closure.

## Output Files

Generated by `pipeline.ts` into the project root. Gitignored.

### skills.tsv / skills.tsv.gz — Unified Skill Table

Columns:
`id, title, display_title, description, difficulty, prereqs, occupations, topics, grade_start, grade_end`

- `id` — slugified title: NFKD-folded to ASCII, lowercase, single hyphens with
  none at the edges, ≤80 chars (hex-hashed suffix for overflow, `-N` for a
  collision).
- `display_title` — title truncated to ≤80 chars (or `code:XXX` tag for OpenSALT
  codes); for UIs that can't render long compliance statements.
- `difficulty` — integer band 1-20 derived from grade anchors (OpenSALT
  `educationLevel` + Khan V-Position) DigComp levels, and O\*NET job zones via
  kNN smoothing and isotonic PAV calibration. One pass then puts each expert
  seed prereq at least one band below its dependent. An anchored skill never
  moves. Pairs join in file order while every skill still fits a band; a pair
  that cannot fit, or sits in a cycle, is dropped and counted in `4_stats.json`
  (`seed_anchor_ties` when two anchors share a band, else
  `seed_anchor_conflicts`). Stage `postproc` keeps every seed edge either way.
- `prereqs` — comma-separated prereq IDs. Strict DAG, no self-loops, all IDs
  resolve within the file.
- `occupations` / `topics` — comma-separated slugs from embedding match +
  ESCO/O\*NET direct tags.
- `grade_start` / `grade_end` — integer grade (PK=-1, K=0, 1-12), populated for
  OpenSALT standards.

### build/ — Intermediate Stage Outputs

Caches for per-stage resumption. Key files:

- `1_skills.tsv` — post-parse, post-dedupe skill list (id, title, description,
  sources, tags). `1_stats.json` — its per-source counts.
- `1m_lc_ids.tsv` — Learning Commons node id to skill id (`node_id, skill_id`),
  written by stage `list`.
- `1b_infill.tsv`, `1c_summarize.tsv`, `1d_onet_desc.tsv`,
  `1e_opensalt_desc.tsv`, `1f_translate.tsv`, `1g_bncc_translate.tsv` — Ollama
  enrichment caches, `key<TAB>value`.
- `1e_seed_edges.tsv` — resolved expert-labeled prereq pairs from
  Khan/AL-CPL/Metacademy/MOOCCubeX/courses/OpenSALT.
- `1e_unresolved.tsv` — seed pairs that failed to resolve, with a reason per
  label (below-cos / no-token-overlap / no-match).
- `1j_lcsh_tree.tsv`, `1k_dbpedia_tree.tsv` — SKOS broader-chain caches:
  `slug → ancestor_slugs`. `1l_topic_refs.tsv` — topic labels, one per line.
- `2_embeddings.bin` (float32 × 768 × N), `2_ids.tsv`, `2_pathological.tsv` (ids
  whose vectors collide), `2_cache.bin` (SHA256 → vector).
- `3_tagged.tsv`, then `3b_tagged_deduped.tsv` and `3b_aliases.tsv`.
- `4_difficulty.tsv` (id, band, raw), `4_stats.json` (anchor agreement and seed
  counts, read by stage `status`). `raw` ignores seeds; only `band` holds the
  seed order.
- `5_prereqs.tsv` — LLM picks: `skill<TAB>p1,p2` or `skill<TAB>none`.
- `6_edges.tsv` — post-processed DAG edges (skill_id, prereq_id), transitively
  reduced: no edge is implied by a path of other edges.
