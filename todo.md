- [x] stage 1: list (102k skills from ESCO/ONET/Lightcast/OpenSALT)
- [x] stage 1b: Lightcast description infill via Haiku batch (31,587)
- [x] stage 1c: Summarize 16k verbose OpenSALT/ONET standards via Haiku
- [x] stage 1d: Enrich 14,520 ONET Task/DWA descriptions via Haiku
- [x] stage 2: embed via Ollama nomic-embed-text
- [x] stage 3: tag occupations/topics via cosine+IDF + ESCO/ONET direct relations + occ-pair filter
- [x] stage 3b: dedupe near-identical skills via cosine + title Jaccard
- [x] stage 4: difficulty via OpenSALT grade anchors + within-topic kNN (uniform bands)
- [x] stage 5: prereq linking via Haiku 3 batch + ancestor candidates (resolved-id format)
- [x] stage 6: postproc (band-inversion filter + hub cap + onet:tech filter)
- [x] stage 7: finalize skills.tsv (101,630 skills, 307,763 edges, 5,177 roots)
- [x] HTML ladder visualization (viz.ts: top-N, seed, or --all modes)

## Quality pass 2 (2026-04-14)
- [x] slugify: decode HTML entities + word-boundary truncation + 6-hex hash for >80ch (no more `-amp-`, no more mid-word cuts, no `-2` collisions). Requires full re-run from stage 1 to take effect for existing cached IDs.
- [x] Seed edges override inferred difficulty (378 added vs 131 before, +188%). Cycle-breaker iter bumped 10→50.
- [x] P279 topic pollution filter: year/numeric blocklist + all-short-token junk filter. 211k pollution topics dropped; singleton topics dropped globally.
- [x] Dedupe stage 3b: token-sort signature pre-merge (859 additional merges from and/or/word-order swaps).
- [x] Tag backfill stage 3b: embedding-NN fills tags for untagged canonicals (1,918/4,230 enriched).
- [x] Drop dead `certs` column; emit `grade_start`/`grade_end` from existing `grade:XX` tags (0.1% → 22% coverage).

## Quality pass 3 (2026-04-14)
- [x] A1: seed-edge survival — band-inversion, onet:tech, hub-cap filters all exempt seeds. Seed_in_final 291 → 306 (+15 preserved).
- [x] A5: per-topic hub cap (30 per (prereq, child-topic)) replaces global HUB_CAP=80. Dropped ~5,300 within-topic spam edges; genuine cross-topic hubs preserved via expanded global cap of 150.
- [x] A6: cross-domain foundation whitelist. Foundations (math, reading, writing, problem-solving, etc.) exempt from cross-domain filter (232 exemptions).
- [x] C1/B3: Wikipedia-category pattern blocklist (`*-officials-and-employees`, `*-by-country`, `*-introduced-in-*`, `^people-in-*`, etc.). Kills `rome-officials-and-employees` class at source.
- [x] C2: topic doc-freq cap (>1.3% of skills drops unless whitelisted) + explicit blocklist for `photomechanical-processes`, `flying-machines`, `traffic-regulations`. 4,744 generic-topic references dropped.
- [x] C4: tag backfill now processes skills with EITHER occs-empty OR topics-empty (was both-empty). 21,187 occupations + 6,710 topics backfilled (vs 1,918 prior). Threshold lowered 0.70 → 0.60.
- [x] D1: isotonic (PAV) calibration of raw kNN scores against grade anchors. Band = round(calibrated_grade) + 1 (non-uniform bins, grade-aligned).
- [x] D2: Khan V-Position added as pseudo-grade anchor (linear 0-12 from normalized v-position).
- [x] D3: within-topic smoothing (weight 0.3 toward topic-mean, k=3+ neighbors).
- [x] E1: holdout fraction 10% → 20% (49 → 83 holdout edges for more stable recall).
- [x] E3: per-edge source attribution dump to `build/8_edge_sources.tsv` (seed/inferred/heuristic classification for all 222k edges).
- [x] E4: cycle-cut log to `build/6_cycle_cuts.tsv` (shows which edges cycle-breaker dropped and whether they were seed or inferred).

## Metrics (across all quality passes)

**Note:** passes 1-5 metrics were computed by a broken eval (stage 8 column indices off by 2 — difficulty was read as description, prereqs as difficulty numbers). Those numbers were meaningless. Pass 7 is the first with a correct eval stage.

| metric              | pass 7 (corrected)  |
| ------------------- | ------------------- |
| orphan rate         | 0.089               |
| khan recall         | 0.054 (13/242)      |
| alcpl recall        | 0.053 (1/19)        |
| metacademy recall   | 0.118 (2/17)        |
| kendall_tau         | 0.762               |
| seed_in_final       | 1,195               |
| total edges         | 141,332             |
| skills emitted      | 65,651              |
| unique topics       | 6,611               |
| wiki coverage       | 0.209               |
| domain leakage      | 0.289               |
| LCSH enriched       | 29,222              |
| depth p50/p95/max   | 4 / 11 / 21         |
| DAG                 | true                |

## Quality pass 4 (2026-04-14, local LLM)
- [x] B1: stage 1f2 fuzzy-retry using ESCO altLabels + paren-strip + verb-strip variants. Token-overlap guard. +785 matches (13.8% → 14.6% wiki resolution).
- [x] B2: stage 1j LCSH broader-chain cache (streams 95MB gz, builds label→ancestor_chain). **130,378 slugs with ancestor chains** from 273k LCSH labels.
- [x] B3: stage 1k DBpedia SKOS broader-chain cache (streams 44MB bz2). 1.47M labels, 1.26M with parents; walks depth-3; cached `build/1k_dbpedia_tree.tsv`. Pattern blocklist filter during walk (kills wiki-category junk at source).
- [x] B2+B3 integration: stage 7 topic enrichment loads both trees, matches against skill id / title slug / existing topics, adds ancestors (token-overlap guarded) alongside P279 parents.
- [x] A2 partial: OpenSALT within-framework grade ordering — within each CASE framework, emit earlier-grade → later-grade pairs for standards with ≥2 shared significant tokens. New source `opensalt_grade` (50k+ pairs emitted, capped). Tracked separately in holdout_recall.
- [x] A3: prereq retrieval expanded — added `GLOBAL_K=5` cross-topic candidate slot (scoped to skills in topics sharing tokens with current, sub-quadratic).
- [x] A4: bidirectional low-confidence filter in stage 6 — if LLM picked both A→B and B→A, keep only direction consistent with rawDiff.
- [x] E2: Apfel-based precision eval (cache-resumable). 500-sample run hit rate 0.603 on 126 completed judgments (Apfel dropped ~375 under 8-way concurrency; retry + lower concurrency added).
- [x] Apfel stage-5 re-run setup: `APFEL_OUT` env var writes to separate cache (`5_prereqs_apfel.tsv`); retries with backoff; tested on 2k sample.

## Quality pass 6 (2026-04-15, DAG + hypernym + synonym)
- [x] P1: strict DAG enforcement in stage 6 cycle-breaker. Old: drop one smallest-gap edge per SCC, cap 50 iters → 80,284 nodes left in cycles. New: Kahn topo-sort each SCC preferring seed edges as forward constraints, then drop ALL inferred back-edges; post-condition forced-drop any surviving cyclic nodes. Result: `cycles.dag=true`, `leftover_after_kahn=0` (was 80,284). 0 bidirectional pairs (was 750).
- [x] P2: hypernym/strict-subset prereq filter in stage 6 (before tech filter). Drops edges where prereq's significant slug tokens are a strict subset of child's (e.g. `manage-staff` ⊂ `manage-musical-staff`). Seeds exempt; single-token prereqs (math, algebra) exempt. 1,336 edges dropped (747 seed exempt).
- [x] P3: synonym-pair both-direction drop inside A4. When LLM picked both A→B and B→A AND slug-token Jaccard ≥ 0.5 (or subset), drop both (they're near-duplicates not prereqs). 38 pairs dropped. Remaining bidirectional pairs handled by P1.

Pass 6 key wins: strict DAG enforcement via Kahn topo-sort per SCC (was 80k nodes in cycles).

## Quality pass 7 (2026-04-15, eval bug fix + data cleanup)
- [x] Fixed stage 8 eval: column indices were off by 2 (display_title/description columns added but indices not updated). ALL prior eval metrics were wrong — kendall_tau was -1, graph appeared 100% cyclic, all holdout recall was 0.
- [x] Fixed stage 7 `edges` stat: was reporting raw input lines (307k) instead of surviving edges after orphan filtering (143k). 169k phantom edges were being counted.
- [x] Fixed stage 6 `orphan_rate`: formula went negative (-0.37) because skillsWithFinalPrereqs was a stale snapshot and could exceed skill.size.
- [x] Added edge membership filter in stage 6: drop edges referencing skill IDs not in the tagged-deduped skill set (was polluting the edge list and causing 169k orphan drops in stage 7).
- [x] Added Khan V-Position division-by-zero guard.
- [x] Added topic blocklist for LCSH/DBpedia junk: `judaism-customs-and-practices`, `descriptive-cataloging`, `ibm-computers`, `wikiproject-countries-projects`, `wikiproject-africa-projects`, etc.
- [x] Added eval sanity tests to pipeline_test.ts (kendall_tau > 0, DAG true, depth > 1, hub IDs aren't bare numbers).
- [x] Fixed pre-existing test bug: `final_edges` ordering test crashed on edges referencing skills dropped in stage 7.

## Known limits (future work)
- [ ] khan/moocx recall ~0 — seed labels don't resolve to skill ids. Fix: add Khan/Junyi as skill sources OR expand label-resolution fallback.
- [ ] Wiki resolution 14.6% — could reach 25-30% with smarter fuzzy match (wbsearchentities API + token validation) + MW opensearch guard.
- [ ] Full Apfel stage-5 re-run (~100k × 2-5s each ≈ 6-12 hours) — infrastructure ready, not executed.
- [ ] Merge strategy for Apfel vs Haiku caches (consensus union vs confidence-weighted).
- [ ] Domain leakage mean 0.337 — should improve with B2+B3 ancestor chains; needs verification run.

## Ideas
- [ ] Add Khan/Junyi as skill sources (expensive: full stage 1 + embeddings re-run)
- [ ] Wikidata P279 subclass hierarchy as parent-topic source
- [ ] Topic "rome-officials-and-employees" and similar Wikipedia categories survive P279 filters — add co-occurrence sanity check
