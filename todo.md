## Next

- [ ] `skills.tsv` holds the Learning Commons standards and learning components,
      with Coherence Map seed edges. Source and counts: `research.md` § Ingest.
      CC BY 4.0 on every row; each row carries an `attributionStatement`.
  1. `data/download.ts` fetches
     `cdn.learningcommons.org/knowledge-graph/v1.16.0/exports/{nodes,relationships}.jsonl`
     (986 MB) into `data/learningcommons/`. Add `data/learningcommons/*.jsonl`
     to `.gitignore`. Keep the version in one constant.
  2. Stage `list`: each `LearningComponent` node becomes a skill with
     `sources: ["learningcommons"]`. It takes the `gradeLevel` of the standards
     it `supports`, as `grade:*` tags.
  3. Stage `list`: each `StandardsFrameworkItem` in a framework with `isCurrent`
     true becomes a skill, through the OpenSALT scaffolding filters. Tag
     `code:<statementCode>` and `grade:*` from `gradeLevel`.
  4. Stage `dedupe`: merge rows that share a `code:*` tag with OpenSALT. Treat a
     `hasStandardAlignment` pair (28,273) as a merge candidate for the cosine
     pass, not as an automatic merge.
  5. Stage `seed-edges`: each `buildsTowards` edge (757) becomes a seed pair
     with source as prereq and target as dependent. Skip `relatesTo`: it is
     symmetric. Skip `hinders`: it links misconceptions, not skills.
  6. Count what OpenSALT and the planned CSP crawl add beyond Learning Commons:
     jurisdictions × subjects. Write the count into the CSP entry below.
  7. Add a fixture of 5 nodes and 3 edges to `pipeline_test.ts`.

- [ ] `deno task status` reports the precision and recall of the prereq edges
      against held-out expert pairs. The pairs come from no source that stage
      `seed-edges` reads.
  1. `data/download.ts` clones `github.com/Yale-LILY/LectureBank` (depth 1) into
     `data/lecturebank/`, and `.gitignore` covers it. The repo states no
     licence, so git must not track a copy.
  2. Resolve the topic names of LB1, LB2, and LectureBankCD (CV, BIO) to skill
     ids with the stage `seed-edges` resolver. Positive pairs: 921, 471, 929,
     234.
  3. Over the pairs whose two topics both resolve: precision = predicted edges
     in the positive set ÷ predicted edges; recall = positive pairs in the
     transitive closure of `skills.tsv` ÷ positive pairs.
  4. Add both as status conditions. Set each floor from the first full build.
     Report the matched-pair count beside them, because few matches make the
     score noise.
  5. Blocked on you: a PSLC DataShop login adds Junyi dataset 1198
     (`relationship_annotation_training.csv`, 1,131 crowd-scored pairs). It is
     non-commercial, so use it for eval only.

- [ ] `skills.tsv` lists only direct prereqs. An edge that another path implies
      is gone, so that a goal closure stays small.
  1. In stage `postproc`, after the cycle breaker, drop edge s → p when p is
     reachable from s without that edge. The graph is a DAG there, so one
     reverse-topological pass with reachability bitsets is enough.
  2. Log the dropped count. The Mathlib import DAG loses 17.5% to this.
  3. Test: on a fixture of a → b → c plus a → c, the output keeps a → b and b →
     c only. Assert also that the closure of every node is unchanged.

- [ ] University course prerequisites seed skill edges. Source: the Mendeley
      corpus `fs2hvkps7z` (CC BY 4.0, 39,709 edges, 13 universities).
  1. `data/download.ts` fetches `prereq_edges.csv` and `courses.csv` from
     `data.mendeley.com/public-files/datasets/fs2hvkps7z/files/…` (URLs in
     `research.md`). 37 MB in total, so commit them gzipped like MOOCCubeX.
  2. Stage `seed-edges`: join each edge to the course titles. Resolve each title
     with the existing resolver. Unresolved titles go to `1e_unresolved.tsv`.
  3. Keep only `timing = before`. Treat each OR group (`is_alternative`) as its
     own pair, because each alternative alone meets the requirement.
  4. Set the quarantine floor from the first run, as for the other sources.

- [ ] Adult digital skills from DigComp 3.0 appear in `skills.tsv` with
      difficulty anchors.
  1. Fetch `DigComp 3.0 Data Supplement 24 Nov 2025.jsonld` (452 KB, CC BY 4.0)
     into `data/digcomp/` and commit it.
  2. Stage `list`: each of the 523 `LearningOutcome` nodes becomes a skill,
     tagged with its competence and area.
  3. Map the 4 named levels onto the job-zone anchor scale of stage
     `difficulty`: Basic = 1, Intermediate = 2, Advanced = 3, Highly advanced
     = 4. Write the mapping with a `REVIEW:` comment.

- [ ] Certification exam objectives appear in `skills.tsv`, tagged with the
      occupations they certify. Source: Cert Atlas (1,965 exams).
  1. Read the terms of CompTIA, AWS, and Microsoft for reuse of exam objective
     titles. If any forbids reuse, drop that vendor and note why.
  2. `data/download.ts` fetches `data/index.json` and each exam file from
     `raw.githubusercontent.com/hans6883/cert-atlas/master/`.
  3. Stage `list`: each objective becomes a skill. `weight_percent` is not a
     skill property, so do not use it.
  4. Stage `seed-edges`: a `required_certification` prereq makes each objective
     of the required exam a candidate prereq. Resolve the free-text cert name to
     an exam first. Unresolved names go to `1e_unresolved.tsv`.

- [ ] Brazil's national curriculum (BNCC) appears in `skills.tsv`, with grade
      anchors from 4-year-olds to grade 12.
  1. Clone `github.com/bncc-dev/bncc-dados` (data CC BY 4.0). Commit
     `dados/bncc-2018/*.json`.
  2. Stage `enrich` translates the Portuguese labels into a new cache, as it
     does for MOOCCubeX.
  3. Stage `list`: parse the grade and subject from each code (`EF67LP08` =
     grades 6–7, Portuguese). Map early-childhood age bands to grade -1.

## Blocked on you

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: a free
      API key through Oak's HubSpot form, which sends your details to Oak.
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
      Skills England logo and attribution on every derived product, sponge
      included. Decide whether sponge accepts that.
  1. `GET /api/v1/Occupations` with header `X-API-KEY`, then each
     `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.

- [ ] You get a fresh `skills.tsv` that includes the fixes from audit passes
      9–16, and `deno task status` passes. Blocker: a multi-hour Ollama run on
      the Mac, and Ollama stays off for now. The last full build predates the
      April 17 fixes. `build/` holds only the committed caches. Decision:
      regenerate every LLM cache. Deleting `5_prereqs.tsv` applies the R1–R10
      and DR1 candidate fixes to every skill. Deleting the Haiku enrichment
      caches removes the ~10% wrong descriptions (E2) and applies the ENR1–4
      prompts.
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
     the `/api/generate` call of `resumableOllama` (lib.ts). `resumableOllama`
     stops a stage after 200 answers when over half come back rejected.
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
     per source from this run's resolved/total counts. Make the stage throw when
     a source resolves under its floor.
  9. Before stage `prereq`: `difficulty_raw` no longer holds the seed order, and
     stage `prereq` picks candidates by raw (`raw[j] < raw[i] - MIN_DIFF`,
     prereq.ts). Count the seed pairs whose prereq raw sits at or above its
     dependent's raw. Count the skills whose candidate pool would gain such a
     prereq if its raw sat 1.0 below its dependent, as the old seed pass set it.
     Show both counts. Then decide: restore a seed-ordered raw, have stage
     `prereq` read `band`, or keep raw as is.
  10. Run `prereq`, `postproc`, and `finalize`.
  11. Run `deno task status`. Write a todo entry for each condition below 1.0.
  12. Seed conditions: if `seed_anchor_conflicts` is high, look for unanchored
      seed chains longer than 20. Stage `difficulty` drops every pair of such a
      chain, where dropping the fewest would do. If `seed_cycle_pairs` is high,
      check the OpenSALT grade-order pairs across frameworks.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: approved design. Common
      Standards Project (CSP) and ASN, everything they give, with no row bound.
      Blocker: the full CSP download runs for hours, and its size decides
      whether `data/csp/` is committed like `data/opensalt/` (107 MB) or
      gitignored. ASN bulk access needs your email request. Do the Learning
      Commons entry first. It covers all 50 states and DC in 4 subjects under CC
      BY 4.0. Run the CSP crawl only for what that entry's step 6 shows missing.
  1. CSP: `api.commonstandardsproject.com/api/v1` answers without a key today.
     It lists 785 jurisdictions: 65 state, 342 organization, 374 school, 4
     other. Texas alone has 729 standard sets.
  2. `data/download.ts` fetches each jurisdiction, then each standard set, into
     `data/csp/{setId}.json`. It skips files that exist, uses a 30 s timeout,
     and retries once.
  3. Example set record:
     `{"id": "…", "title": "Grade 3", "subject": "Mathematics", "educationLevels": ["03"], "jurisdiction": {"title": "Texas"}, "standards": {"<id>": {"statementNotation": "3.4.A", "description": "…", "depth": 2}}}`.
  4. ASN: only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). Bulk needs the batch
     service (asn.desire2learn.com/content/asn-batch-service), so you must
     request it. CSP first imported its states from ASN, so ASN adds mostly
     duplicates.
  5. Stage `list` parses CSP standards like OpenSALT items: same scaffolding
     filters, `grade:*` tags from `educationLevels`, `sources: ["csp"]`, and
     `code:<statementNotation>`.
  6. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.

- [ ] Delete the CSP API key from git history, or confirm that it is CSP's
      public demo key. Blocker: you. Commit `4724493^` holds a hardcoded
      `api-key` in `data/download.ts`, and `origin/main` already has that
      commit. A history rewrite changes every later commit hash.
  1. Check whether the key belongs to your CSP account.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.
