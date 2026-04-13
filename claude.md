# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

skill-tree aggregates open datasets to build a skill prerequisite graph. Data sources span occupational taxonomies, educational prerequisites, and knowledge graphs. See `todo.md` for data source tracking.

## Datasets

All data lives in `data/`. Schemas below.

### data/esco/ — European Skills/Occupations (19 CSVs)

EU taxonomy of 13,890+ skills linked to ~3,000 occupations. Key files:

- **skills_en.csv** — `conceptType, conceptUri, skillType, reuseLevel, preferredLabel, altLabels, hiddenLabels, status, modifiedDate, scopeNote, definition, inScheme, description`
- **occupations_en.csv** — `conceptType, conceptUri, iscoGroup, preferredLabel, altLabels, hiddenLabels, status, modifiedDate, regulatedProfessionNote, scopeNote, definition, inScheme, description, code, naceCode`
- **occupationSkillRelations_en.csv** (largest, 28M) — `occupationUri, occupationLabel, relationType, skillType, skillUri, skillLabel`. relationType is "essential" or "optional"; skillType is "knowledge" or "skill/competence"
- **skillSkillRelations_en.csv** — `originalSkillUri, originalSkillType, relationType, relatedSkillType, relatedSkillUri`. Inter-skill relationships (optional, prerequisite)
- **broaderRelationsSkillPillar_en.csv** — `conceptType, conceptUri, conceptLabel, broaderType, broaderUri, broaderLabel`. Skill hierarchy
- **skillGroups_en.csv** — ISCED-F skill groupings with `code` field

All entities use URI identifiers for semantic linkage.

### data/onet/ — U.S. O*NET (44 TSV files)

1,016 occupations with quantitative ratings. Common column structure: `O*NET-SOC Code, Element ID, Element Name, Scale ID, Data Value, N, Standard Error, Lower CI Bound, Upper CI Bound, Recommend Suppress, Not Relevant, Date, Domain Source`. Scale IDs: IM (Importance), LV (Level).

Key files:
- **Occupation Data.txt** — `O*NET-SOC Code, Title, Description`
- **Skills.txt** — 35 skills rated per occupation
- **Knowledge.txt** — 33 knowledge areas rated per occupation
- **Abilities.txt** — 52 abilities rated per occupation
- **Work Activities.txt** (37M, largest) — activity ratings
- **Task Statements.txt** — `O*NET-SOC Code, Task ID, Task, Task Type, Incumbents Responding, Date, Domain Source`
- **Task Ratings.txt** — frequency/importance ratings per task
- **Technology Skills.txt** — specific tools/software per occupation
- **Education, Training, and Experience.txt** — requirements
- **Interests.txt** — RIASEC codes

### data/lightcast/ — Lightcast Open Skills (1 JSON file)

**skills.json** — Array of 32,000+ skill objects:
```json
{
  "id": "KS126XS6CQCFGC3NG79X",
  "infoUrl": "https://skills.emsidata.com/skills/...",
  "name": ".NET Assemblies",
  "type": {"id": "ST1", "name": "Specialized Skill"}
}
```
Top-level also has `attributions` array.

### data/course-skill-atlas/ — Education-to-Employment Mapping (~10 files)

Maps 3M+ course syllabi to O*NET categories. Key files:
- **manhattan_euclidean_distances_all.csv** (250M) — pairwise distance matrix between fields of study/occupations
- **abilities_scores.gzip** — occupational abilities scores
- **ipeds_2digit_grads_2000_2017.csv** — graduation counts by institution/field/year (2000–2017)
- **top10_DWA_per_FOS.csv** — top 10 Detailed Work Activities per Field of Study
- **field_name_and_code.csv** — field of study classification codes
- **institution_fos_year.gzip** — institution × field × year data

### data/lcsh/ — Library of Congress Subject Headings (1 gzipped N-Triples file)

~512,000 SKOS concepts spanning all fields of knowledge, curated by the Library of Congress. Downloaded from https://id.loc.gov/download/.

**subjects.skosrdf.nt.gz** (95M compressed, ~1GB decompressed) — N-Triples RDF. Each subject heading is a `skos:Concept` with:
- `skos:prefLabel` — canonical English label
- `skos:altLabel` — variant forms
- `skos:broader` / `skos:narrower` — hierarchical relations (~300k broader links)
- `skos:related` — associative relations
- `skos:inScheme` — all belong to `<http://id.loc.gov/authorities/subjects>`
- `skos:changeNote` — provenance/revision metadata via blank nodes

URI pattern: `http://id.loc.gov/authorities/subjects/sh{id}`

### data/dbpedia/ — DBpedia Category Hierarchy (2 bzip2 Turtle files)

Wikipedia's category graph extracted by DBpedia (2016-10 release). Downloaded from https://downloads.dbpedia.org/2016-10/core-i18n/en/.

**skos_categories_en.ttl.bz2** (44M compressed) — ~1.47M SKOS categories with ~3.08M `skos:broader` edges. Each category is a `skos:Concept` with `skos:prefLabel` and `skos:broader` links to parent categories. URI pattern: `http://dbpedia.org/resource/Category:{Name}`

**article_categories_en.ttl.bz2** (225M compressed, gitignored) — maps Wikipedia articles to categories via `dcterms:subject`. URI pattern: `http://dbpedia.org/resource/{Article_Name}` → `http://dbpedia.org/resource/Category:{Category_Name}`

### data/al-cpl/ — Expert Prerequisite Pairs (8 files)

From github.com/harrylclc/AL-CPL-dataset. Expert-labeled concept prerequisite pairs across 4 domains: Data Mining, Geometry, Physics, Precalculus. CC BY 4.0.

- **data/*.pairs** — all concept pairs considered: `ConceptA,ConceptB` (Wikipedia article titles)
- **data/*.preqs** — confirmed prerequisite pairs: `Prerequisite,Target` (subset of .pairs where experts agreed A is prerequisite of B)
- **features/** — precomputed features for prerequisite prediction models

### data/metacademy/ — ML/AI Concept Prerequisite Graph (393 concepts)

Two sources combined:

**metacademy-content/concepts/{name}/** — 393 ML/AI concepts, each a directory with:
- `title.txt` — concept name
- `dependencies.txt` — prerequisite concepts as `tag: {concept_id}` + `reason:` pairs
- `summary.txt`, `goals.txt`, `resources.txt`

**Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv** — 7,947 prerequisite pairs mapped to Wikipedia: `prereq_wiki_canonical_title preq, MA preq, MA concept, concept_wiki_canonical_title_concept`

### data/mooccubex/ — MOOCCubeX Prerequisites (3 JSONL files, gzipped in git)

From github.com/THU-KEG/MOOCCubeX. Concept prerequisite pairs with model predictions for CS, math, and psychology (Chinese university MOOCs). Each line is a JSON object:

```json
{"c1": "函数的定义域", "c2": "欧拉函数", "ground_truth": 1, "text_predict": [0.03, 0.97], "graph_predict": [0.02, 0.98]}
```

- `c1` → `c2` prerequisite direction; `ground_truth`: 1 = confirmed prerequisite
- **cs.json.gz** (24M), **math.json.gz** (16M), **psy.json.gz** (27M)
- Uncompressed .json files are gitignored
- **translations.json** — Chinese→English translations of concept labels, generated by `data/translate.ts`. Labels are translated to English in `main.ts` to enable cross-dataset merging

### data/assistments/ — ASSISTments 2009-2010 (1 CSV, gzipped in git)

K-12 math tutoring interactions from ASSISTments platform. ~346,860 interactions across ~110 knowledge components.

**skill_builder_data.csv.gz** (11M compressed, 79M uncompressed) — columns: `order_id, assignment_id, user_id, assistment_id, problem_id, original, correct, attempt_count, ms_first_response, tutor_mode, answer_type, sequence_id, student_class_id, position, type, base_sequence_id, skill_id, skill_name, teacher_id, school_id, hint_count, hint_total, overlap_time, template_id, answer_id, answer_text, first_action, bottom_hint, opportunity, opportunity_original`

### data/junyi/ — Junyi Academy (Taiwanese Khan Academy fork)

722 math exercises with 4-level topic hierarchy and 26M+ student interactions. CC BY-NC-SA 4.0. Downloaded from Kaggle.

- **Info_Content.csv** (380K) — exercise metadata: `ucid, content_pretty_name, content_kind, difficulty, subject, learning_stage, level1_id, level2_id, level3_id, level4_id`
- **Info_UserData.csv.gz** (3M) — anonymized user profiles
- **Log_Problem.csv** (2.8G, gitignored) — 26M+ interaction logs
- **translations.json** — Traditional Chinese→English translations of exercise labels, generated by `data/translate.ts`. Labels are translated to English in `main.ts` to enable cross-dataset merging

### data/khanacademy/ — Khan Academy Math Prerequisite Graph (1 TSV)

Community-mapped prerequisite graph of 1,487 Khan Academy math exercises, from counting (K) through calculus (AP). Source: [Google Sheets data map](https://docs.google.com/spreadsheets/d/1YiRwrDAuLx7K2NmPySs1K1GpR7Kxzfk5KjDTxpvP0rM/).

**khandata.tsv** — columns: `Code, Data Name, Prereq(s), H-Position, V-Position, Display Name, Link to Practice problem`

- `Code` — numeric ID (1–1487)
- `Data Name` — exercise slug (e.g. `counting-out-1-20-objects`)
- `Prereq(s)` — semicolon-separated prerequisite references; mixed numeric Codes and Data Name slugs
- `H-Position, V-Position` — layout coordinates for visualization (`x` = unpositioned)
- `Display Name` — human-readable exercise title
- `root` in Prereq(s) means no prerequisites

### data/opensalt/ — OpenSALT Standards Frameworks (96 CASE JSON files)

95 K-12 standards frameworks from opensalt.net in 1EdTech CASE format. Includes CCSS Math, NGSS, state standards (Alabama, Georgia, Indiana, Virginia, Oklahoma, Florida, etc.), plus specialty frameworks (CASEL, 21st Century Skills, AP CS).

**index.json** — list of all frameworks with `identifier` and `title`

**{uuid}.json** — each framework as a CASE package with:
- `CFDocument` — framework metadata
- `CFItems` — individual standards/competencies with GUIDs
- `CFAssociations` — relationships between items (including "precedes" prerequisite type)
- `CFDefinitions` — concept/license definitions

### data/ngss/ — NGSS Learning Progressions (2 PDFs)

- **AppendixE-Progressions.pdf** — Disciplinary Core Idea progressions across grade bands
- **AppendixF-Practices.pdf** — Science & Engineering Practices progressions

### data/hess-lpf/ — Hess Learning Progressions Frameworks (2 PDFs)

Karin Hess's K-12 learning progressions aligned to Common Core:
- **Math_LPF_KH11.pdf** — mathematics progressions
- **LPF-for-CCSS-ELA.pdf** — English Language Arts progressions

### data/asn/ — Achievement Standards Network (3 JSON-LD files)

ASN standards from asn.desire2learn.com as RDF/JSON-LD. Each standard is keyed by URI with properties including `rdf:type`, `dc:title`, `dc:description`, `skos:broader`/`skos:narrower`, `dcterms:subject`.

- **ngss.json** (916K) — NGSS performance expectations (document D2601214)
- **ccss-math.json** — Common Core State Standards for Mathematics (document D10003FB)
- **ccss-ela.json** — Common Core State Standards for ELA & Literacy (document D10003FC)

URI pattern: `http://asn.desire2learn.com/resources/S{id}`

### data/common-standards-project/ — US State Standards (JSON)

All US state + national standards from the Common Standards Project API (commonstandardsproject.com). Normalized and grouped by jurisdiction/subject/grade, derived from ASN but cleaned up.

- **jurisdictions.json** — index of all jurisdictions with `id`, `title`, `type` (state/nation/organization/school)
- **{jurisdiction_id}.json** — per-jurisdiction file containing:
  - `jurisdiction` — metadata (id, title, type, standardSets index)
  - `standardSets[]` — array of fully-expanded standard sets, each with:
    - `id`, `title`, `subject`, `educationLevels`
    - `document` — source document metadata (ASN document ID, title, valid date)
    - `standards` — object keyed by standard ID, each with `description`, `statementNotation` (e.g. "CCSS.Math.Content.8.F.B.5"), `depth`, `position`, `listId`, `asnIdentifier`

Coverage: 65 state/province jurisdictions, 323 organizations, 351 schools. ~38 standard sets for CCSS alone.

## Scripts

### main.ts — Unified Skill Extraction Pipeline

`deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write --allow-run main.ts`

Single monolithic Deno script (~700 lines) that parses all datasets into a unified schema, infers prerequisites from student interaction data, merges duplicate skills by label, and writes output files.

**Parsers** (14 datasets): Khan Academy, AL-CPL, Metacademy, O\*NET (Skills/Knowledge/Abilities), ESCO, Lightcast, MOOCCubeX, ASSISTments, Junyi, Common Standards Project (all 66 jurisdictions), OpenSALT (96 frameworks), ASN.

**Prereq inference**: Mines Junyi hierarchy (difficulty ordering within topic clusters), Junyi student logs (26M interactions, streaming — temporal mastery ordering with ≥20 student threshold, 80% directional ratio), and ASSISTments logs (same temporal approach, ≥10 students).

**Merge step**: Skills with identical labels (case-insensitive) collapse into one row. The canonical ID is the shortest non-hex-hash ID. Merged-away IDs become ext_ids. Prereq edges are rewritten to canonical IDs; self-loops and duplicates are dropped.

**Skipped datasets**: LCSH (1GB RDF), DBpedia (bzip2 Turtle), Course-Skill Atlas (distance matrix), NGSS/Hess PDFs.

### data/translate.ts — Chinese Label Translator

`ANTHROPIC_API_KEY=... deno run --allow-read --allow-write --allow-net --allow-run data/translate.ts`

One-time script that extracts Chinese labels from MOOCCubeX (~2k Simplified Chinese concepts) and Junyi (~1.3k Traditional Chinese exercises), translates them to English via Claude API (Haiku, batches of 100), and writes `translations.json` files. Caches results — skips labels already in existing JSON files.

### data/download.ts — Dataset Downloader

`deno run --allow-read --allow-write --allow-net --allow-run data/download.ts`

Downloads all datasets from their sources. Implements caching (skips existing files).

## Output Files

All generated by `main.ts` into the project root. Gitignored.

### skills.tsv / skills.tsv.gz — Unified Skill Table

~586k rows. Columns: `id, ext_ids, label, description, tags, grade_start, grade_end`

- `id` — prefixed by source: `khan.`, `alcpl.`, `metacademy.`, `onet.{skill|knowledge|ability}.`, `esco.`, `lightcast.`, `mooccubex.`, `assistments.`, `junyi.`, `csp.`, `opensalt.`, `asn.`
- `ext_ids` — semicolon-separated original IDs from merged duplicates (e.g. ASN identifiers, state-specific standard IDs)
- `tags` — semicolon-separated; includes source dataset, subject, domain, jurisdiction
- `grade_start/grade_end` — PK-12 (0-12), populated for CSP and OpenSALT standards
- Hierarchy encoded in dot-separated IDs (e.g. `csp.CCSS.Math.Content.8.F.B.5`) and tags, NOT in prereqs

### prereqs.tsv — Prerequisite Graph Edges

Pure learning-order edges (`type="prerequisite"` only). Columns: `skill_id, prereq_id, source, type, confidence`

- `source` — origin dataset: `khan`, `alcpl`, `metacademy`, `esco`, `esco_optional`, `opensalt`, `mooccubex`, `junyi_hierarchy`, `junyi_logs`, `assistments_logs`, `csp_grade`, `llm`, `ngss_progression`, `course_skill_atlas`

### taxonomy_edges.tsv — Taxonomic Containment Edges

All `type="broader"` edges plus any edge touching an LCSH/DBpedia node. Same schema as `prereqs.tsv`. Use for discovery / breadcrumbs; do NOT use for sequencing. Sources include `lcsh_broader`, `dbpedia_broader`, `wikidata_p279`.

### levels.tsv — O\*NET Dimension Ratings

120 rows. Columns: `skill_id, lvl_active_learning, lvl_mathematics, ...` (120 `lvl_*` columns)

Wide table with one column per O\*NET dimension (35 skills + 33 knowledge + 52 abilities). Values are mean Level ratings across all occupations.

### skills.dot — GraphViz Prerequisite Graph

Directed graph of all prereq relationships. Only includes skills involved in at least one prereq edge (~4.6k nodes, ~44k edges). Render with `dot -Tsvg skills.dot -o skills.svg`.

