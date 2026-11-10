## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] No skill has a hex-overflow id. Today 96 (from 4,830 on 9 Nov).
  1. List the 96 in `skills.tsv` (id of 70+ characters ending in a 6-hex
     suffix). Expect two causes: a cached summary that still overflows 80
     characters, and a row whose id carries a collision suffix, so `list` looks
     up `slugify(title)` and misses its summary.
  2. Ask again for a summary that overflows; key the lookup by the row's id.

- [ ] Difficulty bands agree with seeds. Build of 10 Nov: 130/3725 seed pairs
      fail to fit bands 1–20 (3.5%, floor 1%; khan 36, learningcommons 30,
      courses 24, foundation 13, opensalt_grade 12). The transitive-band
      condition scores 0.96 (floor 95% of skills): a seed edge with its prereq
      above its dependent puts every descendant below a transitive prereq, so
      the conflicts drive both.
  1. Print the conflicting Khan and Learning Commons pairs with both anchors (a
     sample list in `4_stats.json`, like `grade_band_inversion_samples`).
  2. Where the pair contradicts two grade anchors, decide per source which side
     is wrong: drop the pair in `seed-edges`, or fix the anchor's tag.

- [ ] Expert recall is above 0.05 (`EXPERT_RECALL_FLOOR`). Today 10/258 positive
      LectureBank pairs (0.039) sit in the transitive closure.
  1. The build of 10 Nov resent the rejected prompts: recall is 11/258 (0.043).
     It needs 13.
  2. Of the 248 missed positives, 243 have the prereq outside the dependent's
     candidate pool. 233 share no topic, and 118 fail the guard
     `raw[j] <
     raw[i]`. By cosine, only 7 rank in the dependent's top 10 of
     all skills. Cosine slots buy about 5 pairs.
  3. Widen the pool with what predicts these pairs: a cross-topic slot for
     foundation skills (`probability`, `linear-algebra`) that many dependents
     share. A new pool reaches cached skills only after a clear of
     `build/5_prereqs.tsv` and a full `prereq` rerun (about 93k prompts).

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`, merged with OpenSALT where they repeat. Decision: everything
      CSP gives, with no row bound. `data/csp/` holds 24,965 of 24,969 sets (178
      MB); 4 sets answer 503 every time.
  1. Stage `list` parses CSP standards like OpenSALT items: same scaffolding
     filters, `grade:*` tags from `educationLevels`, `sources: ["csp"]`, and
     `code:<statementNotation>`. Set shape:
     `{"subject", "educationLevels": ["03"], "document": {"publicationStatus"}, "jurisdiction": {"title"}, "license", "standards": {"<id>": {"statementNotation", "description", "depth", "parentId"}}}`.
  2. Drop sets whose `document.publicationStatus` is `Deprecated`, as Learning
     Commons keeps only current frameworks. Keep school and organization sets.
     Alternative: keep deprecated sets. Each retired version then returns as a
     near-duplicate skill.
  3. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  4. Readme: CSP and each set's `license` (ASN sets: CC BY 3.0 US) in the
     attributions.

## Blocked on you

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account.
  1. Fetch dataset 1198 `relationship_annotation_training.csv` (1,131 pairs). It
     is non-commercial, so use it for eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN bulk
      access needs your email request.
  1. Only single documents download
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
