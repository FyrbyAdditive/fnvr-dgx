# Object false-positive flags

fnvr lets operators mark object detections as wrong directly on the Live feed. Each flag does two jobs:

1. **Immediate suppression** of visually similar future detections on the same camera + class. No model retraining required — it uses a perceptual-hash (pHash) Hamming-distance match on the bbox crop. Effect is visible within ≤ 30 s of flagging (the event-processor's next reload).
2. **Dataset curation for the future**. Every flag writes a full-frame JPEG + YOLO-format label file into `/var/lib/fnvr/datasets/objects/`. The tree is ready to feed Ultralytics or TAO training on an external GPU when that hardware is available — the data survives model upgrades and can be hand-edited.

## Flow

1. Open **Live**. Click any bbox you want to flag. The tile freezes on that moment so the bbox doesn't move under your cursor.
2. A popover opens next to the bbox offering:
   - **False positive — suppress future matches.** The detection is recorded as "this is nothing" and similar crops will stop showing up.
   - **Relabel as…** (dropdown of the 80 COCO classes). Use when the detector is consistently mislabelling — e.g. calling a delivery truck a "car". The flag records the correction into the dataset (for future fine-tune) AND suppresses further `car` detections on this bbox-like region.
3. Submit. The tile unfreezes; the flag appears in the Flags page.

Click outside the popover or press Escape to cancel without flagging. The tile auto-unfreezes after 15 s.

## Where flags live

Managed from the **Flags** page (sidebar). Each flag shows:
- A thumbnail of the bbox crop.
- Original class → corrected class (or "not a *class*" for false positives).
- Camera + timestamp.
- Dataset frame path on disk.

Admin actions per flag:
- **dismiss** — removes it from the suppression library but keeps the dataset entry. Use if suppression was too eager but the training signal is still valid.
- **dismiss + purge** — also deletes the JPEG + label file from the dataset tree. Use when the flag itself was wrong.

Viewers can see the page but can't flag or dismiss.

## Tuning sensitivity

`detections.suppression_hamming_threshold` (default 8, range 4–16) controls how similar a future detection has to look to a flagged one before it's suppressed.

- Tighter (4–6): only near-identical crops suppress. Misses recurring false positives whose appearance shifts with lighting or weather.
- Default (8): matches the standard pHash identity cutoff. Good starting point.
- Looser (10–16): suppresses anything that "looks roughly the same". Risk of killing real detections nearby.

Edit via psql:

```sql
UPDATE settings SET value = '6'::jsonb
 WHERE key = 'detections.suppression_hamming_threshold';
```

Takes effect within 30 s.

## Dataset-on-disk layout

```
/var/lib/fnvr/datasets/objects/
  dataset.yaml              # Ultralytics canonical format; path + classes
  images/train/<flag_id>.jpg
  images/val/<flag_id>.jpg  # 10% of flags (deterministic on id %% 10)
  labels/train/<flag_id>.txt
  labels/val/<flag_id>.txt
```

`dataset.yaml` is auto-regenerated on every flag create/dismiss. Sample:

```yaml
path: /var/lib/fnvr/datasets/objects
train: images/train
val: images/val
names:
  0: person
  1: bicycle
  ...
```

Label format: one line per corrected class, `<class_id> <x_center> <y_center> <w> <h>`, all normalised. Empty file = "no objects in this image near this region" (standard YOLO training convention for hard-negative patches).

**Rsync this tree to a GPU host and it's ready to pass to `yolo train data=dataset.yaml ...`** — no format conversion required.

## Limits

- **Only object-kind detections are flaggable.** Face detections go through the Faces page; plates through the Plates page.
- **No new classes yet.** The relabel dropdown is fixed to the 80 COCO classes. Adding operator-defined classes is a future slice.
- **Per-camera + per-class scope.** A flag on `camera-A + car` doesn't suppress `car` on `camera-B`, and doesn't suppress `truck` on `camera-A`. This is deliberate — it keeps the blast radius of a single flag small.
- **pHash similarity, not full YOLO feature vectors.** Occasional misses when the same-class-wrong-thing looks visually different from every existing flag. Those future flags add to the dataset for eventual off-device training.

## Observability

Prometheus (`:9091/metrics`):
- `fnvr_object_flags_loaded` — current library size.
- `fnvr_detections_suppressed_total{camera_id, class}` — suppression hits.

Event-processor logs (debug level): `suppressed by flag camera=X class=Y phash=abc123...` when a detection is dropped.
