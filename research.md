# research

A survey of open sources and prior work for skill-tree and sponge. Two workflows
made it. The first swept 9 lanes and found 247 leads. The second checked the
best leads at the primary source: it downloaded files, counted rows, and quoted
licences. Counts below are from that check unless marked "stated", which means
the publisher's count. `todo.md` holds the work.

## Verdict

- The largest new source is the Learning Commons Knowledge Graph. It holds
  standards for all 50 US states and DC in 4 subjects, plus 10,731 learning
  components. It is CC BY 4.0, and it downloads without an account. It can make
  most of the planned CSP crawl unnecessary.
- Open expert prerequisite edges are rare. Every open set holds a few hundred to
  a few thousand positive pairs. The LLM prereq stage stays the main edge
  source. The expert sets become seeds and a held-out test.
- The literature supports the current shape: cheap signals give candidate
  recall, and an LLM judge gives precision. GPT-4 zero-shot reached F1 0.78
  against expert labels on LectureBankCD. Human agreement tops out at about κ
  0.64–0.86.
- Graph versus space: keep the DAG as the source of truth. Use the embedding
  space for candidate retrieval, dedupe, and interest. A cosine score is
  symmetric, so it cannot hold "A comes before B". Sponge needs graph queries
  for a goal: closure, outer fringe, and "what blocks this goal".
- Learner modeling for sponge: Knowledge Space Theory, Math Academy, and FSRS
  give a small and proven design. See [Sponge](#sponge).

## Ingest

| Source                                                                                       | Holds                                                                                                            | Counts                                                                                                                         | Ordering                                                                                                                                                                                         | Licence                                                                                                                        | Access                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Learning Commons KG](https://github.com/learning-commons-org/knowledge-graph) v1.16.0       | US state standards (math, ELA, science, social studies), learning components, IM curriculum, Eedi misconceptions | 311,901 nodes: 274,314 standard items, 10,731 learning components (6,596 math, 4,135 ELA), 8,117 misconceptions. 547,541 edges | `buildsTowards` 757 (Coherence Map, CCSS math), `hasChild` hierarchy, `hasStandardAlignment` 28,273 (state → CCSS crosswalk), `supports` 154,131 (component → standard), `properties.gradeLevel` | CC BY 4.0 on every row, with a row-level `attributionStatement`. The docs say the Coherence Map is CC0, but its rows say CC BY | `curl -LO https://cdn.learningcommons.org/knowledge-graph/v1.16.0/exports/{nodes,relationships}.jsonl` (363 MB + 623 MB). The version is in the path |
| [DigComp 3.0](https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/DIGCOMP/DIGCOMP3.0/)          | EU digital competences                                                                                           | 5 areas, 21 competences, 362 statements, 523 learning outcomes                                                                 | 8 proficiency levels, tagged per statement at 4-level grain (`four_levels_proficiency_name`)                                                                                                     | CC BY 4.0 (`copyright.txt`)                                                                                                    | One JSON-LD file, 452 KB. A DigComp 2.2 → ESCO mapping sits beside it                                                                                |
| [Course prerequisite corpus](https://data.mendeley.com/datasets/fs2hvkps7z) (Mendeley, 2026) | Catalogs of 13 universities (AUB, Caltech, Gulf)                                                                 | 39,709 course → course edges, 51,858 course records (stated)                                                                   | `source_prereq,target_course,group_index,is_alternative,timing,min_grade`: AND/OR in CNF                                                                                                         | CC BY 4.0 (`LICENSE.txt`)                                                                                                      | `prereq_edges.csv` 3.3 MB, `courses.csv` 34 MB, no key                                                                                               |
| [Cert Atlas](https://github.com/hans6883/cert-atlas)                                         | Exam blueprints: CompTIA, AWS, Cisco, Microsoft, NCEES, PMI, CAS, and others                                     | 1,965 exams from 358 vendors (`data/index.json`)                                                                               | Domains with `weight_percent`. `prerequisites[]` as free-text cert names                                                                                                                         | MIT for the compilation. Each vendor keeps copyright on its exam guide                                                         | Raw JSON per exam on GitHub                                                                                                                          |
| [BNCC](https://github.com/bncc-dev/bncc-dados) (Brazil)                                      | National curriculum, early childhood to high school                                                              | 1,721 outcomes (stated)                                                                                                        | The code holds grade and subject, e.g. `EF67LP08`. Early-childhood age bands                                                                                                                     | Data CC BY 4.0, code MIT (README)                                                                                              | JSON, SQLite, CSV, and a keyless REST API. Labels are Portuguese                                                                                     |

## Eval only

These sets measure the prereq and difficulty stages. Their licences or
provenance keep their rows out of a build.

| Source                                                                       | Use                                                                                                     | Counts                                                                                                                 | Licence                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [LectureBank, LB2, LectureBankCD](https://github.com/Yale-LILY/LectureBank)  | Precision and recall of LLM prereq edges                                                                | 2,555 positive expert pairs in 4 topic sets (NLP/ML 208 + 322, CV 199, BIO 99 topics)                                  | None stated. Do not redistribute                                            |
| [Junyi Academy](https://pslcdatashop.web.cmu.edu/DatasetInfo?datasetId=1198) | Prereq edges against crowd labels. Difficulty bands against 26M real attempts                           | 837 exercises, 1,131 annotated pairs (`Prerequisite_avg`, `Similarity_avg`, `Difficulty_avg`), 25.9M log rows (stated) | Non-commercial. Needs a DataShop login                                      |
| Learning Commons `buildsTowards`                                             | Hold out a slice as a test of the LLM stage on K-12 math                                                | 757 edges                                                                                                              | CC BY 4.0                                                                   |
| [Lichess puzzles](https://database.lichess.org/)                             | A model of empirical difficulty: Glicko `Rating` and `RatingDeviation` per item, fit from real attempts | 6,157,341 puzzles (stated), 307 MB zst                                                                                 | CC0                                                                         |
| [Wordbank](https://langcog.github.io/wordbank-datapage/data.html)            | Word-by-age norms for a kids' vocabulary deck                                                           | unknown                                                                                                                | Mostly CC BY. Some datasets are CC BY-NC, so filter on the `license` column |
| [CEFR-J](https://github.com/openlanguageprofiles/olp-en-cefrj)               | Language level anchors                                                                                  | 7,799 words A1–B2, 170 levelled grammar items (of 500 rows)                                                            | Free for commercial use with citation. The Octanove C1/C2 file is CC BY-SA  |
| [HSK 3.0](https://github.com/ivankra/hsk30)                                  | Chinese level anchors                                                                                   | 11,092 words, 3,000 characters, 624 grammar rows. Levels 1–6, 7–9                                                      | MIT over a PRC government source of unclear status                          |

## Blocked on a key or request

| Source                                                                                                     | Why it matters                                                                                                                                                             | Blocker                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Oak National Academy](https://open-api.thenational.academy/)                                              | England KS1–KS4, 17 subjects. Units in `sequence` order, ordered `threads`, free-text `priorKnowledgeRequirements`, `misconceptionsAndCommonMistakes`, `keyLearningPoints` | Free API key through a HubSpot form. OGL v3, except where a lesson says otherwise (`restricted` flag)                                  |
| [Skills England occupational maps](https://occupational-maps.skillsengland.education.gov.uk/public-api/)   | Apprenticeship standards with knowledge/skill/behaviour lists per duty, `level` 2–7, progression edges `stdCodeFrom → stdCodeTo`                                           | Free key at Skills England's discretion. OGL, and every derived product must carry the Skills England logo and attribution             |
| Junyi Academy                                                                                              | See [Eval only](#eval-only)                                                                                                                                                | DataShop login                                                                                                                         |
| [Australian Curriculum v9](https://www.australiancurriculum.edu.au/machine-readable-australian-curriculum) | F–10 in JSON-LD and RDF, CC BY 4.0                                                                                                                                         | Scootle hosts return 403 to scripts, so a browser download is the only route. The National Literacy Learning Progressions are CC BY-NC |
| [UT Austin Open Ed Graph](https://mapping.oden.utexas.edu/projects/open-ed-graph)                          | Expert `has-prerequisite-of` edges between high-school math micro-outcomes. Also College Algebra, Accounting, STEM                                                         | Email request. CC BY                                                                                                                   |
| [Credential Engine Registry](https://credentialengineregistry.org/)                                        | 396,681 envelopes. CTDL-ASN frameworks                                                                                                                                     | Reads by CTID work without a key. The licence for bulk use is a Developer Agreement, and paid tiers start at $15k/yr (stated)          |

## Rejected

| Source                                                                    | Reason                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ESCO-PrereqSkill                                                          | Inverse `isEssentialSkillFor` from ESCO, which skill-tree already ingests. Its edges are skill → knowledge topic, not learning order. No licence |
| SkillDAG (HF)                                                             | LLM-agent tool skills, with LLM-written edges                                                                                                    |
| MathlibGraph, Metamath, Stacks Project                                    | Formal proof dependencies, not learning order                                                                                                    |
| Wikidata P4967 "prerequisite"                                             | 466 statements, mostly noise ("posthumous edition" → "death")                                                                                    |
| O\*NET CTDL-ASN frameworks                                                | Same content as O\*NET, which skill-tree already ingests. Hierarchy only                                                                         |
| NICE Framework v2.2                                                       | Role → knowledge membership, no order. No licence statement                                                                                      |
| SFIA 9                                                                    | Licence forbids product use without a paid licence                                                                                               |
| XES3G5M                                                                   | A KC tree with no prereq edges. Chinese. Data licence unread (Google Drive)                                                                      |
| OpenStax                                                                  | Table of contents only. The calculus bundle is CC BY-NC-SA                                                                                       |
| Khan Academy API                                                          | `/api/v1/topictree` returns 410                                                                                                                  |
| LinkedIn, Coursera, Workday, ALEKS, IXL, Math Academy graphs              | Closed. Their designs are public, their data is not                                                                                              |
| Kuperman AoA                                                              | The primary download is dead. The only copy is a 2,614-word CC BY-NC subset                                                                      |
| CEFR descriptors, Jump$tart, Lexile, EFCamDat, English Vocabulary Profile | Non-commercial, permission-only, or proprietary                                                                                                  |
| training.gov.au                                                           | The SOAP service needs an account. The data licence is unread                                                                                    |

## Design lessons

### Edge types

Keep each relation in its own column. Do not put all of them into "prereqs".

- **Prerequisite**: "learn A before B". The strict DAG. Only these edges enter a
  goal closure.
- **Broader**: hierarchy (`hasChild`, ESCO broader, XES3G5M KC routes). A
  broader edge in the closure pulls in a whole subtree. The XES3G5M paper and
  SkillDAG both name this mixing as a source of wrong closures.
- **Similar**: symmetric. It is useful when a learner stalls (KnowLP) and for
  interest-based selection. The embeddings already give it, so it needs no
  stored column.
- **Encompasses** (Math Academy): a weight from 0 to 1. It says what share of
  practice on B also practices A. It moves review credit, not order. Math
  Academy sets these weights by hand, only on direct and key prereq edges. Its
  book publishes the rules but no formula.

Junyi labels prerequisite, similarity, and difficulty as three separate scores
per pair. The Coherence Map splits `buildsTowards` (directional) from
`relatesTo` (symmetric). Only directional edges enter the DAG.

### Graph versus space

- A cosine score is symmetric, and a prerequisite relation is not. Order
  embeddings, box embeddings, and hyperbolic cones can encode a partial order.
  They need training labels, they lose hand edits, and they cannot explain a
  path. Use them only to predict edges for new nodes
  ([Vendrov 2016](https://arxiv.org/abs/1511.06361),
  [shadow cones](https://arxiv.org/pdf/2305.15215)). Poincaré embeddings fit
  trees, but skill graphs have many parents.
- Knowledge Space Theory: a prerequisite DAG defines a quasi-ordinal knowledge
  space. A learner state is a downset, the set of mastered skills. The outer
  fringe holds the skills not yet mastered whose prereqs are all mastered. ALEKS
  teaches from the outer fringe and reports about 93% success there
  ([Falmagne et al.](https://arxiv.org/pdf/1511.06757)).
- A learner vector can share the embedding space for interest ranking. Deep IRT
  shows that a latent learner vector is equivalent to multidimensional IRT.

### Building the prereq graph

- Signals from the literature, ranked: RefD link asymmetry is cheap but needs a
  link graph. Textbook and course order works where ordered text exists.
  Embedding scores give high recall at low precision (ACE: recall 1.00,
  precision 0.46 on UCD). LLM judges give the best precision (GPT-4o-mini RAG:
  precision 0.87, F1 0.72)
  ([ACE, JEDM](https://jedm.educationaldatamining.org/index.php/JEDM/article/download/737/218),
  [CGLLM](https://arxiv.org/pdf/2402.14293)).
- Extract per section, merge globally, then detect cycles (K12-KGraph). This
  matches the current embed → tag → dedupe → prereq → cycle-break order.
- Run a transitive reduction on the final graph. The Mathlib import DAG loses
  17.5% of its edges to it. A goal closure is computed, not stored.
- Active learning for strict partial orders gets labels by deduction: a positive
  label implies transitive positives, and a negative label implies negatives
  ([Liang 2018](https://arxiv.org/pdf/1801.06481)). A review tool shows pairs in
  rank order and skips the implied ones.
- Store a source and a confidence on each edge. Sponge can then weight an expert
  seed above an LLM pick, and learner logs can re-weight edges later (PSI-KT
  learns a shared graph from all learners' answers).
- Without full ground truth, evaluate on learner outcomes. ACE ranks pairs into
  deciles and checks that learners who know A do better on B than a matched
  control (R 0.88 in the top decile, 0.64 in the bottom).
- Report edge precision and recall. Do not report set similarity: in the
  ESCO-PrereqSkill paper, BERTScore hid per-edge errors.

### Taxonomy merges

- Match in stages: authoritative crosswalks first (ESCO–O\*NET, ISCO–SOC,
  Learning Commons `hasStandardAlignment`), then embedding top-k, then an LLM
  judge. Unmatched nodes stay separate
  ([Snijder 2024](https://ojs.aaai.org/index.php/AAAI-SS/article/view/31208)).
- Learning Commons scores state → CCSS matches by the Jaccard overlap of shared
  learning components. Stage `dedupe` can use the same signal.
- Keep the source URI on every node. CASE, CTDL-ASN, Open Badges 3.0, and RSD
  all name a competency by a persistent URI, so a kept URI makes export free.

### Difficulty anchors beyond K-12

Ready level scales: DigComp (8), EQF (8), SFIA (7, closed), ACGME Milestones
(5), Skills England (2–7), CEFR (A1–C2), HSK (1–9), JLPT (N5–N1, unofficial). An
empirical scale beats an expert scale where one exists: Lichess ratings,
Wordbank age norms, Junyi attempt logs, NAEP percent-correct by grade. Note: the
CDC 2022 milestones use the 75th percentile, and older checklists use the 50th,
so two age-normed sources can disagree for a false reason.

### Licences

Sources differ per row. The Learning Commons docs say that a combined build must
keep each source's attribution and must not apply one licence to all of it.
Blockers for commercial use: Junyi (NC), EdNet (CC BY-NC), Australian literacy
progressions (CC BY-NC), OpenStax calculus (BY-NC-SA), MOOCCubeX (GPL-3.0,
already ingested), SFIA. Skills England requires its logo on any derived
product.

## Sponge

The mechanisms below need only `skills.tsv` and one answer log.

1. **Goal → frontier.** Take the transitive prereq closure of the goal skills,
   remove the mastered skills, and teach from the outer fringe in band order.
   This is Math Academy's layering rule and ALEKS's outer fringe.
2. **Two layers of state.** `card_state(learner, card, D, S, last_review)`
   answers "when to review". `skill_mastery(learner, skill, score, speed)`
   answers "what next". Math Academy joins them through the graph.
3. **Memory model: FSRS-6.** It has 21 default weights and about 40 lines of
   arithmetic: R(t,S) = (1 + f·t/S)^(−w20), with f = 0.9^(−1/w20) − 1, so that
   R(S,S) = 0.9
   ([The Algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)).
   ts-fsrs and py-fsrs are MIT, and fsrs-rs is BSD-3. No Elm port was found, so
   a hand port is the cheap route. FSRS-7 (34 weights, a fast and a slow trace)
   exists in code but is undocumented, and ts-fsrs v6 is in beta.
4. **Mastery model: Elo per skill.** Use one step per answer, with the
   difficulty band as the item prior. Duolingo's Birdbrain uses this shape, and
   Elo performs about as well as logistic regression. In pyKT, AKT beats the
   much simpler simpleKT by only about 0.5%, and a small user base cannot feed a
   deep model. BKT with prereq-propagated priors beats deep models when data is
   sparse (LearnOpt).
5. **Credit through the graph (FIRe).** A pass on B gives implicit credit to the
   skills B encompasses, multiplied along the edge weights, and the credit fades
   along partial edges. A fail on A penalizes the skills that encompass A. An
   early rep is discounted. If a learner's speed on a skill is below 1, implicit
   credit stops for that skill and it gets explicit reviews. The book gives no
   constants, so sponge must choose its own.
6. **Placement diagnostic.** A correct answer credits the skill's prereqs. A
   wrong answer debits its postreqs. Before the diagnostic, compress the graph:
   a skill counts as covered when it has an ancestor and a descendant within 3
   edges. Math Academy places learners with 20–60 questions out of 500+ topics.
7. **Target accuracy.** Pick items near 50% for diagnosis and near 80–85% for
   practice.
8. **Stalls.** After two failures on the same point, review the key prereqs. If
   no prereq path moves, offer a similar skill.
9. **Interest.** No source models interest as a first-class sequencing signal,
   and no open dataset joins interests to answer history. Weight the fringe
   ranking by goal and interest, with the `topics` and `occupations` columns as
   the vocabulary. Sponge must collect this data itself.
10. **Log from day one:** learner, card, skill ids, timestamp, a 1–4 grade,
    response time, and elapsed time since the last review. Math Academy
    discounts slow correct answers.
11. **Gaps in Anki and Knewton.** Anki has no card dependencies, and its users
    suspend cards by hand. Knewton failed partly because its engine was opaque.
    So show the path to the goal.
12. **Benchmark.** srs-benchmark uses a time-split protocol. Keep a trivial
    baseline in the suite: on same-day reviews, an AVG baseline beats some FSRS
    versions.

## Open gaps

- No machine-readable curriculum was found for Ontario, Singapore, New Zealand,
  IB, China, Japan, Germany, or Scotland. ePerusteet (Finland, 927 curricula,
  keyless API) has no stated licence.
- No open phonics scope and sequence, and no Dolch/Fry list with a clear
  licence. No structured CDC milestone feed: the checklists exist only as HTML
  and PDF.
- The ACM survey "Prerequisite Relation Learning: A Survey and Outlook" (doi
  10.1145/3733593) has a dataset table that this survey did not read.
- Leads that were found but not checked: SciConPreq (303 concepts), MOOCRadar
  (5,600 concepts, flat), Eedi NeurIPS 2020 (CC BY-NC-ND), PSI-KT code
  (AGPL-3.0), and catalog scrapers for UCI, Stanford, and CMU.
