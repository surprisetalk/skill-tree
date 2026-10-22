# skill-tree

Aggregates open datasets into a unified skill prerequisite graph.

## Setup

```sh
git config core.hooksPath .githooks  # pre-commit runs check + test
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
(embeddings) and `gpt-oss:20b` (generation). `SKIP_LLM=1` makes stage `prereq`
reuse `build/5_prereqs.tsv` as is.

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
