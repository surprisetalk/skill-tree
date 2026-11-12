## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] Stages `prereq` and `pilot` classify with Cloudflare Clef where it beats
      Haiku 5.5 on accuracy or cost. Facts (Cloudflare model page, pricing,
      changelog 1 Oct 2026): `@cf/cloudflare/clef` (27B) and `clef-flash` (9B),
      Apache 2.0, 1–64 questions per call, types `noul` (yes/no), `choice`,
      `score`; input $0.24/M tokens (flash $0.038/M), output free, 10k neurons a
      day free. `CLOUDFLARE_API_TOKEN` is in `.env`; the account id comes from
      `GET /accounts`, which must list exactly one. Split (12 Nov): Clef can
      take only the calls that pick from fixed choices: `prereq` (which of 15
      candidates), `prereq:snap` and `pilot:snap` (which of 10, or none). Six
      `enrich` calls (translate, bncc, infill, summarize, onet-desc,
      opensalt-desc) and the two `expand` calls write text, so they stay on
      Claude.
  1. Snap trial (12 Nov, 200 rows of `build/pilot_snap.tsv`, same 10
     candidates): agreement with Haiku is 46% for `clef-flash` as one 11-way
     `choice`, 54.5% for `clef` (27B), and 52% for 10 `noul` questions at cut
     0.5 (2.6× the tokens). Clef rarely answers none (15 vs Haiku's 59), and
     often picks a broader or narrower skill (`Voltage dividers` → "Resistors").
     Some picks beat Haiku's none: `Subtraction of whole numbers` → "Subtract
     whole numbers". Haiku is not gold, so hand-label 50 disagreements before
     you call either one more accurate. Cost: 545 input tokens a call, $0.004
     per 200 on `clef-flash`.
  2. Then the prereq pick, which has gold labels: one `noul` question per
     candidate (15 per call). A probability gives a cut point; score it with
     LectureBank precision and recall.

## Blocked on you

- [ ] A full build finishes in under 2 hours of compute at the CSP scale: 392k
      skills, 279k grade anchors. Decision (you, 10 Nov): performance first,
      then a review together, then all of CSP. Blocker: your review of the
      timings below. Measured 12 Nov, `SKIP_LLM=1`: list 1m41, embed 56m (first
      run only, then cached), tag 4m11, dedupe 6m06, seed-edges 5m50 (36m47
      before the IVF fallback), difficulty 4m57, prereq 6m13 (44m53 before the
      candidate workers: IVF index 2m13, candidates 3m58 on 14 workers, peak 19
      GB), postproc 13 s, finalize 6 s, status 1m14. Total 31 min, or 87 min
      with the first embed.
  1. If the review wants more margin: the kNN of stage `difficulty` (295 s) and
     the IVF index build (133 s) run on one thread and split the same way.

- [ ] A skill's band says when a typical learner can first learn it. Sanity fit
      is 10/23 at 93k and 13/23 at CSP scale (goal 80%). Blocker: your review of
      `data/_sanity.tsv` (its `REVIEW:` note in `pipeline.ts`). Decision (you,
      11 Nov): no college-level anchors. CSP fixes `probability`, `budgeting`,
      `typing`, and `spreadsheets`. Misses at CSP scale: `nutrition` 13,
      `grammar` 12, `drawing` 9, `chemical-reactions` 11, `machine-learning` 12.
      A merged skill anchors at the lowest grade of its standards, so CSP pulls
      some down: `reading-comprehension` K, `pythagorean-theorem` grade 7,
      `project-management` grade 6. Rejected at 93k: a topic pool under 15
      anchors falls back to all anchors (sanity same, Kendall τ 0.85 → 0.81).
  1. You check the rows that CSP contradicts: `reading-comprehension` (CCSS has
     K reading standards), `pythagorean-theorem`, `project-management`.
  2. Then try the median grade of a merged skill's standards as its anchor, not
     the lowest, and rescore sanity and Kendall τ at CSP scale.

- [ ] A course-catalog seed never puts a college requirement before a school
      concept: `academic-writing → drawing`, `songwriting → music-theory`,
      `medical-nutrition-therapy → nutrition`, `calculus → probability`. These
      are course seeds, not named prereqs: only 18 named edges put a
      specialisation first. Blocker: the CSP prereq run, since recall decides
      it. Dropping every course seed is rejected: at CSP scale recall falls 54 →
      31 and sanity stays 13/23. 97% of course pairs come from one institution,
      so a two-institution rule drops nearly all of them.
  1. Read the 80 course seeds that conflict with an anchor at CSP scale
     (`seed_anchor_conflicts_by_source` in the workspace's `4_stats.json`), and
     find a rule that drops those without the recall loss.

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`. Stage `list` parses them (391,782 rows in `1_skills.tsv`),
      and `build/2_cache.bin` holds their embeddings. Blocker: your review of
      the performance entry, since the next full build sends the CSP rows to
      Claude. Decision: every current set; the 1,508 sets that state no licence
      count as permitted for now (you, 10 Nov).
  1. Run the full chain with `.env` loaded: stage `prereq` sends about 116M
     input and 59M output tokens.
  2. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  3. Readme: CSP attributions per set licence (CC BY 4.0 US, CC BY 3.0 US).

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account: open
      `pslcdatashop.web.cmu.edu/help?page=access`, sign in with Google or your
      university, and fill the registration form. Dataset 1198 is a public
      project, so it needs no request to the PI. Safari did not load the site on
      12 Nov, though curl got 200: try without iCloud Private Relay or content
      blockers.
  1. Log in, open `DatasetInfo?datasetId=1198`, tab Files, and download
     `relationship_annotation_training.csv` (1,131 pairs) into `data/junyi/`,
     gitignored. The web-services API needs a Java client with request signing,
     so a manual download is simpler. It is non-commercial: eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN's reply.
      You sent the bulk-access request through
      `asn.desire2learn.com/content/contact-us` (12 Nov).
  1. Only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). CSP first imported its
     states from ASN, so ASN adds mostly duplicates.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: the API
      key you requested (12 Nov), by email. Put it in `.env` as `OAK_API_KEY`.
      Keys do not expire. Calls send `Authorization: Bearer <key>`.
  1. Fetch the bulk JSON per subject and phase. Before you parse it, check one
     file for quiz fields: the schema has none, but the bulk page lists them.
  2. Each unit becomes a skill. Consecutive units within one `thread` become
     seed pairs.
  3. Resolve each `priorKnowledgeRequirements` string to a skill id with the
     `seed-edges` resolver.
  4. Skip lessons with `restricted: true`. OGL v3 covers the rest.

- [ ] Apprenticeship knowledge, skills, and behaviours (Skills England, levels
      2–7) appear in `skills.tsv`, tagged by occupation. Blocker: the API key
      you requested (12 Nov), granted at Skills England's discretion, by email.
      Put it in `.env` as `SKILLS_ENGLAND_API_KEY`. The licence (OGL v3)
      requires the Skills England logo and "© Skills England 2025" on every
      derived product. Decision: sponge carries the logo.
  1. `GET occupational-maps-api.skillsengland.education.gov.uk/api/v1/Occupations`
     with header `X-API-KEY`, then each `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
