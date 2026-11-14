## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] `deno task status` takes under 30 s. Now 74 s at CSP scale: memoizing the
      embeddings, seeds, topological order, and skill list (14 Nov) did not move
      it, so the cost is elsewhere.
  1. Time each condition in `stageStatus` with `performance.now()`. Cut the
     slowest before you guess.

- [ ] Stage `prereq` reaches more expert prereq pairs in its candidate pool, and
      classifies with Cloudflare Clef where Clef beats Haiku 5.5. Facts:
      `@cf/cloudflare/clef-flash` (9B), `noul` yes/no questions, 1–64 per call,
      $0.038/M input, 10k neurons a day free. `CLOUDFLARE_API_TOKEN` is in
      `.env`. Snap stays on Haiku: on 50 disagreements an Opus judge finds Haiku
      right 35 times, Clef 13 (`build/clef/snap_labels.tsv`; you spot-check rows
      2, 4, 11, 14, 22, 26, 29, 32, 49, 50). Pool (14 Nov, LectureBank 258
      positives): 44% fail the easier-than guard in `candOk`, 37% share no topic
      with the dependent, 15% rank past the top slots, 2% reach the pool. Junyi:
      17 of 70 reach it. Picks on Junyi (68 dependents): `clef-flash` p ≥ 0.5
      8/8, Haiku 5/5; too few graded edges to decide. Expert labels resolve at
      most 1 in 6 even with loose matching: about 60% name a concept the graph
      lacks (LectureBank is ML, NLP, vision, bio). Study scripts: `build/clef/`.
  1. Add 20 exact-cosine slots from all valid skills, any topic, at the end of
     `candidateShare` (K 15 → 35). Measured: LectureBank 5 → 12 of 258, Junyi 17
     → 24 of 70. Cost: 2.3× prompt tokens a skill, which voids the CSP spend
     estimate. Leave the easier-than guard on: a harder candidate yields
     inverted edges.
  2. Rerun the Junyi and LectureBank pick trials on the 35-candidate pools.
     Switch `prereq` to `clef-flash` only if its precision holds on at least 20
     graded edges.

## Blocked on you

- [ ] A skill's band says when a typical learner can first learn it. Sanity fit
      is 12/23 at CSP scale (goal 80%), Kendall τ 0.76. Decision (you, 11 Nov):
      no college-level anchors. Misses: `nutrition` 13, `grammar` 12, `drawing`
      9, `chemical-reactions` 11, `machine-learning` 12. A merged skill anchors
      at the lowest grade of its standards, so CSP pulls some down:
      `reading-comprehension` K, `pythagorean-theorem` grade 7,
      `project-management` grade 6. Rejected (14 Nov): the median grade as the
      anchor (sanity 12 → 11/23, a spot check fails, τ same). Rejected at 93k: a
      topic pool under 15 anchors falls back to all anchors. Blocker: your
      review.
  1. You check the rows that CSP contradicts: `reading-comprehension` (CCSS has
     K reading standards), `pythagorean-theorem`, `project-management`, and the
     `data/_sanity.tsv` `REVIEW:` note in `pipeline.ts`.

- [ ] A course-catalog seed never puts a college requirement before a school
      concept: `academic-writing → drawing`, `songwriting → music-theory`,
      `medical-nutrition-therapy → nutrition`, `calculus → probability`. These
      are course seeds, not named prereqs: only 18 named edges put a
      specialisation first. Blocker: the CSP prereq run, since recall decides
      it. The resolver fold (14 Nov) grades 382 LectureBank positives, not 258:
      rerun the drop-all-course-seeds comparison on it. Dropping every course
      seed is rejected: at CSP scale recall falls 54 → 31 and sanity stays
      13/23. 97% of course pairs come from one institution, so a two-institution
      rule drops nearly all of them.
  1. Read the 80 course seeds that conflict with an anchor at CSP scale
     (`seed_anchor_conflicts_by_source` in the workspace's `4_stats.json`), and
     find a rule that drops those without the recall loss.

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`. Stage `list` parses them, and `build/2_cache.bin` holds
      their embeddings. Blocker: your go on the LLM spend (you, 14 Nov: timings
      approved, spend held). Decision: every current set; the 1,508 sets that
      state no licence count as permitted for now (you, 10 Nov).
  1. Run the full chain with `.env` loaded: stage `prereq` sends about 116M
     input and 59M output tokens at 15 candidates a skill. If the 35-candidate
     pool lands first, re-estimate (about 2.3× input) and ask again.

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
