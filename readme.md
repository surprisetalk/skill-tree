# skill-tree

Aggregates open datasets into a unified skill prerequisite graph.

## Setup

```sh
git config core.hooksPath .githooks  # pre-commit runs audit + check + test
```

## Run

```sh
deno run -A pipeline.ts            # all stages, then status
deno run -A pipeline.ts seed-edges # one stage
deno task check                    # fmt, lint, typecheck
deno task test                     # runs stage list for real, in seconds
deno task status                   # grades the last full build; exits 1 on a failing condition
```

Stages, in order: `list` → `enrich` → `trees` → `embed` → `tag` → `dedupe` →
`seed-edges` → `difficulty` → `prereq` → `postproc` → `finalize` → `status`.
`pipeline.ts` dispatches them; `sources.ts`, `graph.ts`, and `prereq.ts` hold
them; `lib.ts` holds what they share.

Final output: `skills.tsv`
(`id title display_title description difficulty prereqs occupations topics grade_start grade_end`).
Per-stage caches live in `build/`.

Requires a local Ollama at `localhost:11434` with `nomic-embed-text`
(embeddings), and `ANTHROPIC_API_KEY` for stages `enrich` and `prereq`, which
generate text with Claude Haiku 5.5 through the Batches API. `SKIP_LLM=1` makes
stage `prereq` reuse `build/5_prereqs.tsv` as is.

See `claude.md` for the full dataset catalog and schemas.

## Pending design

Evidence for each note: `research.md`.

- The prereq DAG stays the source of truth. Embeddings serve only candidate
  retrieval, dedupe, and interest ranking. Alternative: learned box or order
  embeddings that encode the partial order. They need training labels, lose hand
  edits, and cannot explain a path to a goal.
- `skills.tsv` keeps one edge type, prereq, and topics keep the hierarchy.
  Sponge derives implicit-review credit from prereq edges with one fixed weight.
  Alternative: an LLM-scored "encompasses" weight (0–1) per edge, as Math
  Academy sets by hand. It costs one more LLM pass and one more column before
  learner data shows that the fixed weight fails.
- `skills.tsv` gets a `sources` column, and `lib.ts` maps each source to its
  licence and attribution string. The readme lists the attributions.
  Alternative: drop every non-commercial or copyleft source (Junyi, MOOCCubeX
  GPL-3.0). That loses the MOOCCubeX CS and math seed pairs.
- Git tracks a filtered extract of Learning Commons
  (`data/learningcommons/graph.jsonl.gz`, CC BY 4.0), and `data/download.ts`
  streams the 986 MB export to build it. The extract keeps the rows of current
  frameworks, every `attributionStatement` once, and the edges that stages
  `dedupe` and `seed-edges` read. Alternative: keep the raw jsonl, gitignored.
  Then `deno task test` fails on a fresh clone until a 986 MB download ends.
- Stage `list` writes `build/1m_lc_ids.tsv` (node id to skill id), so that
  `buildsTowards` and `hasStandardAlignment` edges resolve exactly. Alternative:
  an `lc:<id>` tag per node. It needs no file, but the tag cap of 20 loses most
  nodes of a statement that fifty states repeat.
- Stages `prereq` and `difficulty` stay. A top-down LLM tree does not replace
  them yet. Example from the pilot (`deno run -A pipeline.ts pilot`, report in
  `build/pilot_stats.json`): Electricians → National Electrical Codes → … →
  Professional Communication → Instructional Design → … → Applied Behavior
  Analysis. From 20 roots the pilot reached 5,953 nodes; 47% matched no skill,
  3,019 edges closed a cycle, chains ran 100 to 380 steps, and 22% of edges
  between banded skills climbed a band. The tree drifts sideways through lateral
  prereqs and wrong snaps ("checking responsiveness" in CPR became
  `viewport-meta-tag`). On the 50 expert positives it reached, its closure
  recalls 42% against 12% for `skills.tsv`, but it also holds 17% of the
  negatives against 1%. Alternative: switch now. It needs a guard that each
  prereq is easier than its skill, and a stricter snap, before the tree
  converges.
