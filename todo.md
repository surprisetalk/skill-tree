## Blocked on you

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
     `generateOne` (lib.ts). `resumableOllama` stops a stage after 200 answers
     when over half come back rejected.
  4. `git rm build/1b_infill.tsv build/1c_summarize.tsv build/1d_onet_desc.tsv build/5_prereqs.tsv`.
  5. Run `deno run -A pipeline.ts enrich`. It also translates the MOOCCubeX
     labels into `build/1f_translate.tsv`; commit that cache. Stage `list` drops
     25k long titles today, because the summarize cache has only 3.4k rows and
     the OpenSALT description cache is empty.
  6. Run `deno run -A pipeline.ts`. Stage `seed-edges` runs after `dedupe` for
     the first time; watch its foundation-wiring count and quarantine.
  7. Stage `seed-edges` logs `cap dropped N pairs` when the 50000 OpenSALT
     grade-pair cap cuts. If it cuts, decide: raise the cap or throw.
  8. Stage `seed-edges` quarantines a whole source without a word. Set a floor
     per source from this run's resolved/total counts. Make the stage throw when
     a source resolves under its floor.
  9. Run `deno task status`. Write a todo entry for each condition below 1.0.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: approved design. Common
      Standards Project (CSP) and ASN, everything they give, with no row bound.
      Blocker: the full CSP download runs for hours, and its size decides
      whether `data/csp/` is committed like `data/opensalt/` (107 MB) or
      gitignored. ASN bulk access needs your email request.
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

## Backlog

- [ ] No stage reads a build row that its writer would reject. Decision:
      `slugify` trims edge hyphens and fits the `-N` collision suffix inside 80
      chars, so `SLUG` holds for every real id; the committed `5_prereqs.tsv`
      fails the schema until the regen deletes it. `readTable` throws on a
      missing final newline in every table. approved design, all 10 build TSVs.
      Out of scope: LLM caches, trees, `2_embeddings.bin`. Three break-it rounds
      each found a new unchecked field, because each reader checks a few fields
      at its own call site.
  1. One schema record per build table in `lib.ts`. Example:
     `{ path: "build/4_difficulty.tsv", key: "id", columns: { id: SLUG, difficulty: int(1, 20), difficulty_raw: finite } }`.
     `SLUG` is `^[a-z0-9]+(-[a-z0-9]+)*$`, 80 chars or fewer.
  2. `readTable(schema)` returns typed records and throws on the first bad cell:
     `build/4_difficulty.tsv:7: expected difficulty as an integer 1–20, received "21". Run: deno run -A pipeline.ts difficulty`.
  3. `writeTable(schema, rows)` runs the same checks, writes `path.tmp`, then
     renames. A stage with several outputs renames them last, dependents last:
     `embed` renames the bin before the ids, `dedupe` renames
     `3b_tagged_deduped.tsv` before `3b_aliases.tsv`.
  4. Where two tables meet, the reader checks ids against the skill table:
     postproc throws on a `5_prereqs.tsv` pick or a seed id outside
     `3b_tagged_deduped.tsv`; finalize throws on a `4_difficulty.tsv` id outside
     it. Message:
     `build/5_prereqs.tsv:12: expected a skill id, received "ghost". Run: deno run -A pipeline.ts prereq`.
  5. Data readers: `readCsv`/`readTsv` throw on a row equal to the header; stage
     `trees` throws when a tree has 0 slugs; the CMR lookup error in stage
     `list` names its file and line.
  6. Delete the per-site checks that the schemas replace: `uniqueIds`,
     `nonEmpty`, `readDifficulty`'s range checks, `readSeeds`'s holdout check.
  7. Test: one table-driven case per schema, a bad cell in, the message out.
     Then run the break-it agent again.

- [ ] Stage `difficulty` orders seed pairs in one pass, and no seed shape stops
      the stage. Decision: approved design. Four break-it rounds in a row found
      a new seed shape that never settles, because three passes enforce the
      order on three scales (raw, calibrated, band) and each clamp can undo the
      pass before it.
  1. Compute bands from the calibrated values first, with no seed work before.
     `difficulty_raw` stays the model's raw value.
  2. Kept seeds: drop the pairs inside a cycle (`stronglyConnected`, lib.ts), as
     today. They form a DAG.
  3. An anchored skill keeps its anchor's band. For every other skill, one
     forward and one backward pass over `topoOrder` give `lo` (1, or 1 above
     each prereq's `lo`) and `hi` (20, or 1 below each dependent's `hi`).
  4. In topo order, drop a seed pair whose ends cannot fit: `lo > hi`, or an
     anchored end outside its bound. Count it in `seed_anchor_conflicts`.
     Example: a grade-PK dependent at band 1 with an unanchored prereq drops the
     pair, so the anchor wins with no tie.
  5. One forward pass sets `band = max(clamp(band, lo, hi), prereq band + 1)`.
     No loop and no "never settles" throw.
  6. Delete `settle`, `bound`, the band fix-up loop, their three throws, and the
     seed adjustment of `out`. Keep the self-loop and unknown-id throws: stage
     `seed-edges` quarantines self-loops and resolves ids against
     `3b_tagged_deduped.tsv`, so either one means a stale file.
  7. Stage `status` grades `seed_cycle_pairs` beside `seed_anchor_conflicts`:
     1.0 at 1% of seed pairs. The first full build revisits both bounds.
  8. Tests: keep the fixture cases from the batch-2 commits (chains in any
     order, cycles, anchored chains through unanchored skills, band 1). Each
     asserts prereq band < dependent band or a counted drop.
