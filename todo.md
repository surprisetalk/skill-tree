## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] A skill's band says when a typical learner can first learn it. Today 10/23
      sanity skills fit (goal 80%). Decision (you, 11 Nov): no college-level
      anchors; long chains carry skills past 12. Two causes, from the kNN
      neighbours of the misses: - Arts, health, and finance anchors are mostly
      9–12 CTE standards, which anchor at grade 9: `drawing` borrows from
      drafting, `budgeting` from 9–12 finance. CSP adds these subjects at every
      grade. - Course seeds lift school concepts: `calculus → probability`,
      `morphology → grammar`, `writing → reading-comprehension`. Tried at 93k,
      both reverted: a topic pool under 15 anchors falls back to all anchors
      (sanity same, Kendall τ 0.85 → 0.81); course seeds skip the band pass
      (12/23, but 0.3% of skills then sit below a prereq).
  1. Read the sanity score of the CSP-scale build (perf entry). If it reaches
     80%, close this entry.
  2. Else apply the course-seed step of the next entry and rescore.
  3. Correct the sanity rows only if a row is wrong, as the `REVIEW:` note in
     `pipeline.ts` asks; never to fit the build.

- [ ] A course-catalog seed never puts a college requirement before a school
      concept. The backward samples are course seeds, not named prereqs:
      `academic-writing → drawing`, `songwriting → music-theory`,
      `medical-nutrition-therapy → nutrition`. Only 18 named edges in
      `skills.tsv` put a specialisation first, and some are right
      (`eclampsia ← pre-eclampsia`). 97% of course pairs come from one
      institution, so a two-institution rule drops nearly all of them. Measured
      at 93k with no course seeds: precision 7/26 → 10/27, recall 37 → 29,
      sanity 10 → 12/23.
  1. Rescore the same drop at CSP scale (filter `courses` rows out of
     `build/1e_seed_edges.tsv`, then run `difficulty` through `status`).
  2. If precision and sanity gain more than recall loses, drop course seeds in
     stage `seed-edges` with a `REVIEW:` note, and keep them in
     `1e_unresolved.tsv` with reason `course-seed`.

- [ ] A full build finishes in under 2 hours of compute at the CSP scale: 364k
      skills, about 290k grade anchors. Decision (you, 10 Nov): performance
      first, then a review together, then all of CSP. Done at 93k: kNN stride
      sample (326 s → 55 s); candidates use an IVF index for big pools (cosine
      top 7× faster, pool Jaccard 0.966) and a token index for the cross-topic
      pool. The IVF build takes 55 s and grows with n·√n.
  1. Running since 12 Nov 08:34: jj workspace `csp` at `../skill-tree-csp`,
     change `vrswyopt` (`lopuqmnx` rebased onto main, no conflicts),
     `SKIP_LLM=1 sh build/chain/chain.sh list`. Read the stage times in its
     `build/chain/chain.log` and each stage's `seconds` in its logs.
  2. Stop for the review with the timings and the new status numbers.

## Blocked on you

- [ ] Stages `prereq` and `pilot` classify with Cloudflare Clef where it beats
      Haiku 5.5 on accuracy or cost. Facts (Cloudflare model page, pricing,
      changelog 1 Oct 2026): `@cf/cloudflare/clef` (27B) and `clef-flash` (9B),
      Apache 2.0, 1–64 questions per call, types `noul` (yes/no), `choice`,
      `score`; input $0.24/M tokens (flash $0.038/M), output free, 10k neurons a
      day free. Blocker: no Cloudflare credentials in `.env`. You create an API
      token with Workers AI read and run permission, then add
      `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
  1. Try the snap step first with `clef-flash`: one `choice` question, choices
     `none` and `1`–`10`. Compare with the Haiku answers in
     `build/pilot_snap.tsv`.
  2. Then the prereq pick: one `noul` question per candidate (15 per call). A
     probability gives a cut point; score it with LectureBank precision and
     recall.

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`. Blocker: the performance entry, then your review. Decision:
      every current set; the 1,508 sets that state no licence count as permitted
      for now (you, 10 Nov). Side commit `lopuqmnx` grows `1_skills.tsv` from
      95,375 to 364,519 rows.
  1. Rebase `lopuqmnx` onto main. It parses leaf standards of current sets,
     treats a parent as a heading, tags grades when a set names at most 4, and
     skips a notation that lists several codes.
  2. Stage `prereq` then sends about 116M input and 59M output tokens.
  3. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  4. Readme: CSP attributions per set licence (CC BY 4.0 US, CC BY 3.0 US).

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account: open
      `pslcdatashop.web.cmu.edu/help?page=access`, sign in with Google or your
      university, and fill the registration form. Dataset 1198 is a public
      project, so it needs no request to the PI.
  1. Log in, open `DatasetInfo?datasetId=1198`, tab Files, and download
     `relationship_annotation_training.csv` (1,131 pairs) into `data/junyi/`,
     gitignored. The web-services API needs a Java client with request signing,
     so a manual download is simpler. It is non-commercial: eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN bulk
      access. D2L documents no batch service. You write through
      `asn.desire2learn.com/content/contact-us`: "We request bulk access to the
      ASN web services (JSON-LD, export 3.1.0) for all US state standards
      documents, for non-commercial research. Please name the batch endpoint,
      whether it needs credentials, and the licence."
  1. Only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). CSP first imported its
     states from ASN, so ASN adds mostly duplicates.

- [ ] Delete the CSP API key from git history, or confirm that it is CSP's
      public demo key. Blocker: you. Commit `4724493^` holds a hardcoded
      `api-key` in `data/download.ts`, and `origin/main` already has that
      commit. A history rewrite changes every later commit hash.
  1. Check whether the key belongs to your CSP account. It is not on CSP's
     public pages: the site, the API docs, and the UI bundle omit it.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: a free
      API key. You open `open-api.thenational.academy`, click "Request an API
      key" (a HubSpot form), and put the key in `.env` as `OAK_API_KEY`. Keys do
      not expire. Calls send `Authorization: Bearer <key>`.
  1. Fetch the bulk JSON per subject and phase. Before you parse it, check one
     file for quiz fields: the schema has none, but the bulk page lists them.
  2. Each unit becomes a skill. Consecutive units within one `thread` become
     seed pairs.
  3. Resolve each `priorKnowledgeRequirements` string to a skill id with the
     `seed-edges` resolver.
  4. Skip lessons with `restricted: true`. OGL v3 covers the rest.

- [ ] Apprenticeship knowledge, skills, and behaviours (Skills England, levels
      2–7) appear in `skills.tsv`, tagged by occupation. Blocker: a free API
      key, granted at Skills England's discretion. You open
      `occupational-maps.skillsengland.education.gov.uk/public-api/`, fill its
      Cognito form (the data is stored in the US), and put the emailed key in
      `.env` as `SKILLS_ENGLAND_API_KEY`. The licence (OGL v3) requires the
      Skills England logo and "© Skills England 2025" on every derived product.
      Decision: sponge carries the logo.
  1. `GET occupational-maps-api.skillsengland.education.gov.uk/api/v1/Occupations`
     with header `X-API-KEY`, then each `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
