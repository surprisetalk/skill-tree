- [ ] Stage `list` emits the foundation hubs (addition, fractions, loops, …),
      and it throws when `data/_foundations.json` is missing.
  1. Add a failing test: run `deno run -A pipeline.ts list`; expect ids
     `addition`, `subtraction`, `multiplication`, `division`, `fractions`,
     `decimals`, `place-value`, `area`, `perimeter`, `functions`,
     `pythagorean-theorem`, `loops`, `python`, `cells`, `atoms`.
  2. Write `data/_foundations.json` in the shape the code reads:
     `{"foundations": [{"id", "title", "description", "grade_start", "grade_end"}], "seed_edges": [{"prereq", "dependent" | "dependent_pattern"}]}`.
  3. Delete both `try/catch` wrappers around the file read, in stage `list` and
     stage `seed-edges`.

- [ ] You read claude.md and readme.md, and each count in them is a command, not
      a number that goes stale.
  1. Replace counts in claude.md (`~3,000 lines`, `~65k rows`, `13,890+`, etc.)
     with the command that prints them, or delete them.
  2. Change `CLAUDE.md` references in readme.md and claude.md to `claude.md`.
  3. Correct the `translations.json` text in claude.md: the file is not in the
     repo.

- [ ] `deno task test` runs the real entry point in seconds, and
      `deno task status` scores the last full build for snitch. Decision:
      approved design. Today 33 of 40 tests read `build/` outputs that only a
      multi-hour Ollama run makes, so the suite fails on a clean checkout. Stage
      2–7 regressions surface only in status.
  1. `deno task test` spawns `deno run -A pipeline.ts list` (2.3 s, no Ollama,
     30 s bound) and asserts on `build/1_skills.tsv` and `build/1_stats.json`.
     The stage-1 tests stay: schema, sources, unique ids, no tabs, EC1, EC2, R5,
     TG2, foundations.
  2. Each other test becomes a condition in a new `status` stage of
     `pipeline.ts`. `deno task status` runs it.
  3. `status` prints
     `{"Reversed-difficulty LLM picks stay under 8%.": {"0": 0.91}, ...}` and
     exits 1 when any score is below 1.0.
  4. Score = 1.0 at the threshold, 0.0 at total failure. Example: reversed rate
     r, threshold 0.08 → `(1 - r) / (1 - 0.08)`.
  5. Conditions: DAG with resolved ids and no self-loops; ≤5 skills share an
     embedding; reversed picks <8%; seed reversals <10%; ≥80% of seed edges
     survive to `skills.tsv`; orphans <20%; roots <20%; Kendall τ >0.5;
     grade-band inversions <5%; ≥95% of OpenSALT skills carry a grade tag; no
     anomalous hub >200 in-degree; no cross-language prereqs; no junk topic or
     hex occupation; `addition` reaches `multiplication`; every `5_prereqs.tsv`
     id is a current skill; ≥10 GB free disk.
  6. A missing build file scores its conditions 0.0 and prints
     `build/6_stats.json: missing. Stage postproc writes it. Run: deno run -A pipeline.ts postproc`.
  7. Add `.githooks/pre-commit` that runs `deno task check && deno task test`.
     Add `git config core.hooksPath .githooks` to readme.md.
  8. Set `skill-tree	deno task status` in `~/Developer/snitch/projects.tsv`.

- [ ] OpenSALT text with math symbols reads correctly, e.g. `x²⋅x⁵`, not
      `x ²â‹…xâµ`.
  1. Add a failing test: no `build/1_skills.tsv` field contains `â` or `Ã`.
  2. Repair the double-encoded UTF-8 (Windows-1252 read as UTF-8) in the
     OpenSALT parser with an established decoder, not a hand-written table.

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
  3. Run `deno run -A pipeline.ts`.
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
