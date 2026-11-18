/**
 * Minimal lon/lat geometry for footprints and search areas: no dependency, enough for client-side checks
 * (does an item's footprint intersect or contain the area?) and for coverage estimates on a grid.
 *
 * All coordinates are longitude/latitude in degrees, treated as planar (no geodesic edges). Bounding boxes are
 * `[west, south, east, north]`; only {@link bboxesIntersect} understands boxes that cross the antimeridian
 * (`west > east`).
 */
import type {Bbox, GeoJsonArea, StacItemJson} from "./json.js";

type Ring = number[][];

/**
 * Polygons (outer ring first, then holes) of a polygonal geometry; empty for other types.
 *
 * @param geometry A GeoJSON geometry. `Polygon` and `MultiPolygon` are read; any other type, `null` or `undefined`
 *   gives no polygons.
 * @returns One entry per polygon, each a list of rings (`[outer, ...holes]`), each ring a list of `[lon, lat]`
 *   positions. A `Polygon` gives a list of one polygon; the coordinates are returned as is, not copied.
 *
 * @category Selection helpers
 */
export function polygonsOf(geometry: { type: string; coordinates: unknown } | null | undefined): Ring[][] {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates as Ring[]];
    if (geometry.type === "MultiPolygon") return geometry.coordinates as Ring[][];
    return [];
}

/**
 * A GeoJSON polygon with the outline of a bounding box.
 *
 * @param bbox The box `[west, south, east, north]`, in degrees.
 * @returns A `Polygon` with one closed counter-clockwise ring of five positions (south-west first and last).
 *
 * @category Selection helpers
 */
export function bboxPolygon([w, s, e, n]: Bbox): GeoJsonArea {
    return {type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]};
}

/**
 * Whether a value is a bounding box `[west, south, east, north]` (an array of exactly four numbers).
 *
 * @param area Any value, typically a search area that is either a bbox or a GeoJSON polygon.
 * @returns `true` (narrowing `area` to {@link Bbox}) for an array of four numbers, else `false`. Six-number (3D)
 *   boxes are not accepted.
 *
 * @category Selection helpers
 */
export function isBbox(area: unknown): area is Bbox {
    return Array.isArray(area) && area.length === 4 && area.every((v) => typeof v === "number");
}

/**
 * Bounding box of a geometry.
 *
 * For polygons only the outer ring of each polygon is read (holes cannot extend the box); other geometry types
 * (`Point`, `LineString`, `MultiPoint`, ...) use all their positions. Positions are read as `[lon, lat, ...]`, so
 * 3D positions are fine.
 *
 * @param area A bbox (returned unchanged), a GeoJSON `Polygon` or `MultiPolygon`, or any GeoJSON geometry.
 * @returns `[west, south, east, north]` in degrees.
 * @throws `RangeError` when the geometry has no positions (an empty multipolygon, `null` coordinates).
 * @example
 * ```ts
 * const area: GeoJsonArea = drawnPolygon; // a GeoJSON polygon drawn by the user, in degrees
 * const [west, south, east, north] = bboxOf(area);
 * ```
 *
 * @category Selection helpers
 */
export function bboxOf(area: Bbox | GeoJsonArea | { type: string; coordinates: unknown }): Bbox {
    if (isBbox(area)) return area;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const add = (x: number, y: number) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); };
    const polygons = polygonsOf(area);
    if (polygons.length) {
        for (const poly of polygons) for (const [x, y] of poly[0] ?? []) add(x, y);
    } else {
        // Any other geometry: every position, at any nesting depth.
        const walk = (c: unknown): void => {
            if (!Array.isArray(c)) return;
            if (typeof c[0] === "number" && typeof c[1] === "number") { add(c[0], c[1]); return; }
            c.forEach(walk);
        };
        walk((area as { coordinates?: unknown })?.coordinates);
    }
    if (!(w <= e && s <= n)) throw new RangeError(`The geometry${(area as { type?: string })?.type ? ` (${(area as { type?: string }).type})` : ""} has no positions: it has no bounding box`);
    return [w, s, e, n];
}

function inRing(x: number, y: number, ring: Ring): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Whether a point lies inside polygonal geometry (holes excluded).
 *
 * Uses an even-odd ray-casting test per ring; points exactly on an edge may fall either way.
 *
 * @param polygons Polygons as returned by `polygonsOf` or {@link footprintOf}: `[outer, ...holes]` each.
 * @param x Longitude of the point, in degrees.
 * @param y Latitude of the point, in degrees.
 * @returns `true` when the point is inside the outer ring and outside every hole of at least one polygon; `false`
 *   for an empty list.
 *
 * @category Selection helpers
 */
export function containsPoint(polygons: Ring[][], x: number, y: number): boolean {
    return polygons.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}

/**
 * Whether two bounding boxes overlap or touch.
 *
 * A box whose west edge is greater than its east edge crosses the antimeridian (as in STAC and GeoJSON): it covers
 * `west..180` and `-180..east`.
 *
 * @param a A box `[west, south, east, north]`, in degrees.
 * @param b Another box, in the same form.
 * @returns `true` when the boxes share at least one point (shared edges count), else `false`.
 *
 * @category Selection helpers
 */
export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
    if (a[1] > b[3] || a[3] < b[1]) return false;
    // Longitude ranges, split at the antimeridian.
    const spans = (w: number, e: number): [number, number][] => (w > e ? [[w, 180], [-180, e]] : [[w, e]]);
    return spans(a[0], a[2]).some(([aw, ae]) => spans(b[0], b[2]).some(([bw, be]) => aw <= be && ae >= bw));
}

/**
 * Sample points (cell centres) of an area on an n x n grid over its bbox, with cos(latitude) area weights.
 *
 * Only cell centres inside the area are returned, so a polygon gives fewer than `n * n` points.
 *
 * @param area A bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in degrees.
 * @param n Grid cells per side of the area's bbox. Default 64 (at most 4096 points).
 * @returns The points inside the area, row by row from the south: `x` longitude and `y` latitude in degrees, and
 *   `w` the weight `cos(latitude)`, proportional to the cell's area on the ground.
 *
 * @category Selection helpers
 */
export function samplePoints(area: Bbox | GeoJsonArea, n = 64): { x: number; y: number; w: number }[] {
    const polys = polygonsOf(isBbox(area) ? bboxPolygon(area) : area);
    const [w, s, e, nn] = bboxOf(area);
    const out: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j < n; j++) {
        const y = s + ((j + 0.5) * (nn - s)) / n;
        const weight = Math.cos((y * Math.PI) / 180);
        for (let i = 0; i < n; i++) {
            const x = w + ((i + 0.5) * (e - w)) / n;
            if (containsPoint(polys, x, y)) out.push({x, y, w: weight});
        }
    }
    return out;
}

/**
 * The footprint of an item: its geometry, else its bbox.
 *
 * @param item A STAC item. Its `geometry` is used when it is a `Polygon` or `MultiPolygon`; otherwise its `bbox`:
 *   `[west, south, east, north]`, or `[west, south, min height, east, north, max height]` for a 3D bbox.
 * @returns Polygons as for `polygonsOf`; an empty list when the item has neither a polygonal geometry nor a
 *   bbox.
 *
 * @category Selection helpers
 */
export function footprintOf(item: StacItemJson): Ring[][] {
    const polys = polygonsOf(item.geometry);
    if (polys.length) return polys;
    const b = item.bbox;
    if (!b || b.length < 4) return [];
    return polygonsOf(bboxPolygon(b.length >= 6 ? [b[0], b[1], b[3], b[4]] : [b[0], b[1], b[2], b[3]]));
}

/**
 * Fraction (0..1, area-weighted) of `area` inside the item's footprint, estimated on a grid.
 *
 * @param item A STAC item; its footprint is taken from {@link footprintOf}.
 * @param area The area of interest: a bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in degrees.
 * @param n Grid cells per side used to sample the area (see `samplePoints`). Default 64; the accuracy is
 *   about one cell.
 * @returns The covered fraction between 0 and 1, weighted by cos(latitude); 0 when the area has no sample points
 *   (an empty or degenerate area).
 * @example
 * ```ts
 * const area: Bbox = [west, south, east, north]; // drawn by the user, in degrees
 * const item: StacItemJson = searchResult;       // an item returned by a search
 * const covered = coverageOf(item, area);         // 1 when the scene covers the whole area
 * ```
 *
 * @category Selection helpers
 */
export function coverageOf(item: StacItemJson, area: Bbox | GeoJsonArea, n = 64): number {
    const points = samplePoints(area, n);
    const total = points.reduce((a, p) => a + p.w, 0);
    if (!total) return 0;
    const fp = footprintOf(item);
    return points.reduce((a, p) => a + (containsPoint(fp, p.x, p.y) ? p.w : 0), 0) / total;
}

/**
 * Whether the item's footprint touches the area (approximate: bbox test, then a grid of the area).
 *
 * The test is positive when the bounding boxes overlap and either a vertex of the footprint's outer rings lies in
 * the area or one of the area's sample points (32 x 32 grid) lies in the footprint. Thin overlaps that contain
 * neither can be missed.
 *
 * @param item A STAC item; its footprint is taken from {@link footprintOf}.
 * @param area A bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in degrees.
 * @returns `true` when the footprint and the area are found to intersect; `false` otherwise, and always `false`
 *   for an item without a footprint.
 *
 * @category Selection helpers
 */
export function intersectsArea(item: StacItemJson, area: Bbox | GeoJsonArea): boolean {
    const fp = footprintOf(item);
    if (!fp.length) return false;
    if (!bboxesIntersect(bboxOf({type: "MultiPolygon", coordinates: fp}), bboxOf(area))) return false;
    const areaPolys = polygonsOf(isBbox(area) ? bboxPolygon(area) : area);
    // Any footprint vertex inside the area, or any area sample inside the footprint.
    if (fp.some((p) => p[0].some(([x, y]) => containsPoint(areaPolys, x, y)))) return true;
    return samplePoints(area, 32).some((p) => containsPoint(fp, p.x, p.y));
}
