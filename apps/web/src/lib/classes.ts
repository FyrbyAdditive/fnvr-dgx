// COCO class label helpers shared by Settings and Cameras UIs. Labels are
// fetched once from /coco.labels (static asset) and memoised.
//
// CATEGORY ordering groups classes so the Settings grid stays readable
// instead of a flat 80-row wall. Labels that aren't in the map fall
// through to "Other" — which keeps future model swaps working.

let cache: string[] | null = null;
let pending: Promise<string[]> | null = null;

export async function loadCocoLabels(): Promise<string[]> {
  if (cache) return cache;
  if (pending) return pending;
  pending = fetch("/coco.labels")
    .then((r) => r.text())
    .then((t) => {
      cache = t
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return cache;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

// Seven buckets chosen by operator-mental-model, not taxonomy. "Outdoor
// fixtures" covers the urban-street objects that almost nobody cares
// about from a security POV; separating them lets people kill the whole
// group with a few clicks.
export const CATEGORY_ORDER = [
  "People",
  "Vehicles",
  "Animals",
  "Outdoor fixtures",
  "Kitchen & food",
  "Indoor objects",
  "Electronics",
  "Other",
] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

const MAP: Record<string, Category> = {
  person: "People",

  bicycle: "Vehicles",
  car: "Vehicles",
  motorcycle: "Vehicles",
  airplane: "Vehicles",
  bus: "Vehicles",
  train: "Vehicles",
  truck: "Vehicles",
  boat: "Vehicles",

  bird: "Animals",
  cat: "Animals",
  dog: "Animals",
  horse: "Animals",
  sheep: "Animals",
  cow: "Animals",
  elephant: "Animals",
  bear: "Animals",
  zebra: "Animals",
  giraffe: "Animals",

  "traffic light": "Outdoor fixtures",
  "fire hydrant": "Outdoor fixtures",
  "stop sign": "Outdoor fixtures",
  "parking meter": "Outdoor fixtures",
  bench: "Outdoor fixtures",

  bottle: "Kitchen & food",
  "wine glass": "Kitchen & food",
  cup: "Kitchen & food",
  fork: "Kitchen & food",
  knife: "Kitchen & food",
  spoon: "Kitchen & food",
  bowl: "Kitchen & food",
  banana: "Kitchen & food",
  apple: "Kitchen & food",
  sandwich: "Kitchen & food",
  orange: "Kitchen & food",
  broccoli: "Kitchen & food",
  carrot: "Kitchen & food",
  "hot dog": "Kitchen & food",
  pizza: "Kitchen & food",
  donut: "Kitchen & food",
  cake: "Kitchen & food",

  chair: "Indoor objects",
  couch: "Indoor objects",
  "potted plant": "Indoor objects",
  bed: "Indoor objects",
  "dining table": "Indoor objects",
  toilet: "Indoor objects",
  sink: "Indoor objects",
  book: "Indoor objects",
  clock: "Indoor objects",
  vase: "Indoor objects",
  scissors: "Indoor objects",
  "teddy bear": "Indoor objects",
  "hair drier": "Indoor objects",
  toothbrush: "Indoor objects",
  backpack: "Indoor objects",
  umbrella: "Indoor objects",
  handbag: "Indoor objects",
  tie: "Indoor objects",
  suitcase: "Indoor objects",
  frisbee: "Indoor objects",
  skis: "Indoor objects",
  snowboard: "Indoor objects",
  "sports ball": "Indoor objects",
  kite: "Indoor objects",
  "baseball bat": "Indoor objects",
  "baseball glove": "Indoor objects",
  skateboard: "Indoor objects",
  surfboard: "Indoor objects",
  "tennis racket": "Indoor objects",

  tv: "Electronics",
  laptop: "Electronics",
  mouse: "Electronics",
  remote: "Electronics",
  keyboard: "Electronics",
  "cell phone": "Electronics",
  microwave: "Electronics",
  oven: "Electronics",
  toaster: "Electronics",
  refrigerator: "Electronics",
};

export function classCategory(label: string): Category {
  return MAP[label] ?? "Other";
}
