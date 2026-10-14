# Supabase backend

Receives evaluation runs that users choose to share from the app. Nothing is sent
automatically, and the offline build has no network access at all.

## How a shared run is protected

| Threat | What stops it |
| --- | --- |
| A script (`curl`) or an emulator posting fake runs | Each run is signed with a key made in the phone's secure hardware. Android: a Keystore key whose attestation chain must end at Google's root, be unrevoked, and name `team.sopa.aoair` signed with BOAR's release key. iOS: an App Attest key vouched for by Apple. Software-backed keys and debug builds are refused. |
| Replaying or editing a signed request | The signature covers a one-time server challenge (5 minutes) and the exact payload. |
| Flooding | Per device: 3 runs in 24 hours, at least 1 hour apart. Per network: 6 a day. In total: 300 an hour. Checked in one transaction under a lock per device. |
| Deleting or changing stored runs | `eval_runs`, `eval_rows`, `eval_scores` and `eval_devices` are append-only for every role but the owner, the secret key included (triggers and grants). |
| Believable but impossible numbers | Rows must answer the eval set's own questions, once each. Impossible timings or memory keep the run's scores hidden for review. |
| Oversized or junk runs, or markup in the public scores | A run holds at most 204 rows (12 models) in 1.5 MB. Each row is rebuilt from a fixed list of checked fields (answers cut at 4,000 characters). Phone, chip and model labels only take letters, digits and a few separators; anything else is stored as empty. |
| Reading private data | RLS on every table. The publishable key reads only `eval_scores` rows that aren't hidden. |

What it doesn't stop: someone with a real phone and the real app sharing real runs, or a
phone whose secure hardware has been broken (revoked keys are refused). A device is a key, so
clearing the app's data makes a new one; the per-network limit still applies.

- `migrations/`: the tables, `submit_eval_run()` (limits, storing, scoring) and the append-only
  rules.
- `functions/submit-results/`: the challenge, the attestation and signature checks
  (`attest.ts`) and the payload checks (`payload.ts`). Tests: `deno test --no-config
  --node-modules-dir=none supabase/functions/submit-results/`.

## Moderating

As the owner (the dashboard's SQL editor):

- **The review list:** `select * from eval_review_queue` shows every run whose scores are hidden,
  with its flags (`unattested`, `implausible_timing`, `rss_above_ram`), the phone and its scores.
- **Approve a run** (put it on the public scores): `update eval_scores set hidden = false where run = '<id>'`.
- **Hide a run:** `update eval_scores set hidden = true where run = '<id>'`.
- **Block a device's future runs:** `update eval_devices set banned = true where id = '<id>'`.
- **Give a test phone more runs:** `update eval_devices set daily_limit = 20 where id = '<id>'` (1 to 100 a day, no hour between runs, no network cap; `null` puts it back on the normal limits).

### Phones that can't attest

Some genuine phones can't attest a key: their secure hardware lacks, or lost, its factory
attestation keys (seen on a stock, locked POCO F3 as Keymaster error -10003). The app then makes
a plain key and sends only its public key. The server registers it as unattested and still
checks every signature, but nothing proves the key is in a real phone running BOAR, so each of its
runs is flagged `unattested` and waits in the review list. A script can make such keys too, so
there's room for at most 100 unattested runs a day in total, on top of the usual limits.

## The public copy on Hugging Face (optional, off)

Off until `HF_DATASET` is set. Before turning it on, add the Hugging Face dataset to `PRIVACY.md`
(sections 2.3, 5 and 6) and `TERMS.md` (sections 4 and 6).

`.github/workflows/mirror-scores.yml` runs `scripts/mirror-scores-hf.mjs` once a day. It reads the
public scores with the publishable key, so it only ever sees approved `eval_scores` rows, and
commits `scores.csv`, `scores.jsonl` and a dataset card to the Hugging Face dataset named by the
`HF_DATASET` repository variable (CC BY 4.0). Nothing is committed on a day with no change.

Setup, once: create the dataset on Hugging Face, make a fine-grained token with write access to
it only, then in the GitHub repository set the `HF_TOKEN` secret and the `HF_DATASET`,
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` variables. The job does nothing until `HF_DATASET` is
set. Try it locally with `npm run scores:mirror -- --dry-run` (writes the files to
`build/hf-mirror/`).

## Deletion requests

A person asks by email with the run's id (the app shows it in the Evaluation screen's "Saved to"
line, `eval-<date and time>`), the phone's model and roughly when they shared it. As the owner, find
the run, then delete it and everything else from that phone:

```sql
select id, device, received_at, device_model from eval_runs
where run_id = '<run id>' and device_model = '<phone model>';

begin;
delete from eval_runs where device = '<device from above>';   -- cascades to eval_rows and eval_scores
delete from eval_devices where id = '<device from above>';
commit;
```

If the Hugging Face copy is on, the next daily copy drops those rows from the dataset, but its git history still
has them. Remove them from the history too: after the copy, squash the dataset's history on
the dataset's Settings page, or with
`curl -X POST -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/datasets/$HF_DATASET/super-squash/main`.

## Using your own project

```bash
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy submit-results --no-verify-jwt
```

Then copy `.env.example` to `.env` and set your project's URL and publishable key. Set
`RELEASE_CERT` in `functions/submit-results/index.ts` to your release certificate's SHA-256
(`keytool -list -v -keystore <keystore>`), and for iOS set the function's `APPLE_APP_ID`
secret to `<Team ID>.<bundle id>`.
