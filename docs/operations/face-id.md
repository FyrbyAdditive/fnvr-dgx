# Face-ID guide

This is the operator-facing how-to. For the algorithms under the hood, see [architecture/face-id.md](../architecture/face-id.md).

## Enabling face recognition

Face-ID is **off by default** for compliance reasons (GDPR / BIPA / UK Biometrics). Enable explicitly:

1. **Settings → Detector → Face-ID = on.** Pipeline restarts to attach the SCRFD + ArcFace SGIEs.
2. **Compliance acknowledgement.** Read and accept the jurisdiction-specific notice. The acknowledgement is audited; tampering with it leaves a trail.
3. Wait ~30 s for the pipeline to come back. Faces detected in live video should appear in **Faces → Recent faces**.

Disable anywhere the privacy story demands it:
- Per-camera via `cameras.enabled_detectors`. Indoor-only toggle is the typical use.
- System-wide via the Detector settings toggle.
- Full data removal via the **Delete person** button — cascades embeddings + writes an erasure audit row.

## Enrolment

Three paths, shown in order of usefulness.

### 1. Enrol from a cluster (strongly preferred)

HDBSCAN clustering runs nightly over face detections whose match similarity was below threshold — i.e. strangers the matcher doesn't yet know. Unknown-face clusters appear in **Faces → Unknown-face clusters**. Each cluster is typically 3–20 appearances of the same person across days.

- Click a cluster to see its members.
- Click **enrol** to name it. Every member's embedding is copied into `face_embeddings` under that person. One click gives you a diverse pool.
- Click **not a face** (amber) if the cluster is noise — partial faces, wall textures, reflections. Every member is written to `face_dismissals(reason='not_a_face')` so HDBSCAN's next run + the matcher's negative pool both learn to avoid it.
- Click **dismiss** (grey) to hide a cluster without training signal. Useful for "this is someone I don't want to enrol but also don't want as a negative".

### 2. Upload a photo

**Faces → Upload photo to enrol.** JPEG/PNG ≤ 5 MB. The server hands it to ml-worker's `/detect-and-embed`. Paths:

- **Single face detected → enrolled immediately.**
- **Multiple faces detected → 409 Conflict with face list.** The UI shows thumbnails; pick one and resubmit.

Works for the initial bootstrap when you have no clusters yet. Don't rely on it as your main enrolment path — upload photos are typically flattering portraits, not CCTV-angle/distance realism, and a pool built entirely of uploads will miss people in the real world.

### 3. Live-confirm a borderline match

When the matcher scores a face just under threshold, it shows on the Recent faces grid without a name. Clicking "this is tim" writes that one embedding with `source="enrol-live-<detection_id>"`. Good for incrementally teaching the matcher angles it's missing.

## The per-embedding badge

Each tile on a person's drill-down carries a small pill showing `sim: 0.42`:

- **Red (< 0.35).** This embedding has no kin anywhere in the pool. Probably wrong person or noise.
- **Amber (0.35–0.50).** Marginal. Inspect the thumbnail.
- **Green (≥ 0.50).** Coherent cluster member — legitimate pose/lighting variant.

The metric is **mean cosine to its 3 nearest neighbours** in the same pool. It is NOT "how tight is the whole pool" — diverse embeddings of the same person should score green as long as each one has a few similar siblings. If you add 5 profile-angle shots, all 5 will score green against each other even if the rest of the pool is all frontal.

Sort options:
- **Newest** (default) — created_at desc.
- **Lowest neighbour-sim** — surface outliers first.

Filter slider: show only embeddings below a kNN threshold. Useful workflow: sort by lowest, slide filter to 0.35, review thumbnails, bulk-select obvious strangers, **delete selected**.

## The matcher

Every face detection in live video is scored against every enrolment per-person:

1. Cosines of probe vs every enrolment (L2-normalised).
2. Per person: sort, take the **mean of the top 3** = `topK`.
3. Winner = person with highest topK.
4. Accept if `topK >= faces.match_threshold` AND (single person enrolled, OR winner beats runner-up by at least `faces.match_margin`).
5. Negative-penalty: if `faces.negative_penalty_weight > 0` and the probe is highly similar to a `face_dismissals(reason='not_a_face')` row, retract the match.

On a clean pool expect:
- Real you in front of the camera → topK around **0.40–0.55**. Above threshold 0.32, matches.
- A stranger → topK around **0.10–0.25**. Well below threshold, doesn't match.
- An angle the pool doesn't cover well → topK around **0.25–0.32**. Borderline; won't match until you add an enrolment from that angle.

## Tuning the matcher

### `faces.match_threshold` (default 0.40; recommended 0.32)

Lowering admits more borderline matches; raising reduces false positives. Observed on a typical low-res CCTV feed:

- 0.45 — misses most angles. Only frontal, well-lit probes match.
- 0.40 — misses some.
- 0.32 — matches most of the person's poses; very few confusion cases because ArcFace gives wildly different cosines for different people.
- < 0.30 — enters false-positive territory; a stranger at a flattering angle may occasionally hit 0.30.

```sql
UPDATE settings SET value = '0.32'::jsonb WHERE key = 'faces.match_threshold';
```

### `faces.match_margin` (default 0.05)

Only matters when more than one person is enrolled. A probe close to two people's pools requires one to beat the other by at least this much. Raise to reject ambiguity more aggressively; lower if two similar-looking family members are flipping between each other's matches.

### `faces.negative_penalty_weight` (default 1.0)

Controls how much a probe's similarity to a known `not_a_face` / `duplicate` embedding drags its score down. Problem: if your negatives pool is noisy (contains embeddings that look vaguely like you), this can tank every real-you match.

Fast reset:
```sql
UPDATE settings SET value='0'::jsonb
 WHERE key='faces.negative_penalty_weight';
DELETE FROM face_dismissals
 WHERE reason IN ('not_a_face','duplicate');
```
Re-enable gradually once you have a cleaner pool.

## Drift detection

Weekly job (ml-worker, `drift.py`) computes the mean pairwise cosine among the enrolled embeddings of every person with ≥ 2 embeddings. First run seeds a baseline. Subsequent runs compare; a ≥ 5% drop fires a drift alert that becomes a system-scope incident and flows to your notification channels.

- Surfaced on the Faces page as a **drift pill**: `drift: 0.52 (−1.2% vs baseline 0.53, 2d ago)`.
- Green when `|delta| < 2%`, amber 2–5%, red ≥ 5%.

A drift alert typically means the embedder has degraded (lens smudge, camera moved, model regressed) *or* bad enrolments slipped in since the last check. Review recent Recent faces + the drift pill together — a legitimate-looking pool with a red pill usually points at an upstream issue, not enrolment rot.

Force a run from the CLI:
```bash
sudo docker exec fnvr-ml-worker-1 python -c "from fnvr_ml import drift; print(drift.check())"
```

## Common problems + diagnosis

### "Faces are detected but never match anyone"

Most likely causes, in order:

1. **Negative-penalty poisoning.** A noisy `face_dismissals` pool drags every real match under threshold. Disable penalty or wipe dismissals (see above).
2. **Threshold too high.** Drop to 0.32.
3. **Narrow enrolment pool.** If you only have portraits, CCTV-angle probes won't match. Enrol from clusters.
4. **All enrolments are actually someone else.** Sort the person's embeddings by lowest neighbour-sim; if everything is red, the pool is broken. Consider deleting the person and re-enrolling from clusters.

### "Strangers are being matched as tim"

- **Threshold too low.** Raise to 0.35+.
- **Pool has a rogue outlier** — an embedding of another person that happens to have ≥2 similar siblings (e.g. you enrolled a cluster that mixed you + a visiting friend). The badge won't flag it because all the friend's embeddings are neighbours to each other. Manual review of the thumbnail grid is the only reliable fix.

### "Adding more photos tanks the match rate"

You're looking at the old whole-pool coherence metric on a legacy build. The current badge is nearest-neighbour. If your build still shows `mean_cosine_to_rest`, run `docker compose pull && docker compose up -d api web`.

### "The pool looks great but matches are rare"

Often pipeline-side: face alignment is unstable on low-res crops so ArcFace embeddings are noisier than the pool's internal consistency would suggest. Symptoms:

- `mean_cosine_to_rest` / `nearest_neighbour_similarity` is healthy (0.45+).
- Top-K of probes against the pool runs 0.25–0.35 consistently — below threshold.

Workaround: lower threshold to 0.30 and monitor for false positives. Real fix is pipeline-side landmarks / alignment tuning, which is a future slice.

## Observability

- **Prometheus** — `fnvr_enrolled_embeddings`, `fnvr_face_negatives` gauges on :9091.
- **Event-processor logs** — every reload logs `face_enrolments=N face_threshold=X face_margin=Y face_negatives=Z neg_penalty_weight=W`.
- **Per-person drill-down** — the Faces page shows distribution of kNN scores for the selected person.
