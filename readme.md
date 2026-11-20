# skill-tree

Aggregates open datasets into a unified skill prerequisite graph.

## Setup

```sh
git config core.hooksPath .githooks  # pre-commit runs audit + check + test
```

## Run

```sh
deno run -A pipeline.ts            # all stages, then status
deno run -A pipeline.ts seed-edges # one stage
deno task check                    # fmt, lint, typecheck
deno task test                     # runs stage list for real, in seconds
deno task status                   # grades the last full build; exits 1 on a failing condition
sh build/chain/chain.sh prereq     # one stage, then every later stage (load .env first for enrich and prereq)
```

Stages, in order: `list` → `enrich` → `trees` → `embed` → `tag` → `dedupe` →
`seed-edges` → `difficulty` → `prereq` → `snap` → `postproc` → `finalize` →
`status`. `pipeline.ts` dispatches them; `sources.ts`, `graph.ts`, and
`prereq.ts` hold them; `lib.ts` holds what they share.

Final output: `skills.tsv`
(`id title display_title description difficulty prereqs occupations topics grade_start grade_end`).
Per-stage caches live in `build/`.

Requires a local Ollama at `localhost:11434` with `nomic-embed-text`
(embeddings), and `ANTHROPIC_API_KEY` for stages `enrich` and `prereq`, which
generate text with Claude Haiku 5.5 through the Batches API. `SKIP_LLM=1` makes
stage `prereq` reuse `build/5_prereqs.tsv` as is.

The dataset catalog, schemas, and stage details follow the Attributions.

## Attributions

Common Standards Project (`data/csp/`): each standard set states its own licence
in its `license` field. Both licences require credit to the rights holder, a
link to the licence, and a note of changes.

- CC BY 4.0 US (http://creativecommons.org/licenses/by/4.0/us/): most sets,
  mainly Common Curriculum, Inc.
- CC BY 3.0 US (http://creativecommons.org/licenses/by/3.0/us/): sets of
  Desire2Learn Incorporated (D2L Corporation).
- No licence stated: some sets, with the rights holder only. Run
  `gzip -dc data/csp/<setId>.json.gz | jq .data.license` to read one.

A skill that merges a CSP and an OpenSALT standard of one code keeps both
sources, so both credits apply.

Oak National Academy (`data/oak/`): Open Government Licence v3.0
(https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3).
Credit: "Contains Oak National Academy curriculum data, licensed under the Open
Government Licence v3.0."

Skills England (`data/skillsengland/`): every product built on this data must
show the Skills England logo and this statement:

> © Skills England 2025 This information is licensed under the Open Government
> Licence
> https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3

Both crawls need a key in `.env`: `OAK_API_KEY` and `DWP_OCC_API_KEY`. Git
tracks the raw API bodies, so stage `list` needs no key.

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

**Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv** — prerequisite
pairs mapped to Wikipedia:
`prereq_wiki_canonical_title preq, MA preq, MA concept, concept_wiki_canonical_title_concept`

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
  topic pair. A code with no course, two titles, an empty title, a code-only
  title ("CEN 271"), or a wrapper-only topic ("Practicum II", `no-topic`), and a
  pair of one topic ("Calculus I" → "Calculus II"), go to `1e_unresolved.tsv`
  with that reason. Each topic pair keeps the direction more institutions give
  (`minority-order`); a tie drops both (`contested-order`).

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

### data/junyi/ — Junyi Academy Crowd Prerequisite Ratings (gitignored)

PSLC DataShop dataset 1198 (Chang et al., EDM 2015). The licence bars commercial
use, so git does not track it, and no stage reads it: `deno task
status` grades
the edges against it. A DataShop login downloads it by hand (tab Files).

- **relationship_annotation_training.csv**,
  **relationship_annotation_testing.csv** —
  `Exercise_A, Exercise_B, …, Prerequisite_avg, Prerequisite_raw`: crowd scores
  1–9. `readJunyi` (`lib.ts`) reads Exercise_B as the prereq of Exercise_A and a
  mean over 5 as a positive; an exercise name `addition_2` reads as "addition".
- **junyi_Exercise_table.csv**, **README.txt** — the exercises (Chinese display
  names, Junyi's own prereq links) and the licence.

### data/bncc/ — Brazil's National Curriculum (BNCC, gzipped JSON)

From github.com/bncc-dev/bncc-dados at the commit pinned in `data/download.ts`.
Data CC BY 4.0: credit "bncc.dev (maintained by Profy)" with a link to the repo.
Git tracks the gzips, because jj refuses a new file over 1 MiB.

- **educacao-infantil.json.gz** — `objetivos[]`: `codigo, texto, grupo_etario`.
- **ensino-fundamental.json.gz** — `habilidades[]`: `codigo, texto, anos[]`.
- **ensino-medio.json.gz** — `habilidades[]`: `codigo, texto, area`.
- The code holds grade and subject: `EF67LP08` is grades 6–7, Portuguese.
  `EI01`–`EI03` are age bands to 5 years (grade PK). `EM13` is grades 10–12.
- Stage `enrich` translates each `texto` with Claude into
  `build/1g_bncc_translate.tsv`, keyed by code. Stage `list` throws on a code
  with no translation.

### data/csp/ — Common Standards Project (gzipped JSON, tracked in git)

From api.commonstandardsproject.com/api/v1 (no key). `data/download.ts` writes
each standard set's raw API body to **{setId}.json.gz**. A set has `subject`,
`educationLevels`, `document.publicationStatus`, `jurisdiction`, `license`, and
`standards` keyed by id (`statementNotation`, `description`, `depth`,
`parentId`). Each set states its own licence (CC BY 4.0 US or CC BY 3.0 US);
1,508 state none. Stage `list` reads every set.

- TODO: You: ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN's
  reply. You sent the bulk-access request through
  `asn.desire2learn.com/content/contact-us` (12 Nov).
  1. Only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). CSP first imported its
     states from ASN, so ASN adds mostly duplicates.

### data/oak/ — Oak National Academy (gzipped JSON, tracked in git)

England's school curriculum, KS1–KS4, OGL v3. The API at
open-api.thenational.academy needs `OAK_API_KEY` and allows 1000 calls an hour,
so `data/download.ts` crawls one file at a time and resumes. Raw API bodies:

- **index.json.gz** — `{sequences: {subject: [sequenceSlug]}, units: [slug]}`.
  It is written last, so it marks a finished crawl.
- **sequences/{slug}.json.gz** — `/sequences/{slug}/units`: one block per year,
  holding `units`, `tiers[].units`, or `examSubjects[]` with `units` or `tiers`.
  A unit has `unitOrder`, `unitSlug` or `unitOptions[]`, and `threads[]`.
- **units/{slug}.json.gz** — `/units/{slug}/summary`: `unitTitle`,
  `description`, `year` (England's Year 1–11), `priorKnowledgeRequirements[]`.

### data/skillsengland/ — Skills England Apprenticeship Standards (gzipped JSON)

Occupational maps API, OGL v3; every derived product shows the Skills England
logo and its attribution (readme). Needs `DWP_OCC_API_KEY` (header `X-API-KEY`).

- **index.json.gz** — every `stdCode`, written last.
- **occupations/{stdCode}.json.gz** —
  `/Occupations/{stdCode}?expand=occupation.dutiesKSB`: `name`, `level` (2–7),
  `statusName`, and `knowledges[]`, `skills[]`, `behaviours[]`, each with
  `detail`. Stage `list` reads knowledge and skill statements only.

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
`prereq`, `snap`, `postproc`, `finalize`, `status`.

| File          | Holds                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| `pipeline.ts` | Entry point: stage dispatch and stage `status`.                        |
| `lib.ts`      | Names that two files share: text cleanup, TSV/CSV, Claude, embeddings. |
| `sources.ts`  | Stages `list`, `enrich`, `trees`, `seed-edges`.                        |
| `graph.ts`    | Stages `embed`, `tag`, `dedupe`, `difficulty`.                         |
| `prereq.ts`   | Stages `prereq`, `snap`, `postproc`, `finalize`.                       |
| `worker.ts`   | One core's share of the prereq candidate or nearest-skill search.      |

Parses datasets into a unified schema, embeds via Ollama `nomic-embed-text`,
assigns occupations/topics, dedupes, infers difficulty (isotonic PAV + kNN
smoothing), ranks prerequisites via Claude Haiku 5.5, breaks cycles, and emits
`skills.tsv`. Stage outputs live in `build/`.

**Parsers**:

- Stage `list`: ESCO, O\*NET (Skills/Knowledge/Abilities/Tasks/DWAs/Tech),
  Lightcast, OpenSALT, Learning Commons, DigComp, Cert Atlas, BNCC, CSP, Oak,
  Skills England, and the hubs in `data/_foundations.json`. Each Oak unit is one
  skill with source `oak`, tags `oak:<unitSlug>` and `grade:*` (Year N is grade
  N−1; Year 1 is K). Each Skills England knowledge or skill statement is one
  skill with source `skillsengland`, tag `occupation:<slug>`, which stage `tag`
  reads as a direct occupation, and tag `skillsengland:level:<n>`. Each leaf
  standard of a current CSP set is one skill with source `csp`, tags `csp`,
  `grade:*` when the set names at most 4 grades, and `code:<statementNotation>`
  unless the notation lists several codes; a standard that parents another is a
  heading. Each BNCC objective is one skill with source `bncc`, tags
  `bncc:objective`, `bncc:subject:*`, `grade:*`, and `code:<codigo>`. Each Cert
  Atlas objective is one skill with source `certatlas`, no tags, and a
  description of exam, certifying body, domain, and sub-objectives; a title with
  no Latin letter is dropped and counted. Each DigComp LearningOutcome is one
  skill with tags `digcomp:outcome`, `digcomp:area:*`, `digcomp:competence:*`,
  and `digcomp:level:*`; stage `seed-edges` turns the levels into seed order. An
  OpenSALT item with no `educationLevel` takes its nearest `isChildOf`
  ancestor's. Each item of a framework that grades no item (SCED, Praxis) gets
  `opensalt:ungraded-framework`. OpenSALT statements parse as HTML with
  `deno-dom`; a `script`, `style`, or head element in one stops the stage.
  Learning Commons statements parse the same way and pass the same scaffolding
  filters (`cleanStandard`). A component is one skill with tag
  `learningcommons:component`, plus `grade:*` when it names at most 4 grades. A
  standard is one skill per distinct statement, tags `learningcommons:standard`,
  `grade:*` from each item that names at most 4 grades, and
  `code:<statementCode>`. A `buildsTowards` endpoint also gets
  `learningcommons:coherence` and skips the long-title drop. Other sources keep
  `<…>` as text.
- Stage `seed-edges`: Khan Academy, AL-CPL, Metacademy, course prerequisites,
  Oak (`oak_thread`: within one track — primary, then one exam board, exam
  subject, and tier — a unit precedes the next unit of each of its threads),
  OpenSALT within-framework grade ordering, Learning Commons `buildsTowards`,
  DigComp level order (within one competence, each outcome of a level precedes
  each outcome of the next; a merged outcome sits at its lowest level). Learning
  Commons resolves through `build/1m_lc_ids.tsv` and `3b_aliases.tsv`, not by
  label. A pair with an end that stage `list` dropped goes to
  `build/1e_unresolved.tsv` with reason `no-skill`. Pairs resolve to skill IDs
  by exact match (case, plurals, and -ing/-ed folded, unless two skills share
  the fold), then by embedding (cosine ≥ 0.90 and a shared token). An exact
  scan, split across one worker per core, finds each label's nearest skill.
  Unresolved pairs go to `build/1e_unresolved.tsv` with a reason per label. A
  source that gives both A → B and B → A loses both, as does a course pair
  inside a seed cycle (`contested-order`): expert sources outrank course
  catalogs. Each Khan exercise resolves through the `khan:<slug>` tag of its
  OpenSALT item.
- Stage `trees`: LCSH (gunzip) and DBpedia (bzcat) SKOS broader chains, cached
  as `slug → ancestors[]`. The same pass picks each dump's 5000 most-used
  broader targets as the topic refs of stage `tag`.

**LLM enrichment** (stage `enrich`): fill missing Lightcast descriptions;
summarize each title over 120 characters or with a slug over 80 into a 3-7 word
name; expand short O\*NET task statements and OpenSALT standards; translate BNCC
objectives (first, since stage `list` needs them). Resumable via the `1b`–`1g`
caches. Stage `list` applies them on its next run.

**Prereq inference** (stage `prereq`): per-skill top-K candidates by cosine
similarity (within-topic + ancestor + cross-topic pools; an IVF index serves the
big pools), then the LLM picks true prerequisites. Then Claude names each
skill's prereqs (`5b_expand.tsv`). Stage `snap` matches each name, and each Oak
`priorKnowledgeRequirements` statement, to a skill: an exact match, else Claude
picks from the name's 10 nearest skills (`5c_snap.tsv`, keyed by name slug).
Stage `postproc` adds these named edges, less one whose prereq has a higher
Skills England level than its dependent (stage `prereq` keeps such a pair out of
the candidate pool too); one whose dependent has no anchor skips the easier-than
check, and the chain lift orders its bands. One across two languages drops.
Resumable via the three caches; a row that names an id outside the build, or a
pick no easier than its skill, drops, and its prompt goes out again.

**Merge step** (stage `dedupe`): token-sort signature merge + per-topic
Jaccard+cosine merge + code candidates (a Learning Commons or CSP row and an
OpenSALT row that share a `code:*` tag, cosine ≥ 0.90; a `hasStandardAlignment`
pair, cosine ≥ 0.96). Two groups whose `grade:*` tags share no grade never
merge: they are two steps of a progression. Canonical ID = shortest title.
Dropped IDs become aliases in `3b_aliases.tsv`; stages `postproc` and `finalize`
remap edges through it.

### data/download.ts — Dataset Downloader

Downloads all datasets from their sources; the command sits in `claude.md`.

### Checks

- `deno task check` — fmt, lint, typecheck.
- `deno task test` — runs stage `list` for real (no Ollama) in a temp dir, on
  every source but a fixed sample of 200 CSP sets, and asserts on its output
  (`deno task status` reruns its title checks, `listDefects`, on every row),
  plus fixture runs of the other stages. Keep it under 10 s: start each fixture
  run at module load so the runs overlap.
- `deno task status` — grades the last full build; exits 1 when any condition
  scores below 1.0. snitch runs it hourly. Three conditions grade the edges
  against the LectureBank pairs, and three against the Junyi pairs: the
  matched-pair count, precision, and recall. `status` resolves the topic names
  with `resolveConcept`, then `embeddingFallback` (`lib.ts`, shared with stage
  `seed-edges`; it calls Ollama for names with no exact skill, and the embedding
  cache keeps later runs offline). Precision counts the `skills.tsv` edges whose
  pair an expert annotated. Recall counts the positive pairs inside the
  transitive closure.

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
- `difficulty` — integer band 1-20: when a typical learner can first learn the
  skill. Grade anchors (OpenSALT `educationLevel`, Learning Commons and BNCC
  grades) and Khan V-Position set it through kNN smoothing and isotonic PAV
  calibration; job zones and DigComp levels anchor nothing. One pass then puts
  each expert seed prereq at least one band below its dependent. A skill with
  its own label (grade, Khan position) sits in that label's band and never
  moves; kNN sets the others, workplace skills included. Pairs join in file
  order while every skill still fits a band; a pair that cannot fit, or sits in
  a cycle, is dropped and counted in `4_stats.json` (`seed_anchor_ties` when two
  anchors share a band, else `seed_anchor_conflicts`, per source in
  `seed_anchor_conflicts_by_source`). Stage `postproc` keeps every seed edge
  either way, as an edge or as a path after the transitive reduction, except an
  edge from a subject area (a skill whose id is the topic of 50 or more skills,
  `SUBJECT_MIN`) to a skill that carries it as a topic, and a course seed whose
  prereq sits in a higher band than its dependent. Stage `finalize` then lifts
  along the final edges: an unanchored skill sits at least one band above each
  prereq, and below each anchored skill above it, so a long chain carries a
  skill past grade 12. The lift moves a skill at most 4 bands (`LIFT_CAP`). A
  non-seed edge whose prereq ends above that limit drops; one that ends in the
  same band stays as a tie.
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
  `1e_opensalt_desc.tsv`, `1g_bncc_translate.tsv` — LLM enrichment caches,
  `key<TAB>value`.
- `1e_seed_edges.tsv` — resolved expert-labeled prereq pairs from
  Khan/AL-CPL/Metacademy/courses/Oak/OpenSALT/Learning Commons/DigComp.
- `1e_unresolved.tsv` — seed pairs that failed to resolve, with a reason per
  label (below-cos / no-token-overlap / no-match).
- `1j_lcsh_tree.tsv`, `1k_dbpedia_tree.tsv` — SKOS broader-chain caches:
  `slug → ancestor_slugs`. `1l_topic_refs.tsv` — topic labels, one per line.
- `2_embeddings.bin` (float32 × 768 × N), `2_ids.tsv`, `2_pathological.tsv` (ids
  whose vectors collide), `2_cache.bin` (SHA256 → vector).
- `3_tagged.tsv`, then `3b_tagged_deduped.tsv` and `3b_aliases.tsv`.
- `4_difficulty.tsv` (id, band, raw, anchored), `4_stats.json` (anchor agreement
  and seed counts, read by stage `status`). `raw` ignores seeds; only `band`
  holds the seed order, and `skills.tsv` adds the chain lift.
- `5_prereqs.tsv` — LLM picks: `skill<TAB>p1,p2` or `skill<TAB>none`.
- `5b_expand.tsv` — named prereqs: `skill<TAB>name; name` or `skill<TAB>none`.
  `5c_snap.tsv` — `name-slug<TAB>skill-id` or `name-slug<TAB>none`.
- `6_edges.tsv` — post-processed DAG edges (skill_id, prereq_id), transitively
  reduced: no edge is implied by a path of other edges.

## Pending design

Evidence for each note: `research.md`.

- The prereq DAG stays the source of truth. Embeddings serve only candidate
  retrieval, dedupe, and interest ranking. Alternative: learned box or order
  embeddings that encode the partial order. They need training labels, lose hand
  edits, and cannot explain a path to a goal.
- `skills.tsv` keeps one edge type, prereq, and topics keep the hierarchy.
  Sponge derives implicit-review credit from prereq edges with one fixed weight.
  Alternative: an LLM-scored "encompasses" weight (0–1) per edge, as Math
  Academy sets by hand. It costs one more LLM pass and one more column before
  learner data shows that the fixed weight fails.
- `skills.tsv` gets a `sources` column, and `lib.ts` maps each source to its
  licence and attribution string. The readme lists the attributions.
  Alternative: drop every non-commercial or copyleft source. Junyi is eval only,
  and MOOCCubeX (GPL-3.0) is gone.
- Git tracks a filtered extract of Learning Commons
  (`data/learningcommons/graph.jsonl.gz`, CC BY 4.0), and `data/download.ts`
  streams the 986 MB export to build it. The extract keeps the rows of current
  frameworks, every `attributionStatement` once, and the edges that stages
  `dedupe` and `seed-edges` read. Alternative: keep the raw jsonl, gitignored.
  Then `deno task test` fails on a fresh clone until a 986 MB download ends.
- Stage `list` writes `build/1m_lc_ids.tsv` (node id to skill id), so that
  `buildsTowards` and `hasStandardAlignment` edges resolve exactly. Alternative:
  an `lc:<id>` tag per node. It needs no file, but the tag cap of 20 loses most
  nodes of a statement that fifty states repeat.
- Stages `prereq` and `difficulty` stay. A top-down LLM tree does not replace
  them yet. Example from the pilot (`deno run -A pipeline.ts pilot`, report in
  `build/pilot_stats.json`): Electricians → National Electrical Codes → … →
  Professional Communication → Instructional Design → … → Applied Behavior
  Analysis. From 20 roots the pilot reached 5,953 nodes; 47% matched no skill,
  3,019 edges closed a cycle, chains ran 100 to 380 steps, and 22% of edges
  between banded skills climbed a band. The tree drifts sideways through lateral
  prereqs and wrong snaps ("checking responsiveness" in CPR became
  `viewport-meta-tag`). On the 50 expert positives it reached, its closure
  recalls 42% against 12% for `skills.tsv`, but it also holds 17% of the
  negatives against 1%. Alternative: switch now. It needs a guard that each
  prereq is easier than its skill, and a stricter snap, before the tree
  converges.
