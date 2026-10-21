## Blocked on you

- [ ] You get a fresh `skills.tsv` that includes the fixes from audit passes
      9–16, and `deno task status` passes. Blocker: a multi-hour Ollama run on
      the Mac, after the MOOCCubeX entry lands. The last full build predates the
      April 17 fixes. `build/` holds only the committed caches. Decision:
      regenerate every LLM cache. Deleting `5_prereqs.tsv` applies the R1–R10
      and DR1 candidate fixes to every skill. Deleting the Haiku enrichment
      caches removes the ~10% wrong descriptions (E2) and applies the ENR1–4
      prompts.
  1. `git rm build/1b_infill.tsv build/1c_summarize.tsv build/1d_onet_desc.tsv build/5_prereqs.tsv`.
  2. Run `deno run -A pipeline.ts enrich`. Stage `list` drops 25k long titles
     today, because the summarize cache has only 3.4k rows and the OpenSALT
     description cache is empty.
  3. Run `deno run -A pipeline.ts`. Stage `seed-edges` now runs after `dedupe`
     for the first time; watch its foundation-wiring count and quarantine.
  4. Run `deno task status`. Write a todo entry for each condition below 1.0.

- [ ] MOOCCubeX prereq pairs resolve to skills, and stage `seed-edges` throws
      when a Chinese label has no translation. Decision: gpt-oss translates
      inside stage `enrich`, through `resumableOllama`, into the cache
      `build/1f_translate.tsv`. Delete `data/translate.ts` and its claude.md
      section. Blocker: the translation run needs Ollama. Build the code now;
      the run folds into the fresh build.
  1. Add a status condition: every CJK `c1`/`c2` label in
     `data/mooccubex/*.json.gz` has a row in `build/1f_translate.tsv`.
  2. In stage `enrich`, collect distinct CJK labels and translate each to a
     short English concept name.
  3. In stage `seed-edges`, read the cache. Delete the `try/catch` that returns
     `{}`. Throw on a missing label:
     `MOOCCubeX label "分区表" has no translation. Run: deno run -A pipeline.ts enrich`.
  4. Add `!build/1f_translate.tsv` to `.gitignore`, next to the other paid
     caches.

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
