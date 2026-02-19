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

**article_categories_en.ttl.bz2** (225M compressed) — maps Wikipedia articles to categories via `dcterms:subject`. URI pattern: `http://dbpedia.org/resource/{Article_Name}` → `http://dbpedia.org/resource/Category:{Category_Name}`
