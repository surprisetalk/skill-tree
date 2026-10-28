## Next

## Blocked on you

- [ ] You get a fresh `skills.tsv` that includes the fixes from audit passes
      9–16, and `deno task status` passes. Blocker: a multi-hour Ollama run on
      the Mac. Ollama runs with `nomic-embed-text`; `gpt-oss:20b` is not pulled.
      `build/` holds only the committed caches. Decision: regenerate every LLM
      cache. Deleting `5_prereqs.tsv` applies the R1–R10 and DR1 candidate fixes
      to every skill. Deleting the Haiku enrichment caches removes the ~10%
      wrong descriptions (E2) and applies the ENR1–4 prompts.
  1. Golden diff of the split refactor, before you delete a cache: in worktrees
     at `46783a1` and `6044561`, run every stage but `enrich` with `SKIP_LLM=1`
     and the committed caches. The two `skills.tsv` files must match byte for
     byte.
  2. `ollama pull gpt-oss:20b`. The Mac has only `nomic-embed-text` today, so
     stages `enrich` and `prereq` stop on their first request.
  3. Smoke-test one prompt per `num_predict` (60, 120, 200, 600) with
     `curl localhost:11434/api/generate`. gpt-oss thinks before it answers, and
     the thinking counts against `num_predict`, so a short limit can return an
     empty `response`. If it does, raise that limit or send `think: "low"` in
     the `/api/generate` call of `resumableOllama` (lib.ts).
  4. `git rm build/1b_infill.tsv build/1c_summarize.tsv build/1d_onet_desc.tsv build/5_prereqs.tsv`.
  5. Run `deno run -A pipeline.ts enrich`. It also translates the MOOCCubeX
     labels into `build/1f_translate.tsv`; commit that cache. Stage `list` drops
     25k long titles today, because the summarize cache has only 3.4k rows and
     the OpenSALT description cache is empty.
  6. Run `list`, `trees`, `embed`, `tag`, `dedupe`, `seed-edges`, and
     `difficulty`, one `deno run -A pipeline.ts <stage>` each. They need only
     `nomic-embed-text`. Stage `seed-edges` runs after `dedupe` for the first
     time; watch its foundation-wiring count and quarantine.
  7. Stage `seed-edges` logs `cap dropped N pairs` when the 50000 OpenSALT
     grade-pair cap cuts. If it cuts, decide: raise the cap or throw.
  8. Stage `seed-edges` quarantines a whole source without a word. Set a floor
     per source from this run's resolved/total counts, the course-prereq source
     included. Make the stage throw when a source resolves under its floor.
  9. Before stage `prereq`: `difficulty_raw` no longer holds the seed order, and
     stage `prereq` picks candidates by raw (`raw[j] < raw[i] - MIN_DIFF`,
     prereq.ts). Count the seed pairs whose prereq raw sits at or above its
     dependent's raw. Count the skills whose candidate pool would gain such a
     prereq if its raw sat 1.0 below its dependent, as the old seed pass set it.
     Show both counts. Then decide: restore a seed-ordered raw, have stage
     `prereq` read `band`, or keep raw as is.
  10. Run `prereq`, `postproc`, and `finalize`.
  11. Run `deno task status`. The three LectureBank conditions use placeholder
      floors (`EXPERT_PRECISION_FLOOR`, `EXPERT_RECALL_FLOOR`,
      `EXPERT_MIN_POSITIVES` in pipeline.ts, marked `REVIEW`). Set them from the
      run's precision, recall, and matched count (stderr line
      `expert
      pairs:`), then delete the `REVIEW` prefix. The first run
      embeds about 500 topic names with Ollama. Write a todo entry for each
      condition below 1.0.
  12. Seed conditions: if `seed_anchor_conflicts` is high, look for unanchored
      seed chains longer than 20. Stage `difficulty` drops every pair of such a
      chain, where dropping the fewest would do. If `seed_cycle_pairs` is high,
      check the OpenSALT grade-order pairs across frameworks.

- [ ] Brazil's national curriculum (BNCC) appears in `skills.tsv`, with grade
      anchors from 4-year-olds to grade 12. Blocker: the Portuguese labels need
      a `gpt-oss:20b` translation run, as the full-build entry needs.
  1. Clone `github.com/bncc-dev/bncc-dados` (data CC BY 4.0). Commit
     `dados/bncc-2018/*.json`.
  2. Stage `enrich` translates the Portuguese labels into a new cache, as it
     does for MOOCCubeX.
  3. Stage `list`: parse the grade and subject from each code (`EF67LP08` =
     grades 6–7, Portuguese). Map early-childhood age bands to grade -1.

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account (28 Oct).
  1. Fetch dataset 1198 `relationship_annotation_training.csv` (1,131 pairs). It
     is non-commercial, so use it for eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: approved design. Common
      Standards Project (CSP) and ASN, everything they give, with no row bound.
      Blocker: the full CSP download runs for hours, and its size decides
      whether `data/csp/` is committed like `data/opensalt/` (107 MB) or
      gitignored. ASN bulk access needs your email request. Count (28 Oct,
      Learning Commons v1.16.0): Learning Commons holds 209 jurisdiction ×
      subject pairs in current frameworks: 52 jurisdictions (50 states,
      Washington D.C., Multi-State) × 4 core subjects (ELA, math, science,
      social studies), plus Multi-State durable skills. OpenSALT's 95 frameworks
      name no jurisdiction or subject; by title, its 26 core-subject pairs all
      sit in Learning Commons, and it adds about 10 pairs outside them (computer
      science: Alabama and Massachusetts; CTE: North Carolina and North Dakota;
      world languages: Florida and Colorado; Ontario and Western Canada math;
      Kentucky early childhood; AP CS Principles). CSP lists 786 jurisdictions:
      51 US states and D.C., 13 Canadian province entries, Common Core, 342
      organizations, 375 schools or districts. Its subjects are finer than
      Learning Commons': Texas alone has 48 subject titles, 33 of them not
      deprecated. So CSP adds Canada, organizations, schools, and the non-core
      subjects of each state (Texas: 29 beyond the core four). The full pair
      count needs one GET per jurisdiction (786); this count used two. Decide
      whether non-core subjects, Canada, and schools justify the crawl.
  1. `data/download.ts` fetches each CSP jurisdiction from
     `api.commonstandardsproject.com/api/v1` (no key), then each standard set,
     into `data/csp/{setId}.json`. It skips files that exist, uses a 30 s
     timeout, and retries once.
  2. Example set record:
     `{"id": "…", "title": "Grade 3", "subject": "Mathematics", "educationLevels": ["03"], "jurisdiction": {"title": "Texas"}, "standards": {"<id>": {"statementNotation": "3.4.A", "description": "…", "depth": 2}}}`.
  3. ASN: only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). Bulk needs the batch
     service (asn.desire2learn.com/content/asn-batch-service). CSP first
     imported its states from ASN, so ASN adds mostly duplicates.
  4. Stage `list` parses CSP standards like OpenSALT items: same scaffolding
     filters, `grade:*` tags from `educationLevels`, `sources: ["csp"]`, and
     `code:<statementNotation>`.
  5. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.

- [ ] Delete the CSP API key from git history, or confirm that it is CSP's
      public demo key. Blocker: you. Commit `4724493^` holds a hardcoded
      `api-key` in `data/download.ts`, and `origin/main` already has that
      commit. A history rewrite changes every later commit hash.
  1. Check whether the key belongs to your CSP account.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: a free
      API key through Oak's HubSpot form. You request it (28 Oct).
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
      sponge carries the logo (you, 28 Oct). You request the key.
  1. `GET /api/v1/Occupations` with header `X-API-KEY`, then each
     `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
