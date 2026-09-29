/**
 * Points of interest: where things are on each body, as data.
 *
 * Positions are latitude/longitude on the body (degrees; latitude along the
 * spin axis) or meter offsets (east, north) from another point, so level
 * layout survives terrain tweaks: props are dropped onto the height field
 * at load time.
 */
export type PoiKind = "start" | "pad" | "pod" | "ruin" | "monolith" | "debris";

export interface PoiDef {
  id: string;
  body: string;
  kind: PoiKind;
  name: string;
  /** Absolute placement (degrees)... */
  lat?: number;
  lon?: number;
  /** ...or relative to another POI (meters east / north). */
  near?: { poi: string; east: number; north: number };
  /** Facing, degrees clockwise from north. */
  heading?: number;
  /** Lore/discovery unlocked by scanning (see data/content.ts). */
  discovery?: string;
  /** Items salvaged here (see data/content.ts). */
  salvage?: { item: string; count: number }[];
}

/** The crash site: a gentle coastal shelf on Vael, mid-morning at game start. */
export const START_SITE = { body: "vael", lat: 26.5, lon: 96 };

export const POIS: PoiDef[] = [
  {
    id: "start",
    body: "vael",
    kind: "start",
    name: "Crash site",
    lat: START_SITE.lat,
    lon: START_SITE.lon,
    heading: 20,
  },
  {
    id: "pod",
    body: "vael",
    kind: "pod",
    name: "Escape pod",
    near: { poi: "start", east: 7, north: 3 },
    heading: 70,
    salvage: [
      { item: "scrap", count: 4 },
      { item: "powerCell", count: 1 },
    ],
  },
  {
    id: "pad",
    body: "vael",
    kind: "pad",
    name: "Survey pad",
    near: { poi: "start", east: -6, north: 34 },
    heading: 20,
  },
  {
    id: "ruin-shore",
    body: "vael",
    kind: "ruin",
    name: "Shore ruins",
    near: { poi: "start", east: -120, north: -60 },
    heading: 140,
    discovery: "glyphs-basic",
    salvage: [{ item: "alloy", count: 3 }],
  },
  {
    id: "monolith-ridge",
    body: "vael",
    kind: "monolith",
    name: "Ridge monolith",
    near: { poi: "start", east: 420, north: 380 },
    heading: 200,
    discovery: "star-map",
  },
  {
    id: "debris-tethys",
    body: "tethys",
    kind: "debris",
    name: "Research vessel debris",
    lat: 12,
    lon: 5,
    heading: 0,
    discovery: "ship-log",
    salvage: [
      { item: "alloy", count: 6 },
      { item: "navCore", count: 1 },
    ],
  },
  {
    id: "ruin-cinder",
    body: "cinder",
    kind: "ruin",
    name: "Relay foundations",
    lat: -8,
    lon: 40,
    heading: 90,
    discovery: "relay",
  },
];

/** Resolve a POI to a unit direction on its body (body frame). */
export function poiDirection(poi: PoiDef, radius: number, all: PoiDef[] = POIS): [number, number, number] {
  if (poi.lat !== undefined && poi.lon !== undefined) return latLonToDir(poi.lat, poi.lon);
  if (!poi.near) throw new Error(`POI ${poi.id} has no position`);
  const base = all.find((p) => p.id === poi.near!.poi);
  if (!base) throw new Error(`POI ${poi.id}: unknown anchor ${poi.near.poi}`);
  const d = poiDirection(base, radius, all);
  const { east, north } = tangentAxes(d);
  const x = d[0] + (east[0] * poi.near.east + north[0] * poi.near.north) / radius;
  const y = d[1] + (east[1] * poi.near.east + north[1] * poi.near.north) / radius;
  const z = d[2] + (east[2] * poi.near.east + north[2] * poi.near.north) / radius;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/**
 * Latitude/longitude (degrees) -> unit direction in the body frame. +Y is
 * the north pole; longitude increases eastward, i.e. in the direction the
 * body spins (the sun rises in the east).
 */
export function latLonToDir(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}

/** Local east / north unit vectors at a direction (north = toward +Y pole). */
export function tangentAxes(d: [number, number, number]): {
  east: [number, number, number];
  north: [number, number, number];
} {
  // east = normalize(Y x d) (numerical cross), north = d x east.
  let ex = 1 * d[2] - 0 * d[1];
  let ey = 0 * d[0] - 0 * d[2];
  let ez = 0 * d[1] - 1 * d[0];
  const l = Math.hypot(ex, ey, ez);
  if (l < 1e-6) return { east: [1, 0, 0], north: [0, 0, -1] };
  ex /= l;
  ey /= l;
  ez /= l;
  const nx = d[1] * ez - d[2] * ey;
  const ny = d[2] * ex - d[0] * ez;
  const nz = d[0] * ey - d[1] * ex;
  return { east: [ex, ey, ez], north: [nx, ny, nz] };
}

/** Heading (degrees clockwise from north) -> tangent direction. */
export function headingVector(d: [number, number, number], headingDeg: number): [number, number, number] {
  const { east, north } = tangentAxes(d);
  const h = (headingDeg * Math.PI) / 180;
  return [
    north[0] * Math.cos(h) + east[0] * Math.sin(h),
    north[1] * Math.cos(h) + east[1] * Math.sin(h),
    north[2] * Math.cos(h) + east[2] * Math.sin(h),
  ];
}
