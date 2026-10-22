## Blocked on you

- [ ] You get a fresh `skills.tsv` that includes the fixes from audit passes
      9–16, and `deno task status` passes. Blocker: a multi-hour Ollama run on
      the Mac. The last full build predates the April 17 fixes. `build/` holds
      only the committed caches. Decision: regenerate every LLM cache. Deleting
      `5_prereqs.tsv` applies the R1–R10 and DR1 candidate fixes to every skill.
      Deleting the Haiku enrichment caches removes the ~10% wrong descriptions
      (E2) and applies the ENR1–4 prompts.
  1. `ollama pull gpt-oss:20b`. The Mac has only `nomic-embed-text` today, so
     stages `enrich` and `prereq` stop on their first request.
  2. Smoke-test one prompt per `num_predict` (60, 120, 200, 600) with
     `curl localhost:11434/api/generate`. gpt-oss thinks before it answers, and
     the thinking counts against `num_predict`, so a short limit can return an
     empty `response`. If it does, raise that limit or send `think: "low"` in
     `generateOne` (lib.ts). `resumableOllama` stops a stage after 200 answers
     when over half come back rejected.
  3. `git rm build/1b_infill.tsv build/1c_summarize.tsv build/1d_onet_desc.tsv build/5_prereqs.tsv`.
  4. Run `deno run -A pipeline.ts enrich`. It now also translates the MOOCCubeX
     labels into `build/1f_translate.tsv`; commit that cache. Stage `list` drops
     25k long titles today, because the summarize cache has only 3.4k rows and
     the OpenSALT description cache is empty.
  5. Run `deno run -A pipeline.ts`. Stage `seed-edges` now runs after `dedupe`
     for the first time; watch its foundation-wiring count and quarantine.
  6. Run `deno task status`. Write a todo entry for each condition below 1.0.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: approved design. Common
      Standards Project (CSP) and ASN, everything they give, with no row bound.
      Blocker: the full CSP download runs for hours, and its size decides
      whether `data/csp/` is committed like `data/opensalt/` or gitignored. ASN
      bulk access needs your email request.
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
      `api-key` in `data/download.ts`. A history rewrite changes every later
      commit hash.
  1. Check whether the key belongs to your CSP account.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.

## Backlog

- [ ] Fixes that change `skills.tsv`. Do them after the golden diff of the
      refactor passes, one commit each, and judge each by `deno task status` on
      a full build.
  1. DWA job-zone anchors (stage `difficulty`, `graph.ts` `dwaTitle`): the map
     reads columns 0 and 1 of `DWA Reference.txt` (Element ID, IWA ID) but is
     looked up by DWA ID, so it never hits. Key it by `col(rows, "DWA ID")` to
     `col(rows, "DWA Title")`.
  2. Seed anchoring (stage `difficulty`):
     `calibrate(out[i] + (jittered[i] -
     out[i]))` is
     `calibrate(jittered[i])`, so the adjusted raw never moves a band. Recompute
     the smoothed and jittered values from the adjusted `out`, then calibrate.
  3. `Deno.readDirSync` order is the filesystem's (`sources.ts`: OpenSALT in
     list, precedes, and grade ordering; Metacademy concepts). It decides the
     dedupe winner, the `-N` id suffixes, and which frameworks fit under the
     50000 grade-pair cap. Sort entries by name. Log when the cap cuts.
  4. Stage `seed-edges` quarantines a whole source without a word. Throw when a
     source resolves under a floor; pick the floor from the first full build's
     resolved/total counts.
  5. Multi-file outputs are not crash-safe: `embed` writes the bin then the ids,
     `dedupe` writes `3b_tagged_deduped.tsv` then `3b_aliases.tsv`. Write each
     to `path.tmp`, then rename, dependent file last.

- [ ] OpenSALT titles and descriptions lose their HTML markup, and Lightcast
      descriptions keep the tags they quote.
  1. Today `normalizeText` deletes every `<…>` with a regex, for every source.
     OpenSALT fields hold real markup (`<b>`, `<sup>`, `<li>`). Lightcast
     descriptions quote tags in backticks ("like `<table>`"), and the regex
     deletes those.
  2. Parse OpenSALT `fullStatement`, `abbreviatedStatement`, and `notes` as HTML
     (`jsr:@b-fuze/deno-dom`) and keep the text content. Leave the other sources
     as they are.
  3. Byte-diff `build/1_skills.tsv`. Only OpenSALT rows with markup and the
     Lightcast rows with quoted tags may change.

- [ ] Ids keep accented letters as their ASCII base: "Prepare canapés" →
      `prepare-canapes`, not `prepare-canap-s`.
  1. `slugify` maps every char outside `[a-z0-9]` to a space. Fold first with
     NFKD and drop combining marks, as `fuzzyKey` in stage `list` does.
  2. Do it before the cache regen above: `1b`/`1c`/`1d` key on slugs, so the
     regen absorbs the id change.
