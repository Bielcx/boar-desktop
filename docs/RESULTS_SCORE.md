# Shared results and the score

People can share an evaluation run from the app (Evaluation › Share results) so others with
the same chipset, CPU or memory can see which models work best on phones like theirs. This
page explains what is sent, what is public and how the score is computed.

## What is sent

Only after the user reads the "What will be shared" screen and presses Share:

- **Phone:** brand and model, chipset (`Build.SOC_MODEL`, Android 12+, or `Build.HARDWARE`),
  number of cores and each core's top frequency, CPU features from `/proc/cpuinfo`
  (llama.cpp gains most from `i8mm` and `asimddp`, shown as dotprod), total RAM, Android
  version and API level.
- **App:** BOAR version and the evaluation set version.
- **Every answer of the run:** the question, the answer, the model and its timings, the
  sources retrieved.
- **A random id** created in the app the first time it shares. The server keeps only its
  SHA-256, to allow 20 runs per install per day and to refuse the same run twice.

Not sent: chats, documents, name, location, contacts. The offline build has no network
access and can't share.

## What is public

`eval_scores` (one row per model per run) can be read by anyone with the project's
publishable key, and sorted or filtered on any column, for example:

```
GET /rest/v1/eval_scores?soc=eq.MT6897&order=median_tok_per_sec.desc
```

It holds the hardware and the per-model numbers, never the install hash. The raw runs and
answers (`eval_runs`, `eval_rows`) are not readable with the publishable key. A junk entry can
be hidden (`eval_scores.hidden`) without deleting it.

## Score v1

For each model in a run, from its answers:

| Part | Weight | How it's measured |
|---|---|---|
| Speed | 60% | Median decode speed in tokens/s over completed answers of 16 tokens or more, divided by 20 tokens/s (about three times reading speed), capped at 1 |
| Reliability | 25% | Answers completed (no error, no timeout) out of all answers |
| Retrieval | 15% | Questions whose expected source was found, out of the questions that expect one |

`score = round(100 × (0.60 speed + 0.25 reliability + 0.15 retrieval))`

- When no question in the run expects a source, speed and reliability are rescaled to fill
  100% (0.60/0.85 and 0.25/0.85).
- A model that completes fewer than half its answers scores 0, however fast it is.

The score measures **speed and reliability, not whether the answers are correct**: nothing
grades answers yet. The answers are kept with every run, so a quality part can be added later
as score v2 without asking anyone to share again.

The raw numbers stay next to the score (median tokens/s, time to first token, total time,
peak RAM, completed and sources found), so people can sort by what matters to them.

## Where the formula lives

- `supabase/migrations/*_eval_scores.sql`, `compute_eval_scores`: the stored score. The server
  always computes it from the answers; a score sent by the app would be ignored.
- `src/eval/score.pure.ts`: the same formula in the app, for the preview before sending.

Change both together, bump `SCORE_VERSION` and `score_version`, and update this page.
