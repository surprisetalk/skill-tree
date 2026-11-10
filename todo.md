## Next

Each entry below is a `deno task status` condition that fails on the full Claude
build of 9 Nov. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] Difficulty bands agree with seeds and grade anchors. Today: 481/3725 seed
      pairs fail to fit bands 1–20 (12.9%, floor 1%); 3216/32423 grade-anchored
      skills miss their band by over 5 (9.9%, floor 5%); about 12.8% of seed
      edges put the prereq in a higher band (floor 10%); about 93.8% of skills
      sit at or above every transitive prereq's band (floor 95%).
  1. In stage `difficulty`, count `seed_anchor_conflicts` per seed source into
     `4_stats.json`.
  2. Fix the source with the most conflicts first: drop its bad pairs in
     `seed-edges`, or fix the grade anchor that contradicts it.
  3. Rerun from `difficulty`, then read all four conditions again; one cause
     likely drives them all.

- [ ] At least 80% of seed edges survive into `skills.tsv`. Today 78.6%.
      `postproc` adds every seed (added=3489, dup=236).
  1. Count the seed edges each `postproc` step drops, transitive reduction
     included, and log the counts.
  2. If transitive reduction drops seeds that a path implies, count an implied
     seed as kept in the condition: the path holds the edge.

- [ ] At least 95% of OpenSALT skills carry a `grade:*` tag. Today 79.6%.
  1. Group the untagged OpenSALT skills by framework (`1_skills.tsv`).
  2. For the largest frameworks, inherit `educationLevel` from the parent CFItem
     through `isChildOf` in stage `list`.

- [ ] No skill has a hex-overflow id. Today 4,830 skills (5.3%) have an id of 70
      characters or more that ends in a 6-hex suffix (`slug_overflow=4015` in
      `build/chain/list.log`).
  1. Send each title whose slug overflows through the `enrich` summarize prompt
     (3–7 words), as long OpenSALT titles already are.
  2. Rerun from `enrich`; the summaries apply in stage `list`.

- [ ] Expert recall is above 0.05 (`EXPERT_RECALL_FLOOR`). Today 10/258 positive
      LectureBank pairs (0.039) sit in the transitive closure, and only 12
      `skills.tsv` edges join two annotated topics.
  1. List the 248 missed positives with both resolved skill ids.
  2. For each, check whether the prereq is in the dependent's candidate pool in
     stage `prereq`. If most are absent, widen the pool; if present, the picks
     miss them, so fix the prompt.
  3. 2,599 prereq prompts (3%) got a rejected answer and have no picks. Rerun
     `prereq` to send them again before you judge recall.

## Blocked on you

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account.
  1. Fetch dataset 1198 `relationship_annotation_training.csv` (1,131 pairs). It
     is non-commercial, so use it for eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: Common Standards Project (CSP)
      and ASN, everything they give, with no row bound. Blocker: ASN bulk access
      needs your email request. CSP needs no key.
  1. Finish the crawl: rerun `data/download.ts`; finished sets skip. It writes
     `data/csp/{setId}.json.gz`, the raw API body.
  2. Commit `data/csp/` if the full crawl stays under about 200 MB, else
     gitignore it. The first 10,032 of 24,969 sets take 85 MB.
  3. Stage `list` parses CSP standards like OpenSALT items: same scaffolding
     filters, `grade:*` tags from `educationLevels`, `sources: ["csp"]`, and
     `code:<statementNotation>`. Set shape:
     `{"subject", "educationLevels": ["03"], "document": {"publicationStatus"}, "jurisdiction": {"title"}, "license", "standards": {"<id>": {"statementNotation", "description", "depth", "parentId"}}}`.
  4. Drop sets whose `document.publicationStatus` is `Deprecated`, as Learning
     Commons keeps only current frameworks. Keep school and organization sets.
     Alternative: keep deprecated sets. Each retired version then returns as a
     near-duplicate skill.
  5. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  6. ASN: only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). Bulk needs the batch
     service. CSP first imported its states from ASN, so ASN adds mostly
     duplicates.

- [ ] Delete the CSP API key from git history, or confirm that it is CSP's
      public demo key. Blocker: you. Commit `4724493^` holds a hardcoded
      `api-key` in `data/download.ts`, and `origin/main` already has that
      commit. A history rewrite changes every later commit hash.
  1. Check whether the key belongs to your CSP account.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: a free
      API key through Oak's HubSpot form. You request it.
  1. Fetch the bulk JSON per subject and phase. Before you parse it, check one
     file for quiz fields: the schema has none, but the bulk page lists them.
  2. Each unit becomes a skill. Consecutive units within one `thread` become
     seed pairs.
  3. Resolve each `priorKnowledgeRequirements` string to a skill id with the
     `seed-edges` resolver.
  4. Skip lessons with `restricted: true`. OGL v3 covers the rest.

- [ ] Apprenticeship knowledge, skills, and behaviours (Skills England, levels
      2–7) appear in `skills.tsv`, tagged by occupation. Blocker: a free API
      key, granted at Skills England's discretion. The licence requires the
      Skills England logo and attribution on every derived product. Decision:
      sponge carries the logo. You request the key.
  1. `GET /api/v1/Occupations` with header `X-API-KEY`, then each
     `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
