-- +goose Up
-- +goose StatementBegin

-- Phase 2 of the custom-detector rollout: manual labelling.
--
-- Today's object_flags rows always derive from a real `detections`
-- row — the operator clicks an existing bbox and either marks it a
-- false positive or relabels it. The phash + detection_id come from
-- that source row.
--
-- Manual labels (drawing a box on a frozen tile to teach the
-- detector about an object it currently misses) have neither: no
-- prior detection, no phash to suppress against. They contribute a
-- frame + label_path to the YOLO dataset tree but are inert from the
-- live-suppression engine's perspective.
--
-- Two ways to model this: sentinel values (-1 / 0) or nullable
-- columns. Going with nullable — the schema then *says* "no
-- detection" rather than relying on every reader to know the
-- sentinel convention.
ALTER TABLE object_flags
    ALTER COLUMN detection_id DROP NOT NULL,
    ALTER COLUMN phash        DROP NOT NULL;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin

-- Down requires sentinel-fill before the NOT NULL re-application;
-- callers using sentinel(0) for the rollback case is acceptable.
UPDATE object_flags SET detection_id = 0 WHERE detection_id IS NULL;
UPDATE object_flags SET phash        = 0 WHERE phash        IS NULL;
ALTER TABLE object_flags
    ALTER COLUMN detection_id SET NOT NULL,
    ALTER COLUMN phash        SET NOT NULL;

-- +goose StatementEnd
