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
- [x] Fixed per-topic hub cap: was only checking child's first topic (`[...childTopics][0]`), now checks all topics. Per-topic drops went from ~79k to ~18k — the cap now properly limits within-topic spam across all of a child's topics.

## Pipeline simplification (2026-04-15)
- [x] Rewrote pipeline.ts monolith: 5,635 → 3,024 lines (46% reduction). 26 stages → 11. Ollama-only (deleted Anthropic Batches, Apfel OpenAI-compat, and all Wikipedia/Wikidata resolve stages). Merged 1b/1c/1d batch machinery into a single `resumableOllama` helper. All 22 tests in pipeline_test.ts still pass against regenerated output.

## Known limits (future work)
- [ ] khan/moocx recall ~0 — seed labels don't resolve to skill ids. Fix: add Khan/Junyi as skill sources OR expand label-resolution fallback.
- [ ] Domain leakage mean 0.337 — should improve with LCSH+DBpedia ancestor chains; needs verification run.

## Quality pass 8 (2026-04-16, audit + fixes)
- [x] **C2**: NaN-guard difficulty stage — throw on non-finite calibrated value; fail-fast at finalize on bad band. Bands always in [1,20].
- [x] **C3**: Seed-edge resolution no longer silently drops pairs. Bounded retry (3 attempts, exponential backoff) on embed errors. Every dropped pair written to `build/1e_unresolved.tsv` with reason (embed-failed / below-cos-X / no-token-overlap / no-match / self-loop). Per-source drop counts and embed_errors surfaced in `build/1e_stats.json`.
- [x] **C5**: Per-topic cap now only drops when *every* child topic is at cap, and increments only topics that permitted the edge. Fixes multi-topic starvation.
- [x] **D2**: OpenSALT titles whose base slug exceeds 80 chars (pre-hash path) are dropped outright in stage `list`. Kills hex-suffix compliance-fragment ids.
- [x] **D3**: Cruft filter at finalize now requires ≥2 topics when description is empty; single-topic empty-desc leaves are dropped.
- [x] **D4**: Grade-vs-band inversion audit in stage `difficulty` — logs count of grade-anchored skills whose final band disagrees by >5, with samples in stats.
- [x] **M2**: Prereq pick cap env-configurable (`PREREQ_PICK_CAP`, default 8, was hardcoded 5).
- [x] **M6**: `build/6_edges.tsv` sorted by (skill_id, prereq_id) at write for reproducible output.
- [x] **Tests**: added adversarial tests (quarantine file exists, no hex slug suffix, difficulty ∈ [1,20], grade-band inversions <5%, known false-positive edges absent, addition→multiplication reachability warning).
- [x] C1 investigated and closed: PAV implementation uses pop/push (correct), not splice.
- [x] Seeded README.md with quickstart.

## Ideas
- [ ] Add Khan/Junyi as skill sources (expensive: full stage 1 + embeddings re-run)
- [ ] Topic "rome-officials-and-employees" and similar Wikipedia categories survive filters — add co-occurrence sanity check
- [ ] Tighten prereq candidate pool to require shared topic ancestor or occupation for cross-topic candidates (D5 follow-up)
- [ ] Move unwired datasets under `data/_unused/` (Course-Skill Atlas, Junyi, ASSISTments, ASN, Common Standards Project, NGSS/Hess PDFs) to make current wiring explicit (M8)

## Quality pass 9 (2026-04-17, multi-agent prereq audit)

Four parallel agents (3 Haiku, 1 Sonnet) reviewed ~3,900 recent prereq picks + 200 none-responses. Systemic patterns below, ordered by estimated edge count.

### R1: SCED phantom hubs as universal prereqs (~1,500-2,000 edges)
SCED course-catalog entries (`leadership`, `american-sign-language-immersion-prior-to-seconda`, `american-indian-language-immersion-prior-to-secon`, `assisted-reading`, `corrective-reading`) appear as prereqs for unrelated skills — pilot-training, clothing-and-textiles, inferential-probability, wind-turbine-construction, etc. "Leadership" alone: 664 edges in one 1,500-skill chunk.
- **Root cause:** stage `list` admits these as first-class skills with thin descriptions; stage `prereq` global-pool fallback (around `cands = []` branch when `pool.size < K`) picks them across domains.
- **Fix:** tag SCED catalog entries with `sced:catalog` in stage `list` (already filter O*NET tech hubs with `onet:tech` — reuse that pattern). In `computePrereqCandidates`, exclude `j` if its tags include `sced:catalog`. Alternative denylist: `^(leadership|assisted-reading|corrective-reading|study-hall|american-(sign|indian)-language-(immersion|prior-to))$`.
- **Risk:** "Leadership" may be a valid prereq for some management skills; scope the exclusion to candidates whose sources contain *only* SCED/OpenSALT and no ESCO/O*NET/Lightcast backing.

### R2: K-1 counting anchors as universal prereqs (~800-1,500 edges)
`count-up-to-20-objects`, `write-whole-numbers-0-20`, `given-a-set-of-up-to-30-objects`, `describe-and-label-attributes`, `state-the-number-before`, `identify-the-number-of-objects-up-to-10` appear as prereqs for polar equations, trigonometry, piecewise functions, epidemiology, electric circuits. Each appears 300-400× across the sample.
- **Root cause:** difficulty-band collapse — many OpenSALT science/math standards land in band 1-2 alongside K-1 standards, so within-topic pool + `MIN_DIFF=0.3` lets K-1 candidates qualify for high-school skills.
- **Fix:** in `computePrereqCandidates` (around L2505), `if (skills[i].grade_start >= 6 && skills[j].grade_end !== undefined && skills[j].grade_end <= 2) continue;`. Requires `grade_start/grade_end` plumbing into the candidate structure (currently only in finalize).
- **Risk:** blocks legitimate K-1 → middle-school bridges. Apply only when target `grade_start >= 6` (not just >= 3).

### R3: Cross-domain contamination (~200-400 edges)
Social studies meta-competencies (`explain-why-people-follow-rules`, `summarize-stories-illustrate-positive-traits`) and a three-item business-cluster non-sequitur (`define-prefixes-suffixes-and-root-words`, `discuss-how-plants-respond-to-environmental-stimuli`, `use-roman-numerals-and-the-24-hour-clock`) picked as prereqs for math/science/marketing.
- **Root cause:** shared topic slug between cross-curricular frameworks and unrelated OpenSALT domains.
- **Fix:** before sending to LLM (around L2659), require each candidate to share at least one ≥5-char topic token OR one occupation with the target. Already partially done for cross-topic pool (D5); extend to within-topic candidates.
- **Risk:** genuine cross-domain foundations (reading comprehension → chemistry lab reports) suppressed. Whitelist the existing `FOUNDATION` set from postproc (math, reading, writing, problem-solving, etc.).

### R4: Study/meta-skill leakage (~50-100 edges)
`take-notes-and-put-things-into-your-own-words`, `mental-concentration`, `find-a-dedicated-study-space`, `test-anxiety-management` picked as prereqs for domain skills (exponential functions, probability, programming).
- **Fix:** denylist title regex in candidate filter: `/^(take[- ]notes?|mental[- ]concentration|find[- ]a[- ]dedicated|test[- ]anxiety|time[- ]management|study[- ]space|ask[- ]for[- ]help)/i`. Tighten if skill domain is STEM/language arts.

### R5: Scaffolding/student-directive titles (~50-100 edges)
`with-prompting-and-support-retell-...`, `by-date-when-asked-to-create-...`, `train-students-to-use-drafting-machines`, `instruct-other-pilots-...` — scaffolding instructions or instructor-actions phrased as skills.
- **Root cause:** stage `list` scaffolding filters (lines 568-632) miss these prefixes.
- **Fix:** extend `SCAFFOLDING_SIMPLE_RE` with `/^with\s+(prompting|guidance|support)/i`, `/^by\s+(date|the\s+end\s+of)/i`, `/^(train|instruct|teach)\s+\w+s?\s+to\s/i`.

### R6: Cross-language family contamination (~50-80 edges)
`french-field-experience ← german-iii`, `ap-german-language ← portuguese-iii`, `greek-for-native-speakers ← italian-iii`.
- **Fix:** language-family mutual exclusion in `computePrereqCandidates`. Slug list `["spanish","french","german","italian","portuguese","chinese","japanese","greek","latin","arabic","korean","russian","hebrew","swazi","kanuri","pulaar"]`; if skill contains one, exclude candidates containing a different one. Caught previously in round-1 audit too (`translate-intelligence ← swazi/kanuri/pulaar-language`).

### R7: Framework meta-tags / bare acronyms (~20-50 edges)
`human-machine-interfaces`, `digital-controls`, `communications-systems`, `patient-transfer-equipment`, `wcag`, `gps`, `iot` picked as prereqs.
- **Fix:** in stage `list`, drop entries that are pure short acronyms or single classification nouns (already partial filter at L617 `!/\s/.test(title) && title.length < 20`; extend to `length < 30`).

### R8: Tool/vendor products (~30-60 edges)
Round-1 flagged `ibm-curam`, `mastercam-cad-cam-software`, `eagle`, `adobe-indesign-cc`, `graphcalc`, `idrisi`, `aspose-words`, `mojolicious`, `shiny-r-package`, `backup-express`, `oracle-fusion-middleware`. The existing `onet:tech` filter only catches O*NET Tech Skills rows; these are Lightcast/ESCO.
- **Fix:** generalize the tech-hub filter: any prereq whose title matches `/\b(v\d|cc|ce|pro|enterprise|studio|suite|ide|sdk|api|platform|framework|package|library)\b/i` AND is not a seed edge AND the target is not also tagged as a tool implementation skill.

### R9: Advanced-math "none" — candidate pool lacks foundations
Skills returning "none": `define-the-antiderivative`, `matrix-eigenvalue-analysis`, `construct-truth-tables`, `recognize-the-structure-of-solution-sets-to-higher-order-linear`. LLM correctly refuses to pick K-1 junk but pool doesn't contain real prereqs (calculus, linear algebra, propositional logic).
- **Fix:** when target raw-difficulty is in the top quintile, expand ancestor candidate pool via LCSH/DBpedia broader-chain intersection, not just topic-shared skills. Relax `MIN_DIFF` to 0.1 for ancestor candidates.

### R10: Specialized tool "none" — missing domain mapping
`oracle-fusion-middleware`, `shiny-r-package`, `backup-express`, `magicalrecord`, `mojolicious` got "none" because candidates were poor.
- **Fix:** for Lightcast skills tagged `lightcast:specialized-skill` or matching `/^\w+-(package|framework|library|middleware|software)$/`, seed candidates from Lightcast's category hierarchy (type.id parent) in addition to embedding neighbors.

### R11: Compound-title noise from OpenSALT (upstream)
~3,593 prereq IDs in one chunk have ≥60-char hyphenated slugs. Even with my D2 80-char drop, 60-70 char titles survive and produce noisy candidates.
- **Fix:** lower OpenSALT post-summarize cap to 60 chars for skills with non-code title; drop if summarize didn't shorten. Re-run stage enrich on longer standards.

---

## Quality pass 10 (2026-04-17, multi-stage output audit)

Five parallel agents audited outputs across stages 1, seed-edges, dedupe, difficulty, and prereq-candidates. Findings grouped by stage.

### Stage `list` output (build/1_skills.tsv — 500-row sample)

**S1-1. Lowercase ESCO titles (~20% of rows)** — ESCO skills like "identify infestation source", "sell hair products" import verbatim without title-casing.
- **Fix:** in stage `list` ESCO parser, apply `titleCase()` on import. Preserve acronyms and known product names via whitelist.
- **Edges affected:** cosmetic but improves `display_title` quality and future matching.

**S1-2. Framework/code tag pollution (~20% of rows)** — OpenSALT rows dump `framework:*`, `code:*`, `opensalt:*` into the `tags` column alongside grade/topic tags. Example: `manage-projects` has `opensalt,framework:21st-century-skills,code:Life and Career Skills G,opensalt:category`.
- **Fix:** split OpenSALT metadata into a separate `framework` column or strip before emit. Keep `tags` for `grade:*`, `topic:*`, `occupation:*`, source markers only.

**S1-3. O*NET description truncation (~5% of task rows)** — descriptions end mid-word ("…ensure suppliers meet organizational sta"). parseTsv or upstream field-capping issue.
- **Fix:** validate O*NET task parsing — likely a regex or TSV column-cap bug. Re-parse `Task Statements.txt`.

**S1-4. Lightcast boilerplate descriptions (~1%)** — `oracle-unified-directory-oud`, `testng`, `restful-api` have description = literal "Specialized Skill" (the Lightcast `type.name` field).
- **Fix:** in stage `list` Lightcast parser, drop description when it equals `type.name`. Flag for stage `enrich` infill.

**S1-5. Long sentence titles surviving (~6%)** — OpenSALT standards 8–15 words long that weren't summarized.
- **Fix:** extend `stage enrich` summarize cache to include anything with `framework:*` tag AND word count > 8, regardless of existing title length.

---

### Seed-edge quarantine (build/1e_unresolved.tsv — 500-pair sample)

Distribution: metacademy 26%, opensalt_grade 25%, moocx 10%, alcpl 8%, khan 6%. Both-sides-unresolved = 61%.

**S2-1. Self-loops in seed emit (7% = 35 pairs in sample)** — `"Integration of Knowledge" → "Integration of Knowledge"`. Same label on both sides.
- **Fix:** in stage `seed-edges` where pairs are emitted (stageSeedEdges `addRaw`), skip when `rawSrc.toLowerCase() === rawDst.toLowerCase()`.

**S2-2. AL-CPL Wikipedia title format (8% = 39 pairs)** — `"Basis_(linear_algebra)"`, `"Motion_(physics)"` format; underscores + parens break embedding match.
- **Fix:** pre-normalize AL-CPL labels before emit: replace `_` with space, strip parenthetical clarifiers (`s/\s*\([^)]*\)//`), titleCase.
- **Expected recovery:** 15-25 pairs.

**S2-3. Khan parenthetical/abbreviation variance (~3%)** — `"Solve square-root equations (basic)"` fails to match `"Solve square-root equations"`; `"sec"/"min"/"hr"` abbreviation.
- **Fix:** normalize Khan labels — strip parentheticals, expand abbreviation dictionary. Expected recovery: 10-15 pairs, more if Khan becomes a skill source (D1).

**S2-4. MOOCCubeX untranslated Chinese (8%)** — labels like `"分区表"`, `"逻辑地址空间"` skipped by `data/translate.ts`.
- **Fix:** expand MOOCCubeX translation coverage to include ALL distinct labels from pair data, not just ones in `translations.json`.

**S2-5. OpenSALT within-grade redundancy (~6%)** — same concept at adjacent grade levels treated as prereq pair when it's just sequencing.
- **Fix:** in `opensalt_grade` emit, skip pairs where Jaccard similarity on normalized titles ≥0.80 (same concept, different grade).

**S2-6. Malformed labels** — truncated (`*K.RF.2.1 Demonstrate unders`), single-char, leading asterisks.
- **Fix:** validation at source: reject labels <3 chars, labels beginning with `*`, labels ending mid-word. Log to a rejection counter.

---

### Stage `dedupe` outputs (build/3b_tagged_deduped.tsv + 3b_aliases.tsv)

**S3-1. Over-merging on shared short tokens (high severity)** — `ac-dc-power → power-bi` (AC/DC electrical → Microsoft BI), `z-shell → c-shell` (distinct Unix shells), `ui-ux-writing → writing` (specific → generic).
- **Root cause:** shortest-title tiebreak (pipeline.ts L1823) picks the shorter canonical blindly; token-sort signature merge on generic tokens ("shell", "writing", "power").
- **Fix:** add `ANTONYM_GROUPS` entries `["ac","dc"]`, `["z","c","bash","fish","ksh"]`. Replace length-tiebreak with a subset check: prefer the canonical whose title is a non-subset of the other, only fall back to shortest when both are truly synonymous.

**S3-2. Wikipedia-category garbage in topics (~15% of rows)** — DBpedia categories like `wildlife-management-areas-ohio`, `years-in-sport`, `rome-officials-and-employees`, `constitutional-court-judges`, `multi-sport-events`, `years-in-animation` appear as topics on unrelated skills ("Remove debris from work sites", "Set up banquet tables").
- **Root cause:** LCSH/DBpedia backfill (M4) pulls ancestor chain without aggressive category-pattern filtering.
- **Fix:** extend the existing `wikiCatRe` (pipeline.ts stage finalize) to run *during* LCSH backfill in stage dedupe, not just at finalize. Add patterns: `/^(years|decades|centuries)-in-/`, `/-areas-[a-z]+$/`, `/-(judges|officials|employees|members|persons)$/`.

**S3-3. Junk occupations from embedding match (~12% of rows)** — `military-enlisted-tactical-operations-and-c186c8` (ESCO overflow-hashed occupation slug) and `word-processors-and-typists`, `textile-winding-twisting-and-drawing-out-machine-setters-operators-and-tenders` appearing for math/vocab/Khan skills.
- **Root cause:** embedding cosine match in stage `tag` picks generic-sounding occupations when no good match exists; ESCO's long occupation titles get hashed slugs that aren't filtered.
- **Fix:** (a) reject occupation slugs with hex hash suffix (same regex as slug overflow test). (b) Raise occupation cosine threshold in stage `tag` (currently 0.70?), or require at least two distinct occupation matches before emitting any. (c) Blocklist or cap generic occupations (`word-processors-and-typists`).

**S3-4. Cross-topic near-duplicates missed** — dedupe buckets by first topic slug; pairs in different buckets never compare. Estimated 2,000-4,000 missed merges in full 66k.
- **Fix:** after per-topic pass, run a second pass over `_notopic` + a random 5% cross-topic sample at cosine ≥ 0.97.

**S3-5. Transitive aliases not collapsed** — `jdk1-5 → jdk1-4`, `jdk1-7 → jdk1-4` may become stale if `jdk1-4` merges downstream.
- **Fix:** when loading `3b_aliases.tsv`, collapse chains: for each entry, follow the map until terminal canonical. Apply at pipeline.ts L2908 (postproc alias loader) and L3084 (finalize alias loader).

---

### Stage `difficulty` extremes (build/4_difficulty.tsv top/bottom 50)

**S4-1. PAV plateau at raw=1.0 (48% of bottom 50)** — items with raw_score exactly 1.0000 all map to band 2, indicating the isotonic regression has a flat plateau covering a wide input range.
- **Root cause:** few grade anchors in the 0–3 difficulty region; kNN smoothing converges to 1.0 for all unanchored skills in sparse neighborhoods.
- **Fix:** after isotonic fit, add a jitter band mapping: within a flat plateau, spread items across 2 bands using their raw embedding-based rank. Or: expand anchor set by bootstrapping from Khan V-Position + LCSH depth.

**S4-2. Ceiling effect at raw=19.0 (100% of top 50)** — everything at the top pile-up scores exactly 19.0.
- **Root cause:** O*NET Job Zone anchors give ~14-15, and kNN from there caps out at 19.0 due to the `anchor + 4-5` offset in the difficulty calibration.
- **Fix:** extend raw-score domain above 19.0 via expert skills (PhD-level, research). Alternatively accept the ceiling but map to band 20 uniformly instead of creating 19 vs 20 distinction.

**S4-3. K-12 health concepts miscategorized as professional (3+ in top 50)** — `puberty` (band 20), `understands-reproduction-and-heredity` (band 19), `syphilis` (band 20). These are K-12 health curriculum but got pulled to professional level by O*NET medical neighbors.
- **Fix:** post-anchor override: if a skill has an OpenSALT/NGSS grade anchor indicating ≤ grade 12, cap its final band at 13 regardless of kNN pull.

---

### Stage `prereq` candidate pool (build/5_candidates.tsv — 60 skills)

**S5-1. PREREQ_MIN_DIFF_DELTA too small (0.3)** — same-topic pool returns peers, not foundations. `urinary-tract-infection` gets Listeria/Clostridium/Staphylococcus as candidates (all peer infectious diseases, none a foundation).
- **Fix:** raise `PREREQ_MIN_DIFF_DELTA` default from 0.3 to 0.9. Keep env-tunable. This is the single highest-leverage knob.

**S5-2. Cross-topic token length too short (≥5 chars)** — connects `prepare-medication` to `prepare-pasta` via shared token `prepar`; `software-manufacturing` to `cultural-practices` via `manufac`/`cultur`.
- **Fix:** raise min token length from 5 to 7 in `computePrereqCandidates` cross-topic match (pipeline.ts L2534, 2539, 2554, 2566). Kills weak-connector matches while keeping `carpent`, `surgeon`, `softwar`.

**S5-3. "Computing devices" K-grade cluster as cross-topic phantom hub** — 5 nearly identical OpenSALT K-grade items flood candidate slots for any skill with `compu*` topic token.
- **Fix:** near-duplicate cluster dedup: after cosine scoring, if >2 candidates have ≥0.97 cosine with each other, keep only the highest-scoring one.

**S5-4. SCED ghost block (`research`, `reading-to-children`, `comparative-government`, `social-sciences`, `world-history-and-geography`)** — appears as candidates for unrelated vocational skills (computer-maintenance, small-engine-mechanics, heavy-equipment-mechanics, italian-literature).
- **Root cause:** same as R1 (SCED phantom hubs), but visible at candidate-pool stage too.
- **Fix:** exclude skills with `sced:catalog` source tag from the candidate pool (see R1).

---

## Quality pass 11 (2026-04-17, topic/occupation/tree/hub audit)

Five parallel agents audited topic distribution, occupations, LCSH/DBpedia trees, prereq-graph hubs, and cross-source dedupe residue.

### Topics (6,492 distinct)

**T1. Framework/year/school-year pollution (~10,000 noise assignments).** Top "topics" are standards frameworks: `north-carolina-cte-standards-after-fall-2018-19-updates` (3,107), `sced-8-0-course-codes` (1,321), `content-khan-academy` (1,118), `social-studies-2023-2024` (763), `mathematics-standards-of-learning-for-virginia-public-schools-2023` (578), `georgia-s-k-12-mathematics-standards-implementation-sy2023-2024` (407), `florida-math-scope-and-sequence` (358), `oklahoma-academic-standards-for-mathematics-2022` (228).
- **Root cause:** `frameworkRe` in stage finalize catches `-standards|-20\d\d|^sced-` etc., but misses school-year-range segments (`2022-2023`, `2018-19-updates`), `scope-and-sequence`, `-sy\d{4}`, `early-childhood-standards`, `mathematics-b-e-s-t-effective-starting`.
- **Fix:** extend `frameworkRe` to include `\d{4}-\d{4}` segments, `\d{2}-\d{2}-updates`, `scope-and-sequence`, `-sy\d{4}`, `-effective-starting`, `early-childhood-standards`. Apply at dedupe backfill too, not just finalize (same fix as T3).
- **Edges affected:** ~10,000 cross-skill candidate-pool bloat removed.

**T2. Wikipedia maintenance categories missed by wikiCatRe.** `sports-records` (471), `rome-officials-and-employees` (471), `wikiproject-countries-projects` (338), `de-havilland-aircraft` (175), `years-in-music` (153), `requests-for-peer-review` (19), many `wikiproject-*-templates` variants.
- **Fix:** extend `wikiCatRe` with `^wikiproject-`, `-templates$`, `^years-in-`, `-matches$`, `-aircraft$`, `-by-nationality$`, `-records$`.
- **Edges affected:** 500-1,000 skills with at least one junk topic.

**T3. LCSH/DBpedia backfill adds junk (M4 introduced bug).** ~12% of ancestor chains contain junk (years/decades/centuries prefixes, demographic metadata, wikiproject entries, sports/league metadata, overly narrow language classifications).
- **Root cause:** stage `dedupe` at pipeline.ts L2018 executes `c.topics = anc.slice(0, 3)` with NO filtering. The `wikiCatRe`/`frameworkRe`/`yearRe` patterns exist only in stage `finalize` (L3345-3350), applied too late.
- **Fix:** apply the same regex filter in the dedupe backfill loop before `.slice(0, 3)`.

**T4. Near-singleton tail (1,000-1,500 near-singleton topics).** Topics with f=2-4 never form useful clusters; they pass the `f<2` filter but add noise.
- **Fix:** raise finalize `topicFreq` threshold from `f < 2` to `f < 4`.

**T5. Generic single-word topics (~30-50 high-frequency slugs).** `health` (343), `services` (254), `arts` (184) are real domains but too broad; `skills` (776) already blocklisted.
- **Fix:** audit each manually; either whitelist (so they survive MAX_FREQ) or blocklist.

### Occupations

**O1. Hex-suffix ESCO overflow occupations surviving as hubs.** `military-enlisted-tactical-operations-and-air-weapons-specialists-and-c186c8` (1,605), `adult-basic-education-adult-secondary-education-and-english-as-a-second-a5cdd0` (550), `teaching-assistants-preschool-elementary-middle-and-secondary-school-beae40` (97), and more.
- **Fix:** same hex-suffix regex as slug tests: reject any occupation matching `/-[a-f0-9]{6}$/` in stage `tag` emit. Extend ESCO occupation title normalization to drop entries whose slug would overflow 80 chars (similar to D2 fix for OpenSALT).

**O2. >1% frequency "skill sponges".** 8 occupations exceed 1% of the skill set, absorbing cross-domain assignments via cosine phantom matches: `quality-control-systems-managers` (2,273), `computers-computer-peripheral-equipment-and-software-distribution-manager` (1,297), `word-processors-and-typists` (1,069), `textile-winding-twisting-and-drawing-out-machine-setters-operators-and-tenders` (1,068), `solar-energy-systems-engineers` (858).
- **Fix:** cap per-occupation frequency at 500 in stage `tag` (drop the weakest cosine matches once cap is hit). Or: blocklist the generic distribution-manager and typist-style titles entirely.

**O3. Manager/director role inflation.** ~40 `*-manager` / `*-director` / `ict-*-manager` roles dominate mid-frequency range — manager embeddings are broad and match across domains.
- **Fix:** raise cosine threshold for occupation slugs containing `-manager|-director|-supervisor` from 0.90 to 0.95.

### Prereq graph hubs (from in-progress build/5_prereqs.tsv)

**H1. Holiday-retell cluster (~12,000 bad edges).** 8 skills with 1,800-2,100 in-degree each: `retell-stories-related-to-flag-day-...`, `retell-stories-related-to-independence-day-...`, `retell-stories-related-to-martin-luther-king-jr-day-...`, `retell-stories-related-to-juneteenth-national-independence-day-...`. Plus `classify-character-traits-and-their-influence-on-personal-growth` (1,952) and `identify-and-describe-the-people-and-or-events-related-to-customs-around-84900b` (1,637).
- **Root cause:** Florida/Georgia K-3 social-studies scope-and-sequence frameworks surface holiday-specific standards as separate skill nodes. Huge ELA K-3 topic pool puts them in many candidate lists.
- **Fix:** title-pattern blocklist in stage `postproc` before hub-cap: drop edges where prereq slug matches `/retell-stories-related-to-.*-day|customs-around-.*-day|-national-independence-day|classify-character-traits-and-their-influence/`. These are leaf standards, not foundations.

**H2. `understand-object-naming-and-naming-conventions-and-standards` (3,358 edges).** Single North Carolina CTE course standard that becomes universal prereq for CS/technical skills.
- **Root cause:** only 1 non-framework topic (`congresses-and-conventions` from LCSH ancestor on "conventions"), so never qualifies for within-topic pool → always in global fallback. Title is maximally persuasive to LLM ("naming conventions" is a near-universal software prereq).
- **Fix:** in `computePrereqCandidates` global-pool fallback, exclude skills whose only non-framework topic came from LCSH/DBpedia ancestors (single-source framework skills shouldn't enter the global pool). Alternatively: in stage `postproc`, blocklist any prereq whose source is a single CTE framework and whose title starts with "understand-...-conventions-and-standards".

**H3. SCED language-immersion hubs (~2,000 edges).** `american-indian-language-immersion-prior-to-secon` (1,109), `american-sign-language-immersion-prior-to-seconda` (897). Course-catalog entries from `sced-8-0-course-codes` framework.
- **Fix:** same as R1 — tag SCED-only skills and exclude from candidate pool.

**H4. Sanity test for pipeline_test.ts**. Add:
```ts
Deno.test("postproc: no anomalous hub from single-framework OpenSALT source", () => {
  const stats = JSON.parse(Deno.readTextFileSync("build/6_stats.json"));
  const top = stats.branching?.top_in_degree ?? [];
  const bad = /retell-stories-related-to.*-day|sced-|language-immersion-prior|understand-object-naming-and-naming-conventions/;
  for (const [id, count] of top.slice(0, 20)) {
    assert(!bad.test(id) || count <= 200,
      `Anomalous hub "${id}" in-degree ${count}`);
  }
});
```

### Cross-source dedupe residue

**X1. Near-zero under-merging** — only 2 missed clusters in 66,799 (`electrooptics`/`electro-optics`, `non-verbal-communication`/`nonverbal-communication`). 99.97% dedupe effectiveness.
- **Fix (low priority):** pre-normalize compound modifiers (strip all hyphens inside words ≤12 chars) before signature computation.

---

## Quality pass 12 (2026-04-17, data column forensics)

### Tag namespace (9 namespaces across 66k skills)

**TG1. `grade:KG` vs `grade:K` inconsistency (679 skills).** Source CASE data uses `KG`; difficulty stage looks for `K`. These 679 skills silently lose their grade anchor.
- **Fix (stage list grade normalization):** map `KG` → `K` when emitting grade tags. Also audit `grade:PR` (402), `grade:TK` (204), `grade:IT` (198) — do they have difficulty-mapping entries?

**TG2. Junk `code:*` tags (310 `code:a`, 297 `code:b`, 237 `code:c`, etc.).** Single-char CASE `humanCodingScheme` sub-item labels (67 total bad tags). **`deriveDisplay()` at finalize L3304 falls back to these as `display_title` when title > 80 chars**, producing `display_title = "b"`. Active bug.
- **Fix (stage list OpenSALT parser):** only emit `code:*` if value length ≥ 4 AND matches `/[A-Z]/` or `/\./`. Also strip `code:Khan ` prefix (redundant with `framework:content-khan-academy`).

**TG3. `framework:*` tags serve no downstream consumer.** 92 framework slugs, averaging 15,440 total tag-slots. Not matched, filtered, or exposed. Pure provenance noise eating tag budget on 38 cap-hit skills.
- **Fix:** strip `framework:*` in stage `postproc` before finalize writes `skills.tsv`.

**TG4. Non-skill OpenSALT subtypes (~100 rows).** `opensalt:assignment` (71), `opensalt:lesson` (10), `opensalt:job-role` (4), `opensalt:employee` (1), `opensalt:team-leader`, `opensalt:people-leader`, `opensalt:senior-leader` — framework organizational nodes, not learnable skills.
- **Fix:** in stage `list` OpenSALT parser, drop items with these `CFItemType` values (already have `SCAFFOLDING_TYPES` set — extend it).

**TG5. `onet:hot` tag redundant (169 skills).** Duplicate of `onet:tech:*` subtypes. No new information.
- **Fix:** don't emit `onet:hot`; rely on `onet:tech:*`.

### Descriptions

**DESC1. 12% empty descriptions (8,072), nearly all OpenSALT (8,014).** Most standards-frameworks lack descriptions. Not recoverable without stage `enrich` LLM expansion — expensive but doable.
- **Fix:** route OpenSALT empty descs through the `1d_onet_desc` stage machinery (or a new `1e_opensalt_desc`) for LLM description infill.

**DESC2. 372 Lightcast placeholder descriptions** literally equal "Specialized Skill" / "Common Skill".
- **Fix:** in stage `list` Lightcast parser, if description == `type.name`, drop description (let stage `enrich` infill).

**DESC3. Pedagogical filler prefixes (176 rows).** "Students will…" (114), "The student demonstrates…" (15), "This unit covers…" (12).
- **Fix:** at stage `list` OpenSALT parse, strip these prefixes: `/^(Students?\s+(will|demonstrate)|The student|This unit|Module \d+|The course|Courses)\s.*?\.\s+/`.

### Source attribution

**SRC1. Low cross-source merge rate (1.8%) is NOT a bug.** Datasets have different domain focus; dedupe is working (693 merges, 4 exact fuzzy-key collisions on XML/HTML/CSS/Workday caught, ~36 semantic near-misses remain).
- **Fix (optional, +40 merges):** embedding-based fallback in dedupe for titles with cosine ≥0.85 + shared token. Low priority given the tiny gain.

### LLM enrichment caches

**ENR1. 1b_infill tone drift (~25%).** "Strategic", "optimized", "enables", "leverages" — marketing voice instead of neutral definitions.
- **Fix (prompt revision):** "Write a single factual sentence (≤100 chars) defining the skill without marketing language, jargon, or elaboration."

**ENR2. Output truncation (~13%).** Enrichment outputs cut mid-word ("infrastructur", "compliance with institutional") — buffer issue.
- **Fix:** investigate the `generateOne` `num_predict` limit (default 120 for prereq, should be higher for enrichment) and TSV field write. Likely the output cap is too tight for 150-200-char descriptions.

**ENR3. 1d_onet_desc bloat (40% of outputs >200 chars).** Template "This task involves…" in 43% of sampled rows.
- **Fix:** prompt revision: "Describe in one sentence (<150 chars). Start with the action verb. Do not use 'This task involves'."

**ENR4. 1c_summarize occasional concept-addition (~5%).** "Describe situations when the United States has been involved" → "Describe US international conflicts" (added "international" not in source).
- **Fix:** prompt: "Extract only concepts in the input; do not add or assume."

### OpenSALT frameworks (92 total contributing 12,964 skills)

**OS1. True duplicate framework: `pcg-georgia-…-sy2023-2024-2`** overlaps 99.8% with `pcg-georgia-…-sy2023-2024`. Appears to be same file re-uploaded with `-2` slug suffix.
- **Fix:** drop `-2` variant at stage `list`; lose only 2 unique skills.

**OS2. Year-version near-duplicates.** `gcps-aks-language-arts-2021-2022` (378) vs `-2023-2024` (409), 95.2% overlap. `pcg-mathematics-b-e-s-t-effective-starting-2022-2023` (270) vs `mathematics-b-e-s-t` (139), 95.7% overlap. `indiana-academic-standards-for-mathematics-2023` (20) is 85% overlap with 2020 version, adds 3 skills.
- **Fix:** drop older year in each pair. Saves ~155 skills.

**OS3. `florida-math-scope-and-sequence` is 95% orphans (369 isolated).** Verbose scope-and-sequence lesson descriptions, not skill concepts.
- **Fix:** drop entire framework at stage list.

**OS4. NC-CTE has 813 orphan skills (28% of 2,903).** These are vocational standards that never connect to the graph.
- **Fix:** in stage `postproc`, drop NC-CTE skills with zero edges in + out (no seed, no LLM pick, no orphan-fix target).

**OS5. Test/template stubs (~60 skills).** `normalized-data-schema` (12), `scope-and-sequence-framework-template` (9), Alabama test stubs (4 frameworks × 2-12 skills), `norm-webb-s-depth-of-knowledge` (1), Florida grade-3-only slices (3 frameworks × 5-10 skills).
- **Fix:** stage list framework blocklist by slug prefix.

**OS6. Missing major state frameworks.** California, New York, Texas, Washington, Pennsylvania, Ohio all absent. CCSS Math only contributes 63 skills (the full CCSS is in the deleted `data/asn/` and `data/common-standards-project/`).
- **Note:** my earlier deletion of unwired datasets removed potentially useful coverage. The agent recommends re-downloading ASN + CSP if state-level coverage matters.

---

## Quality pass 13 (2026-04-17, coherence/seed/orphan/embeddings)

### CRITICAL: duplicate-embedding bug (stage embed)

**CR1. 271 distinct groups of skills share IDENTICAL embedding vectors.** Top offenders:
- **453 skills** in one group (ampl, arisg, airtable, ...) — all Lightcast boilerplate "Specialized Skill" / empty-description
- **320 skills** in another (3m-encoder, abstract-class, abvent-artlantis, ...) — same root
- **219 skills** (economic-concepts, nuclear-processes, wave-properties) — NGSS DCI boilerplate
- **72 skills each** language-skill clusters (`understand-written-*`, `write-*`, `interact-verbally-in-*`, bare language names)
- Magnitude of these vectors: 22.97 (embeddings are unnormalized raw Ollama output)

These pathological embeddings explain the `language-acquisition` NN anomaly (dot product 528.08 with 5 alphabetically-first skills all at identical score). Anywhere the candidate pool uses embedding cosine, these duplicate-embedding groups flood it.

**Suspected root cause:** two possibilities to investigate:
1. stage `embed` is embedding only the title when description is empty, and for Lightcast skills with description = "Specialized Skill" the stripped/boilerplate content hashes to a single cache entry somehow (unlikely but worth checking `appendEmbCache` vs `normalizedEmbeddingsForSkills`).
2. Ollama occasionally returned the same fallback vector under load or for short inputs. The `stageEmbed` NaN check (L1291) catches NaN/Inf but not "all-identical-across-calls".

**Fix (stage `embed`):**
- After embedding, detect duplicate vectors. If >5 skills share a vector, re-embed them individually (not via batch cache). Log the group.
- Add a `dup_vector_count` metric to `build/2_stats.json`.
- For Lightcast skills with description = "Specialized Skill" (see DESC2 in pass 12), drop description before embedding so the title alone carries signal.

This interacts with D5 and R-series candidate-pool issues: fixing embeddings alone would reduce cross-topic noise dramatically because the "phantom duplicate cluster" disappears.

### Cross-stage coherence

**CR2. `3b_tagged_deduped.tsv` has ZERO `grade:*` tags for OpenSALT rows.** 13,011 rows with `opensalt` source, 0 with any `grade:*` tag in the `tags` column. But `skills.tsv` shows 9,617 OpenSALT rows with non-empty `grade_start` — so the tags *were* emitted at stage list originally but got lost somewhere between list and 3b output. The `difficulty` stage kNN reads from 3b and has no grade anchors to use for 3k+ OpenSALT skills.
- **Diagnosis needed:** check whether stage `tag` or `dedupe` strips grade tags, or whether the canonical picked during dedupe is the one without grade tags (dedupe's `allTags` merge should union them).
- **Fix (likely stage dedupe L1921):** `canons.push({ ... allTags: [...allTags] })` — verify that `allTags` contains grade tags from all merged rows, not just the canonical.
- **Expected impact:** once fixed, difficulty kNN can properly anchor thousands of OpenSALT skills. Should reduce grade-vs-band inversions.

**CR3. Wide-grade-span skills anchored at high end.** 392 skills with grade_start ≤3 and band >10 — for skills tagged "grade 3-12", difficulty stage treats them as grade-12-level. Root cause: grade anchor uses `Math.max(...grades)` at pipeline.ts L1997.
- **Fix:** use `Math.min(...grades)` (grade-start) or mean/median instead of max. This better reflects "first teachable at grade 3".

**CR4. Topic↔title mismatch from one-word titles.** ~0.5% of rows (~330 in full dataset) get bad topic from cosine match on a single-word title. Example: "Unicast" (networking) → `power-transmission` (mechanical drive-trains).
- **Fix:** for titles ≤2 words, require at least one shared significant token between title slug and assigned topic slug before accepting.

### Seed-edge survival

**SV1. Only 8.7% of seed edges appear in LLM cache (156/1,801).** Khan at 8%, MOOCx at 0-1%, AL-CPL Precalc best at 15%.
- This is *expected*: postproc injects seeds directly after LLM picking, so LLM doesn't need to rediscover them. Not a bug.
- 2 direction reversals found in a 50-seed sample (`quadratics-by-taking-square-roots`, `vertical-angles`) — LLM disagreed with seed direction. Trust seeds over LLM.
- **Follow-up when postproc finishes:** check `build/6_edges.tsv` for actual seed survival rate; if <80%, something in postproc is over-filtering.

### None-response patterns

**NR1. 10,323 "none" responses (9.3% of 110k cache).** O*NET dominates at 18% none rate due to verbose outcome-oriented task statements with poor candidate pools.

**NR2. 34% of "none" skills are leaf-by-accident** (other skills depend on them). Top 50 such skills have 5,235 incoming edges combined. These are high-leverage to fix.

**NR3. Microsoft Access got "none" despite obvious foundations** (Microsoft Office, database management, computer-use). Its candidate pool contains "teach anthropology" and "types of barley". Root cause: weak occupational cross-linking for cross-domain tool skills.
- **Fix:** expand ancestor pool for cross-source multi-tag skills to include Lightcast-category-hierarchy + occupation co-occurring skills.

**NR4. "types-of-X" enumeration skills (~0.2% of nones)** legitimately have no prereqs — skip optimization.

**NR5. Tool-operation skills** (`operate-bulldozer`, `operate-sandblaster`) get "none" because pool lacks category seeds like `operate-heavy-machinery`. Low-effort manual seeds would help.

---

## Quality pass 14 (2026-04-17, embed bug root cause CONFIRMED)

### CR1 update: it's nomic-embed-text, not our pipeline

Reproduced via direct Ollama API calls against `nomic-embed-text`:
```
"X"                               → [-0.0324, 0.0484, -3.6807, 0.2305, 1.5641, 0.2628]
"Y"                               → [-0.0324, 0.0484, -3.6807, 0.2305, 1.5641, 0.2628]   ← IDENTICAL to X
"Photosynthesis"                  → [-0.0324, 0.0484, -3.6807, 0.2305, 1.5641, 0.2628]   ← also IDENTICAL
"AMPL\nSpecialized Skill"         → [-0.0364, 0.5318, -4.2708, -0.1846, 1.3698, 0.1912]
"Airtable\nSpecialized Skill"     → [-0.0364, 0.5318, -4.2708, -0.1846, 1.3698, 0.1912]  ← IDENTICAL
"Economic Concepts"               → [-0.1231, 0.2982, -3.8333, 0.0649, 1.4995, 0.2380]
"Nuclear Processes"               → [-0.1231, 0.2982, -3.8333, 0.0649, 1.4995, 0.2380]   ← IDENTICAL
"Photosynthesis\n<40+ char desc>" → [0.8205, 0.4183, -3.6505, 0.5470, 0.4523, -0.6366]  ← distinct, different from short version!
```

The `nomic-embed-text` model (as served by Ollama 0.20.7) **returns a constant-or-near-constant vector for short inputs**. The threshold appears to be where the tokenized input is too short for the model's pooling to produce a meaningful mean embedding — the CLS/EOS/padding token dominates.

**Impact:** any skill whose embedded content is short-and-generic (Lightcast "Specialized Skill" boilerplate, OpenSALT empty-desc short titles, bare technology names) gets a pathological embedding. This is the root cause of:
- 271 duplicate-embedding groups (453 + 320 + 219 + 91 + 72×N language clusters + 48 NGSS + 44 bare language names + ...)
- `language-acquisition` NN pulling `adobe-air`, `3m-encoder`, `abstract-class`
- Cross-topic candidate pool bloat reported across passes 9-13

**Fix — stage embed:**

1. **Pre-embedding content enrichment.** Before calling Ollama, pad short content to a minimum useful length:
   ```ts
   const content = c[2]
     ? `${c[1]}\n${c[2]}`
     : `${c[1]}. ${c[4].replace(/[,]/g, " ").slice(0, 200)}`;  // title + tag breadcrumb
   ```
   Tags carry framework/grade/topic context that's sufficient to disambiguate.

2. **Post-embedding duplicate detection.** After `embedBatch`, compute a hash of the first 16 float values; skills whose hash appears in >2 other skills are flagged. Re-embed with a different prompt (append description, pad content) and try again. If still duplicate, mark the skill as `embed:pathological` and exclude from candidate pools.

3. **Immediate mitigation until re-embed:** in `computePrereqCandidates` cosine scoring, skip any candidate whose embedding magnitude is in the pathological range (22-24) AND matches a precomputed set of known-duplicate signatures. Roughly 1,500-2,500 skills.

4. **Test.** Add to `pipeline_test.ts`:
   ```ts
   Deno.test("stage 2: no more than 5 skills share an embedding", () => {
     const DIM = 768;
     const ids = Deno.readTextFileSync("build/2_ids.tsv").split("\n").filter(l => l.length);
     const bin = Deno.readFileSync("build/2_embeddings.bin");
     const emb = new Float32Array(bin.buffer);
     const sig = new Map<string, number>();
     for (let i = 0; i < ids.length; i++) {
       const s = `${emb[i*DIM].toFixed(4)}_${emb[i*DIM+1].toFixed(4)}_${emb[i*DIM+2].toFixed(4)}`;
       sig.set(s, (sig.get(s) ?? 0) + 1);
     }
     const worst = Math.max(...sig.values());
     assert(worst <= 5, `${worst} skills share an embedding signature — embed quality collapsed`);
   });
   ```

### Estimated impact of fixing CR1

- Candidate pool quality improves across the board; eliminates the "phantom cluster" of alphabetically-first skills that the LLM picks blindly.
- Reduces cross-domain false positives by 20-40% (conservative — those language-family and Lightcast-placeholder clusters were the worst offenders).
- Some downstream fixes (H2 `understand-object-naming-...` hub, S5-3 computing-devices K-grade cluster) become unnecessary because the underlying cosine collapse goes away.

### CR2 follow-up: OpenSALT grade tags

The finding in CR2 (3b_tagged_deduped.tsv has zero grade tags) was partially incorrect: grade tags *are* present in the `tags` column for OpenSALT skills that got grade anchors at parse time. The missing-grade diagnosis needs a more careful check after the current pipeline run completes and produces a fresh `3b_tagged_deduped.tsv`.

---

## Quality pass 15 (2026-04-17, multi-source + Khan + enrichment + edge cases)

### Multi-source "none" anomaly

**M1. Multi-source skills refuse pick at 9.13% vs 6.01% for single-source** — opposite of expected. Investigation: zero-pick multi-source skills are niche cross-domain concepts (acupressure, aesthetics, ajax, arabic) whose candidate pool falls back to global/random when their topic tags are sparse. The LLM correctly refuses garbage.
- **Fix:** in `computePrereqCandidates` fallback (pipeline.ts L2496), if pool.size < K AND skill has ≥2 sources, don't fall through to global pool — keep as empty (let LLM output "none") rather than hand it random candidates.

### Khan Academy quality (1,073 surviving skills)

**K1. 100% of sampled Khan skills got junk occupation tags.** `multiply-and-divide-by-10` → `quality-control-systems-managers`, `word-processors-and-typists`. `surface-area` → `textile-machine-operators`. K-12 math content is getting cosine-matched to industrial job titles. ~950+ Khan skills affected.
- **Root cause:** stage `tag` cosine match picks generic occupations for short Khan titles (same embedding-collapse issue as CR1). For K-12 content, occupations shouldn't be assigned at all.
- **Fix:** in stage `tag`, if source tags include `framework:content-khan-academy` OR grade_end ≤ 8 AND skill has no O*NET/ESCO source tag, skip occupation matching entirely.

**K2. Khan seed-edge resolution 43.4% (547/1,261).** Khan TSV slugs don't match OpenSALT Khan framework slugs even though both come from Khan. Example: TSV has `counting-out-1-20-objects`, OpenSALT has `count-with-small-numbers`.
- **Fix (D1 refinement):** add explicit Khan-to-OpenSALT-Khan ID crosswalk. Crosswalk by humanCodingScheme (e.g., `code:Khan K.CC.B.5` in both) rather than title slug.
- **Recovery estimate:** ~700 additional seed edges preserved.

### LLM enrichment hallucinations (50-sample Sonnet review)

**E1. Distribution: 62% accurate, 20% approximate, 10% wrong, 8% vague.**

**E2. Same-name domain confusion (5 wrong of 50, extrapolate ~3k hallucinated desc in cache):**
- `protege` → defined as "person receiving mentorship" but in Lightcast context = Protégé ontology editor (Stanford)
- `finagle` → "clever manipulation" but = Twitter Finagle RPC framework (Scala)
- `sig-codes` → defined as medical records abbreviations but = pharmacy prescription abbreviations
- `oss-through-java` → defined as open-source-in-Java but = OSS/BSS telecom Java impl
- `certified-chemical-technician` → invented "Institute of Chemical Technicians" (actual: ACS ChemTech / SETA)
- **Fix (stage `enrich` prompt):** prepend "You are describing entries in a professional labor-market skills taxonomy (Lightcast). When a name is ambiguous between generic English and a specific technical tool/product/standard, assume the technical interpretation. Do not invent organization names."

**E3. Category rate (10 approximate, 4 vague):**
- PNG grouped with lossy codecs (lossless vs lossy confusion)
- Sigmoidoscopy described as "lower intestine" (imprecise — large intestine only)
- Federal estate/gift tax said to change "annually" (only thresholds index, not rates)
- NCCER Electrical missing industrial track
- **Fix:** prompt reminder to be domain-precise; cite actual standards/certifying bodies when applicable.

### OpenSALT item-type blocklist extension (pass 12 TG4 follow-up)

**OT1. Additional types to block:** `opensalt:sub-domain` (68), `opensalt:category` (46), `opensalt:connection` (53 — narrative connectors like "Scientists use different ways to study the world"), `opensalt:grade` (7), `opensalt:grade-band` (4), `opensalt:quarter` (1), `opensalt:section-heading` (1), `opensalt:pathway` (1), `opensalt:subject` (1), `opensalt:dimension` (5), `opensalt:cognitive-complexity` (4), `opensalt:performance-level` (5).
- Drops ~236 non-learnable framework scaffolding skills from OpenSALT corpus.

### Edge-case titles

**EC1. Metadata-prefix titles that escaped stage list filter (27 skills):** `Unit 3- Descriptive Statistics`, `Benchmark 1.2 Demonstrates interest…`, `Unit Cohesion`, `Unit Investment Trust`.
- **Fix:** extend stage list OpenSALT regex to strip or drop `^(Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]*`.

**EC2. Question/command prefixes (35 skills):** `Can apply understanding of Coaching Principles`, `Can interpret assessment results for a client`, `Can use the O*NET to obtain necessary information`.
- **Fix:** stage list: strip leading `^(Can|Could|Should|How to|What is|Why does)\s+`, lowercase the following verb.

**EC3. Confirmation of cleanliness:** 0 pure-number titles, 0 HTML-entity leakage, 0 duplicate titles with different IDs, 245 short-title skills (mostly legit Lightcast tech acronyms — keep).

---

## Quality pass 16 (2026-04-17, difficulty reversals / missing foundations / stale cache)

### Reversed-difficulty edges (45,077 = 23.1% of LLM picks)

**DR1. PREREQ_MIN_DIFF_DELTA=0.3 is effectively inert in the crowded 14-19 band range.** Median raw difficulty is 14.6; p75 is 16.0. Lightcast+ESCO professional skills all cluster there, so a 0.3 delta is below the noise floor.
- **By source:** Lightcast 43.7%, ESCO 30.7%, OpenSALT 20.2%, O\*NET 15.3%.
- **Band transitions:** 76.8% of reversals are within bands 14-17. Top pair: 17→18 (4,482 edges).
- **Fix:** raise `PREREQ_MIN_DIFF_DELTA` default from 0.3 to 1.5 AND add a hard band-guard `diff[j] < diff[i]` in candidate-pool construction. Expected: 23% → <5%. Must delete 5_candidates.tsv to force recompute.

**DR2. 464 seed edges (25.9%) are themselves reversed.** Worst: `alcpl_precalculus` (78%), `alcpl_physics` (59%), `moocx_psy` (41%), Khan (24%). Examples: `machine-learning` (band 18) ← `boosting` (band 15, sub-technique — correctly picked but band miscalibrated); `statistics` (band 17) ← `statistical-hypothesis-testing` (band 15). These pass through postproc's band filter because `isSeed(s,p)` exempts them.
- **Root cause:** AL-CPL / MOOCx concepts land in the crowded professional-skill band plateau without grade anchors, so kNN smoothing orders them by embedding neighbors rather than true pedagogical depth.
- **Fix:** during stage `difficulty`, anchor seed-edge endpoints directly: `raw[src] = raw[dst] - 1.0` minimum for any `src → dst` seed. Or: remove seed-exemption from band filter and let them drop.

### Missing foundations (K-12 math fragmentation)

**MF1. Core concepts absent as top-level skills:**
- `addition` — NO id, 67 title matches, 284+ grade-range variants (`add-within-5`, `fluently-add-and-subtract-within-100`, ...)
- `subtraction`, `multiplication`, `division` — same pattern
- `fractions`, `decimals`, `percentages`, `place-value` — no atomic skills
- `pythagorean-theorem`, `loops`, `atoms`, `cells` — completely absent
- `python` — 18 title matches, no hub
- `area` — 404 title matches but no central skill
- `functions` — 378 title matches but fragmented into grade-specific variants

**MF2. Impact:** ~284+ fragmented addition variants means no single "addition" hub exists. Prereq chains can't converge on a common foundation.
- **Fix:** synthesize 25-40 foundational skills in stage `list` (or via a new `_foundations.json` seed file). Each with a curated description. Then in stage `seed-edges`, wire variants to their foundation (e.g., all `fluently-add-within-*` skills have `addition` as prereq).
- **Expected impact:** ~500-800 new edges, collapsing fragmented K-12 variants into coherent progressions.

### Stale cache pollution (5_prereqs.tsv)

**SC1. Cache has 111,234 entries but only 66,799 valid skills.** 46,012 orphan source IDs + 22,119 dangling prereq IDs. All stale from prior pipeline runs with different skill compositions (pre-D2/D3 cleanup).

**SC2. Postproc filter at L2681 correctly drops orphan edges** (`raw.filter(([s, p]) => skill.has(s) && skill.has(p))`), so final skills.tsv is clean. The pollution is internal/wasteful, not visible.

**SC3. LLM work was wasted on the 46k stale picks** but the picks are preserved in cache — deleting the file forces re-picking under current D5 rules (tighter candidate pool). Trade-off: re-run cost vs cleaner output.
- **Fix recommendation:** delete `build/5_prereqs.tsv` and `build/5_candidates.tsv` before next full pipeline run to apply D5 + DR1 + DR2 fixes cleanly.

**SC4. 2_embeddings.bin also has 693 orphan entries** (67,492 embeddings vs 66,799 skills). Doesn't cause issues because lookup is by ID. Could be cleaned on demand but not urgent.

---

## Tests / Evaluations to add (Quality passes 8-16)

Codify every finding above as a regression test or evaluation metric in `pipeline_test.ts` or a new `pipeline_eval.ts`. Tests marked [regression] must turn red if the issue reappears; [eval] tracks trends over runs.

### Stage 1 (list) regression tests
- [regression] No slug ends in `-[a-f0-9]{6}$` with id.length ≥ 70 (D2 overflow hash).
- [regression] No title matches `^(Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]*` (EC1 metadata prefix).
- [regression] No title matches `^(Can|Could|Should|How to|What is|Why does)\s+` (EC2 student-directive).
- [regression] No title matches `^With\s+(prompting|guidance)\s+and\s+support` (R5 scaffolding).
- [regression] No `code:*` tag shorter than 4 chars (TG2 single-letter pollution).
- [regression] No ESCO/Lightcast occupation slug ends in `-[a-f0-9]{6}$` (O1 overflow).
- [eval] OpenSALT skills without `grade:*` tag ≤5% of OpenSALT total (currently 23%).
- [eval] Lightcast placeholder-desc rate `desc == "Specialized Skill"` ≤1% (currently ~1%).

### Stage 2 (embed) regression tests
- [regression] No more than 5 skills share the same 3-float embedding signature (CR1 duplicate-embedding bug). Guards against pathological inputs.
- [regression] 0 skills have embedding magnitude < 1.0 (zero-vector catch).
- [regression] `build/2_ids.tsv` length matches `build/3b_tagged_deduped.tsv` row count (consistency).

### Stage 3 (tag + dedupe) regression tests
- [regression] No topic slug matches `/^(years|decades|centuries)-in-|-officials-and-employees$|-by-country$|-by-nationality$|-templates$|^wikiproject-|-matches$|-aircraft$|-records$/` (T2, T3 wiki-cat junk).
- [regression] No topic has frequency > 5% of total skills (T1 framework name pollution cap).
- [regression] Per-occupation frequency cap ≤800 (O2 skill sponges).
- [regression] Khan-sourced skills with no O\*NET/ESCO cross-source have 0 occupations (K1).
- [eval] Cross-source merge rate (multi-source/total) ≥2% (SRC1 benchmark).
- [eval] LCSH backfill: no skill gets a topic matching `wikiCatRe|frameworkRe|yearRe` (M4 backfill leakage).

### Stage 4 (difficulty) regression tests
- [regression] Every band in [1,20] integer (C2 NaN guard, already present).
- [regression] Bottom-50 raw scores: ≤30% share the same raw value (S4-1 plateau cap).
- [regression] Top-50 raw scores: ≤30% at the ceiling (S4-2).
- [regression] K-12 health concepts (`puberty`, `reproduction-and-heredity`, `syphilis`) have band ≤13 (S4-3).
- [regression] Grade-vs-band inversion rate >5 gap: <3% of grade-anchored skills (D4 already flagging 5.07% — gate passing threshold).
- [eval] Per-source mean band: OpenSALT ≤12, Lightcast ≈15, ESCO ≈16, O*NET ≈16 (CR3 distribution).

### Stage 5 (prereq) regression tests
- [regression] Reversed-difficulty rate in `5_prereqs.tsv` <8% (DR1 target, currently 23%).
- [regression] Same-difficulty rate <20% (currently 40.7% — tighten MIN_DIFF_DELTA).
- [regression] Seed-edge reversal rate <10% (DR2 target, currently 25.9%).
- [regression] `candidates.size === skills.length` (SC1 stale cache detector — fail if mismatch).
- [eval] None-response rate ≤10% (NR1 — currently 9.3%).
- [eval] Median picks per skill 3-6 (currently 4.4).

### Stage 6 (postproc) regression tests
- [regression] Top-20 in-degree hubs: no id matches `/retell-stories-related-to.*-day|sced-|language-immersion-prior|understand-object-naming-and-naming-conventions/` unless count ≤200 (H4).
- [regression] Per-topic cap correctness: no single (prereq, topic) pair exceeds `PER_TOPIC_CAP` (C5).
- [regression] DAG: `cycles.dag == true`, `leftover_after_kahn == 0` (already present).
- [regression] `build/1e_unresolved.tsv` exists and has >0 rows after any seed-edges run (C3).

### Stage 7 (finalize) regression tests / graph invariants
- [regression] No self-loops in prereq column (already present).
- [regression] Every prereq id resolves in skills.tsv (already present).
- [regression] Difficulty ∈ [1,20] integer (already present, extend to 99% check).
- [regression] Orphan rate <20% (S6 pipeline_test.ts already failing at 38%).
- [regression] Root count <20% of total (already present — failing at 38%).
- [regression] Obvious false positives absent (already added in M19):
  - `describe-consequences-of-following-rules` doesn't have `antisocial-personality-disorder` as prereq
  - `distinguish-lumber-categories` doesn't have `pack-fragile-items-for-transportation` as prereq
- [regression] Language-family separation: `french-*` skills don't have `german-*` as prereq (R6).
- [regression] SCED phantom-hub cap: `leadership`, `asl-immersion-*`, `ai-language-immersion-*` each have in-degree ≤200 (R1).
- [regression] No compliance-fragment slug (>70 chars + hex suffix) in ids (D2).

### LLM enrichment regression tests (1b, 1c, 1d)
- [regression] Infill outputs <220 chars (ENR2 truncation detector — output shouldn't be cut mid-word).
- [regression] Infill outputs don't start with "A " + generic noun pattern (ENR1 tone drift).
- [regression] 1d_onet_desc outputs <150 chars; no "This task involves" prefix (ENR3 template reuse).
- [regression] 1c_summarize outputs are shorter than inputs.
- [eval] Hallucination rate on sampled 1b rows ≤5% (E2 — quarterly Sonnet audit of 50-sample).

### Coverage / foundation evals
- [eval] Synthesized foundations present as ids: `addition`, `subtraction`, `multiplication`, `division`, `fractions`, `reading`, `python`, `loops`, `area`, `perimeter`, `pythagorean-theorem`, `cells`, `atoms`.
- [eval] `addition` is a transitive prereq of `multiplication` (soft warning already present; flip to assert).
- [eval] `arithmetic` has in-degree ≥ 50 in final graph (foundation connectivity).
- [eval] Khan seed-edge resolution rate ≥50% after crosswalk fix (K2 — currently 43%).
- [eval] Per-source orphan rate ≤30% (OS4 NC-CTE target, currently 28%).

### Framework / corpus evals
- [eval] No duplicate OpenSALT frameworks (`pcg-georgia-...-2` sibling of `...` (OS1).
- [eval] Frameworks with ≥95% orphans get dropped at stage list (OS3 `florida-math-scope-and-sequence`).
- [eval] Every skill in skills.tsv has at least one of {description, topics≥2, occupations≥1} (D3 cruft).

### Operational / test infra
- Add a `pipeline_eval.ts` runner that takes `build/` as read-only input, writes `build/eval.json` with all [eval] metrics. Track per-run deltas in a local history file (`build/eval_history.tsv`).
- Tag tests with `// REG-<section>-<id>` comments (e.g. `// REG-DR-1`) so failures are greppable to the audit pass that discovered the issue.
- Gate `git commit` on `deno test -A` passing (`.git/hooks/pre-commit`).

---

**Priority order for next code pass:**
1. **R1** (SCED phantom hubs) — tag-based exclusion, ~1,500-2,000 edges, easy win.
2. **R2** (grade-gap filter) — needs `grade_start` plumbing into stage `prereq`, ~800-1,500 edges.
3. **R3** (within-topic shared-token guard) — ~300 edges, small code change.
4. **R6** (language family mutual exclusion) — lookup table, ~50-80 edges.
5. **R5/R7** (scaffolding + acronym title drops at stage list) — upstream, prevents noise reaching prereq.
6. **R4/R8** (study-skill and vendor-product denylists) — small but high-confidence.
7. **R9/R10** (expand ancestor pool for advanced/specialized skills) — addresses over-strict "none".
8. **R11** (tighter OpenSALT summarization) — upstream cleanup.
