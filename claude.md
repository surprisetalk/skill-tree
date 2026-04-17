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
- **translations.json** — Chinese→English translations of concept labels, generated by `data/translate.ts`. Labels are translated to English in `pipeline.ts` to enable cross-dataset merging

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

## Scripts

### pipeline.ts — Unified Skill Extraction Pipeline

`deno run -A pipeline.ts [stage]` — stages: `list`, `enrich`, `trees`, `seed-edges`, `embed`, `tag`, `dedupe`, `difficulty`, `prereq`, `postproc`, `finalize` (default: all).

Monolithic Deno script (~3,000 lines, Ollama-only). Parses datasets into a unified schema, embeds via Ollama `nomic-embed-text`, assigns occupations/topics, dedupes, infers difficulty (isotonic PAV + kNN smoothing), ranks prerequisites via Ollama (`gpt-oss:20b` by default), breaks cycles, and emits `skills.tsv`. Stage outputs cached in `build/`.

**Stages** (run in order or individually): `list`, `enrich`, `trees`, `seed-edges`, `embed`, `tag`, `dedupe`, `difficulty`, `prereq`, `postproc`, `finalize`.

**Parsers**:
- Stage `list`: ESCO, O\*NET (Skills/Knowledge/Abilities/Tasks/DWAs/Tech), Lightcast, OpenSALT (96 frameworks).
- Stage `seed-edges`: Khan Academy, AL-CPL, Metacademy, MOOCCubeX, OpenSALT precedes, OpenSALT within-framework grade ordering. Pairs resolved to skill IDs via exact match then embedding fallback (cosine ≥ `SEED_FALLBACK_COS` default 0.90 + token overlap). Unresolved pairs quarantined to `build/1e_unresolved.tsv` with per-label reason; embedding requests retry up to 3× with exponential backoff.
- Stage `trees`: LCSH (gunzip + stream N-Triples) and DBpedia (bzcat + stream) SKOS broader chains, cached as `slug → ancestors[]`.

**LLM enrichment** (stage `enrich`, Ollama): fill missing Lightcast descriptions; summarize long OpenSALT/O\*NET-task titles into 3-7 word names; expand short O\*NET task statements. Resumable via tab-separated cache files (`1b_infill.tsv`, `1c_summarize.tsv`, `1d_onet_desc.tsv`). Applied back by re-running `list`.

**Prereq inference** (stage `prereq`, Ollama): per-skill top-K candidate ranking via cosine similarity (within-topic + ancestor + cross-topic pools), then LLM picks true prerequisites. Resumable via `5_prereqs.tsv` cache. Set `SKIP_LLM=1` to use existing cache only.

**Merge step** (stage `dedupe`): token-sort signature merge + per-topic Jaccard+cosine merge. Canonical ID = shortest title. Dropped IDs become aliases in `3b_aliases.tsv`; stages 6/7 remap edges through it.

**Env vars**: `OLLAMA_HOST` (default `http://localhost:11434`), `OLLAMA_GEN_MODEL` (default `gpt-oss:20b`), `OLLAMA_CONCURRENCY`, `EMBED_CONCURRENCY`, `SKIP_LLM`, `SKILL_LIMIT`, plus stage-specific tuning knobs (`OCC_TOP_K`, `TOPIC_TOP_K`, `PREREQ_K`, `PREREQ_PICK_CAP`, `KNN_K`, `DEDUPE_COSINE`, `PER_TOPIC_CAP`, `HUB_CAP`, `SEED_FALLBACK_COS`, `BF_SIM`, `BF_SIM_ZERO_ZERO` etc.).

### data/translate.ts — Chinese Label Translator

`ANTHROPIC_API_KEY=... deno run --allow-read --allow-write --allow-net --allow-run data/translate.ts`

One-time script that extracts Chinese labels from MOOCCubeX (~2k Simplified Chinese concepts), translates them to English via Claude API (Haiku, batches of 100), and writes `data/mooccubex/translations.json`. Caches results — skips labels already in the existing JSON file.

### data/download.ts — Dataset Downloader

`deno run --allow-read --allow-write --allow-net --allow-run data/download.ts`

Downloads all datasets from their sources. Implements caching (skips existing files).

## Output Files

Generated by `pipeline.ts` into the project root. Gitignored.

### skills.tsv / skills.tsv.gz — Unified Skill Table

~65k rows. Columns: `id, title, display_title, description, difficulty, prereqs, occupations, topics, grade_start, grade_end`

- `id` — slugified title (lowercase, hyphens, ≤80 chars; hex-hashed suffix for overflow).
- `display_title` — title truncated to ≤80 chars (or `code:XXX` tag for OpenSALT codes); for UIs that can't render long compliance statements.
- `difficulty` — integer band 1-20 derived from grade anchors (OpenSALT `educationLevel` + Khan V-Position) via kNN smoothing and isotonic PAV calibration.
- `prereqs` — comma-separated prereq IDs. Strict DAG, no self-loops, all IDs resolve within the file.
- `occupations` / `topics` — comma-separated slugs from embedding match + ESCO/O\*NET direct tags.
- `grade_start` / `grade_end` — integer grade (PK=-1, K=0, 1-12), populated for OpenSALT standards.

### build/ — Intermediate Stage Outputs

Caches for per-stage resumption. Key files:

- `1_skills.tsv` — post-parse, post-dedupe skill list (id, title, description, sources, tags).
- `1b_infill.tsv`, `1c_summarize.tsv`, `1d_onet_desc.tsv` — Ollama enrichment caches.
- `1e_seed_edges.tsv` — resolved expert-labeled prereq pairs from Khan/AL-CPL/Metacademy/MOOCCubeX/OpenSALT.
- `1e_unresolved.tsv` — seed pairs that failed to resolve, with per-label reason (embed-failed / below-cos / no-token-overlap / no-match).
- `1j_lcsh_tree.tsv`, `1k_dbpedia_tree.tsv` — SKOS broader-chain caches: `slug → ancestor_slugs`.
- `2_embeddings.bin` (float32 × 768 × N), `2_ids.tsv`, `2_cache.bin` (SHA256 → vector).
- `3_tagged.tsv` (+ `3b_tagged_deduped.tsv`, `3b_aliases.tsv`).
- `4_difficulty.tsv` (id, band, raw).
- `5_candidates.tsv` (skill → candidate prereq indexes), `5_prereqs.tsv` (Ollama responses as resolved IDs).
- `6_edges.tsv` — post-processed DAG edges (skill_id, prereq_id).
- `7_stats.json` — final graph stats (emitted, edges, roots, reachable).

