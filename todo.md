## Next

## Blocked on you

- [ ] You get a fresh `skills.tsv` from a full build, BNCC included, and
      `deno task status` passes. Today `skills.tsv` does not exist, so 18
      conditions score 0. Blocker: the build runs about 4 days on the Mac.
      `build/chain/chain.sh` started it on 7 Nov; it logs each stage to
      `build/chain/<stage>.log`. It runs `enrich` until infill starts (that
      writes the BNCC title summaries), then `list` through `status`, skipping
      `trees`.
  1. Check `build/chain/status.log`. If a stage failed, fix it and rerun the
     chain from that stage; every stage resumes from its cache.
  2. When `prereq`, `postproc`, and `finalize` finish, commit
     `build/5_prereqs.tsv` and `build/1c_summarize.tsv` by path:
     `jj ci -m "…" <paths>`.
  3. Set the three LectureBank floors (`EXPERT_PRECISION_FLOOR`,
     `EXPERT_RECALL_FLOOR`, `EXPERT_MIN_POSITIVES`, pipeline.ts) from the
     `expert pairs:` stderr line in `build/chain/status.log`. Write a todo entry
     for each condition below 1.0.
  4. Read the transitive-reduction visit count in `build/chain/postproc.log`
     against the 2e9 cap (prereq.ts).

- [ ] Every Lightcast skill has a description. Stage `enrich` holds 27,953
      Lightcast skills with no description or a placeholder, about 1.5 days of
      gpt-oss. Blocker: the run length, and the GPU that the full build uses.
  1. After the full build, run `deno run -A pipeline.ts enrich` in the
     background under `caffeinate -i`. It resumes from `build/1b_infill.tsv`.
  2. Commit `build/1b_infill.tsv`, then rerun the stages from `list`.

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account.
  1. Fetch dataset 1198 `relationship_annotation_training.csv` (1,131 pairs). It
     is non-commercial, so use it for eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] Skills from every US state standard set appear in `skills.tsv`, merged
      with OpenSALT where they repeat. Decision: approved design, Common
      Standards Project (CSP) and ASN, everything they give, with no row bound.
      Blocker: the full CSP crawl runs for hours, and the Mac disk is 97% full
      (34 GB free, 7 Nov). Its size decides whether `data/csp/` is committed
      like `data/opensalt/` (107 MB) or gitignored. ASN bulk access needs your
      email request. CSP lists 786 jurisdictions: 52 US states and D.C., 13
      Canadian entries, Common Core, 342 organizations, 375 schools or
      districts. It adds Canada, organizations, schools, and each state's
      non-core subjects (Texas: 29 beyond the core four) to Learning Commons.
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
