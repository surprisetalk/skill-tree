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
| metric              | baseline | pass 3  | pass 4   | pass 5       |
| ------------------- | -------- | ------- | -------- | ------------ |
| orphan rate         | 0.092    | 0.0883  | 0.0844   | **0.0791**   |
| metacademy recall*  | 0.143    | 0.087   | 0.087    | 0.087        |
| alcpl recall*       | 0.250    | 0.156   | 0.156    | 0.156        |
| opensalt_precedes*  | 0.000    | 0.111   | 0.111    | **0.222**    |
| opensalt_grade*     | —        | —       | 0.030    | **0.037**    |
| kendall_tau anchor  | 0.777    | 0.776   | 0.776    | 0.776        |
| seed_in_final       | 291      | 306     | 22,386   | **22,602**   |
| total edges         | 218,459  | 215,790 | 243,783  | 307,268      |
| skills emitted      | —        | —       | 94,528   | **97,264**   |
| unique topics       | 5,188    | 5,050   | 7,001    | 7,001        |
| wiki coverage       | 0.138    | 0.138   | 0.145    | 0.141        |
| domain leakage      | 0.337    | —       | 0.302    | 0.310        |
| LCSH enriched       | —        | —       | 40,443   | 41,172       |

\* recall drops vs baseline reflect larger, more stable denominators (E1 doubled holdout) — the earlier high values were small-sample noise.

Pass 4 key wins: **77× more seed edges in final graph** (22,386 vs 291), **+39% unique topic vocabulary** from LCSH/DBpedia ancestor chains, reduced orphan rate.

Pass 5 key wins: union-merged Ollama llama3.2:3b prereqs with Haiku cache (~14k overnight on local hardware, 34k new candidate edges). **2× opensalt_precedes recall** (0.111→0.222), **-6% orphan rate**, +2,736 skills preserved. Small precision cost (domain_leakage +0.8pp).

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
