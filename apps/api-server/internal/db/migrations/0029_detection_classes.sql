-- +goose Up
-- +goose StatementBegin

-- Detection class taxonomy. Single source of truth for "what objects
-- can the detector emit" — replaces the hard-coded CocoClasses array
-- in apps/api-server/internal/flags/dataset.go and the parallel
-- string lists in apps/web/src/lib/api.ts (COCO_CLASSES) and
-- apps/pipeline-supervisor/src/hailo_probe.cpp (kCocoLabels).
--
-- Two reasons to make this data-driven:
--   1. The user wants to trim COCO down to a focused set for their
--      site (person, car, truck, dog, parcel, ...) so noisy classes
--      like "frisbee" and "wine glass" don't pollute the UI or the
--      training dataset.
--   2. The user wants to add custom classes (e.g. 'amazon-van',
--      'parcel') that the future fine-tuned Hailo HEF will detect.
--
-- yolo_id is the integer the model emits — it MUST match the order
-- in deploy/config/nvinfer/coco.labels (which DeepStream-Yolo's PGIE
-- reads at startup). For COCO seed rows that's 0..79. Custom rows
-- get yolo_id = MAX+1 at insert time.
--
-- enabled defaults to a security-NVR-relevant subset (people,
-- vehicles, animals you'd want to see at a property — see the slug
-- list in the INSERT below) and FALSE for the long tail of COCO
-- (sports balls, kitchenware, indoor objects, etc.). The user can
-- flip any class on/off from the Settings → Classes page.
--
-- Rationale: shipping with 80 enabled classes pollutes the relabel
-- dropdown with absurdities ("frisbee", "wine glass", "toothbrush")
-- and would write training samples for those if the user clicked
-- the wrong one. Defaulting to a focused set means the system is
-- usable out of the box without the operator hunting through 80
-- checkboxes to disable noise.
CREATE TABLE detection_classes (
    id           SERIAL PRIMARY KEY,
    slug         TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    yolo_id      INTEGER UNIQUE NOT NULL,
    -- 'coco' for the 80 seeded rows, 'custom' for anything the user
    -- adds. Used by DELETE to refuse removing seeded classes (those
    -- live forever — disable instead).
    origin       TEXT NOT NULL CHECK (origin IN ('coco', 'custom')),
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX detection_classes_enabled_idx
    ON detection_classes (yolo_id) WHERE enabled = TRUE;

-- Seed the 80 COCO classes in their canonical order. Slug is the
-- existing class name verbatim (kept identical to the strings
-- already stored in object_flags.class_original / class_corrected
-- and cameras.mute_classes_override so existing rows continue to
-- match). Display names are the slug title-cased; the user can edit
-- them via PATCH if they prefer (e.g. 'TV' → 'Television').
-- The TRUE/FALSE in `enabled` reflects the security-NVR default set
-- (people, vehicles, large mammals — anything you'd want to hear
-- about at a property). Mirrors the trimmed list the maintainer's
-- own deployment converged on; new installs land here.
INSERT INTO detection_classes (slug, display_name, yolo_id, origin, enabled) VALUES
    ('person',         'Person',          0,  'coco', TRUE),
    ('bicycle',        'Bicycle',         1,  'coco', TRUE),
    ('car',            'Car',             2,  'coco', TRUE),
    ('motorcycle',     'Motorcycle',      3,  'coco', TRUE),
    ('airplane',       'Airplane',        4,  'coco', TRUE),
    ('bus',            'Bus',             5,  'coco', TRUE),
    ('train',          'Train',           6,  'coco', TRUE),
    ('truck',          'Truck',           7,  'coco', TRUE),
    ('boat',           'Boat',            8,  'coco', TRUE),
    ('traffic light',  'Traffic Light',   9,  'coco', FALSE),
    ('fire hydrant',   'Fire Hydrant',    10, 'coco', FALSE),
    ('stop sign',      'Stop Sign',       11, 'coco', FALSE),
    ('parking meter',  'Parking Meter',   12, 'coco', FALSE),
    ('bench',          'Bench',           13, 'coco', FALSE),
    ('bird',           'Bird',            14, 'coco', FALSE),
    ('cat',            'Cat',             15, 'coco', TRUE),
    ('dog',            'Dog',             16, 'coco', TRUE),
    ('horse',          'Horse',           17, 'coco', TRUE),
    ('sheep',          'Sheep',           18, 'coco', TRUE),
    ('cow',            'Cow',             19, 'coco', TRUE),
    ('elephant',       'Elephant',        20, 'coco', FALSE),
    ('bear',           'Bear',            21, 'coco', TRUE),
    ('zebra',          'Zebra',           22, 'coco', FALSE),
    ('giraffe',        'Giraffe',         23, 'coco', FALSE),
    ('backpack',       'Backpack',        24, 'coco', FALSE),
    ('umbrella',       'Umbrella',        25, 'coco', FALSE),
    ('handbag',        'Handbag',         26, 'coco', FALSE),
    ('tie',            'Tie',             27, 'coco', FALSE),
    ('suitcase',       'Suitcase',        28, 'coco', FALSE),
    ('frisbee',        'Frisbee',         29, 'coco', FALSE),
    ('skis',           'Skis',            30, 'coco', FALSE),
    ('snowboard',      'Snowboard',       31, 'coco', FALSE),
    ('sports ball',    'Sports Ball',     32, 'coco', FALSE),
    ('kite',           'Kite',            33, 'coco', FALSE),
    ('baseball bat',   'Baseball Bat',    34, 'coco', FALSE),
    ('baseball glove', 'Baseball Glove',  35, 'coco', FALSE),
    ('skateboard',     'Skateboard',      36, 'coco', FALSE),
    ('surfboard',      'Surfboard',       37, 'coco', FALSE),
    ('tennis racket',  'Tennis Racket',   38, 'coco', FALSE),
    ('bottle',         'Bottle',          39, 'coco', FALSE),
    ('wine glass',     'Wine Glass',      40, 'coco', FALSE),
    ('cup',            'Cup',             41, 'coco', FALSE),
    ('fork',           'Fork',            42, 'coco', FALSE),
    ('knife',          'Knife',           43, 'coco', FALSE),
    ('spoon',          'Spoon',           44, 'coco', FALSE),
    ('bowl',           'Bowl',            45, 'coco', FALSE),
    ('banana',         'Banana',          46, 'coco', FALSE),
    ('apple',          'Apple',           47, 'coco', FALSE),
    ('sandwich',       'Sandwich',        48, 'coco', FALSE),
    ('orange',         'Orange',          49, 'coco', FALSE),
    ('broccoli',       'Broccoli',        50, 'coco', FALSE),
    ('carrot',         'Carrot',          51, 'coco', FALSE),
    ('hot dog',        'Hot Dog',         52, 'coco', FALSE),
    ('pizza',          'Pizza',           53, 'coco', FALSE),
    ('donut',          'Donut',           54, 'coco', FALSE),
    ('cake',           'Cake',            55, 'coco', FALSE),
    ('chair',          'Chair',           56, 'coco', FALSE),
    ('couch',          'Couch',           57, 'coco', FALSE),
    ('potted plant',   'Potted Plant',    58, 'coco', FALSE),
    ('bed',            'Bed',             59, 'coco', FALSE),
    ('dining table',   'Dining Table',    60, 'coco', FALSE),
    ('toilet',         'Toilet',          61, 'coco', FALSE),
    ('tv',             'TV',              62, 'coco', FALSE),
    ('laptop',         'Laptop',          63, 'coco', FALSE),
    ('mouse',          'Mouse',           64, 'coco', FALSE),
    ('remote',         'Remote',          65, 'coco', FALSE),
    ('keyboard',       'Keyboard',        66, 'coco', FALSE),
    ('cell phone',     'Cell Phone',      67, 'coco', FALSE),
    ('microwave',      'Microwave',       68, 'coco', FALSE),
    ('oven',           'Oven',            69, 'coco', FALSE),
    ('toaster',        'Toaster',         70, 'coco', FALSE),
    ('sink',           'Sink',            71, 'coco', FALSE),
    ('refrigerator',   'Refrigerator',    72, 'coco', FALSE),
    ('book',           'Book',            73, 'coco', FALSE),
    ('clock',          'Clock',           74, 'coco', FALSE),
    ('vase',           'Vase',            75, 'coco', FALSE),
    ('scissors',       'Scissors',        76, 'coco', FALSE),
    ('teddy bear',     'Teddy Bear',      77, 'coco', FALSE),
    ('hair drier',     'Hair Drier',      78, 'coco', FALSE),
    ('toothbrush',     'Toothbrush',      79, 'coco', FALSE);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS detection_classes;
-- +goose StatementEnd
