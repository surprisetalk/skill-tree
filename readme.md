# skill-tree

Aggregates open datasets into a unified skill prerequisite graph.

## Run

```sh
deno run -A pipeline.ts           # all stages
deno run -A pipeline.ts seed-edges # one stage
deno test -A pipeline_test.ts
```

Stages (run in order, all cached resumable):
`list` → `enrich` → `trees` → `seed-edges` → `embed` → `tag` → `dedupe` → `difficulty` → `prereq` → `postproc` → `finalize`

Final output: `skills.tsv` (`id title display_title description difficulty prereqs occupations topics grade_start grade_end`).
Intermediate per-stage caches in `build/`; stats in `build/N_stats.json`.

Requires a local Ollama with `nomic-embed-text` (embeddings) and `gpt-oss:20b` (default generator). Override via env:

- `OLLAMA_HOST`, `OLLAMA_GEN_MODEL`, `OLLAMA_CONCURRENCY`, `EMBED_CONCURRENCY`
- `SKIP_LLM=1`, `SKILL_LIMIT=N`
- Stage knobs: `PREREQ_K`, `PREREQ_PICK_CAP`, `KNN_K`, `DEDUPE_COSINE`, `PER_TOPIC_CAP`, `HUB_CAP`, `SEED_FALLBACK_COS`, `SMOOTH_W`

See `CLAUDE.md` for the full dataset catalog and schemas.
