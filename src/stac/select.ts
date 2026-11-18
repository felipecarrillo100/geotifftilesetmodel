/**
 * Choosing items from search results: plain functions on STAC item JSON, so applications can combine them or
 * write their own.
 */
import {bboxOf, containsPoint, footprintOf, samplePoints} from "./geometry.js";
import type {Bbox, GeoJsonArea, StacItemJson} from "./json.js";

/**
 * Default score: cloud cover (lower is better), then recency.
 *
 * The score is the cloud cover in percent (`eo:cloud_cover`, else `cloud_cover`, else 50 when missing or not a
 * number) minus a tiny recency term (the datetime in milliseconds divided by 1e15, about 1.7 for 2024), so between
 * items of similar cloud cover the newer wins.
 *
 * @param item The STAC item to score.
 * @returns A number; lower is better. Sort ascending to get the best items first.
 *
 * @category Selection helpers
 */
export function defaultScore(item: StacItemJson): number {
    const cc = Number(item.properties["eo:cloud_cover"] ?? item.properties.cloud_cover ?? 50);
    const t = Date.parse(String(item.properties.datetime ?? "")) || 0;
    return (Number.isFinite(cc) ? cc : 50) - t / 1e15;
}

/**
 * The fewest items, best first, whose footprints together cover an area: greedy set cover on a grid of sample
 * points (cos(latitude) weighted). `coverage` is the fraction covered; `uncovered` lists sample points left out.
 *
 * Items are visited once in score order (best first); an item is chosen when it covers at least `minGain` of the
 * area not yet covered, and the walk stops at `target` coverage or `maxItems` items. This favours good scores over
 * the absolute minimum number of items. Footprints come from {@link footprintOf}.
 *
 * @param items Candidate items, for example the results of a search over the area.
 * @param area The area to cover: a bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in degrees.
 * @param options Scoring and stopping rules; every property is optional. Default `{}`.
 * @returns The chosen items in the order they were chosen (best first), the covered fraction (0..1,
 *   area-weighted), and the `[lon, lat]` sample points no chosen item covers.
 * @example
 * ```ts
 * const client = await StacClient.connect(api);  // api: the STAC API URL configured by the application
 * const collection = "...";                       // a collection id chosen by the user
 * const area: Bbox = [west, south, east, north];  // drawn by the user, in degrees
 * const items = await client.search({collections: [collection], area, datetime: "2024-07"}).collect();
 * const {items: mosaic, coverage} = coverArea(items, area, {target: 0.95, maxItems: 6});
 * if (coverage < 0.95) console.warn(`only ${Math.round(coverage * 100)} % of the area is covered`);
 * ```
 *
 * @category Selection helpers
 */
export function coverArea(items: StacItemJson[], area: Bbox | GeoJsonArea, options: {
    /** Item score, lower is better. Default {@link defaultScore} (least cloud, then newest). */
    score?: (item: StacItemJson) => number;
    /** Stop at this covered fraction. Default 0.99. */
    target?: number;
    /** Skip items that add less than this fraction. Default 0.005. */
    minGain?: number;
    /** Choose at most this many items. Default: no limit. */
    maxItems?: number;
    /** Grid cells per side. Default 64. */
    gridSize?: number;
} = {}): {
    /** The chosen items, best first. */
    items: StacItemJson[];
    /** Fraction of the area covered by the chosen items, 0..1, area-weighted. */
    coverage: number;
    /** Sample points `[lon, lat]` (degrees) that no chosen item covers. */
    uncovered: [number, number][];
} {
    const score = options.score ?? defaultScore;
    const target = options.target ?? 0.99, minGain = options.minGain ?? 0.005, maxItems = options.maxItems ?? Infinity;
    const points = samplePoints(area, options.gridSize ?? 64);
    const total = points.reduce((a, p) => a + p.w, 0) || 1;
    const covered = new Uint8Array(points.length);
    let coverage = 0;
    const chosen: StacItemJson[] = [];
    for (const item of [...items].sort((a, b) => score(a) - score(b))) {
        if (coverage >= target || chosen.length >= maxItems) break;
        const fp = footprintOf(item);
        let gain = 0;
        const hits: number[] = [];
        points.forEach((p, i) => { if (!covered[i] && containsPoint(fp, p.x, p.y)) { gain += p.w; hits.push(i); } });
        if (gain / total < minGain) continue;
        hits.forEach((i) => { covered[i] = 1; });
        coverage += gain / total;
        chosen.push(item);
    }
    return {items: chosen, coverage, uncovered: points.filter((_, i) => !covered[i]).map((p) => [p.x, p.y])};
}

/**
 * Items whose footprint contains the whole area (within the grid's accuracy).
 *
 * @param items Candidate items.
 * @param area The area: a bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in degrees.
 * @param gridSize Grid cells per side used to sample the area; every sample point must lie in the footprint.
 *   Default 32.
 * @returns The items covering the whole area, in their original order; an empty list when the area has no sample
 *   points.
 * @example
 * ```ts
 * const area: Bbox = [west, south, east, north]; // drawn by the user, in degrees
 * const full = itemsCovering(items, area);        // items: results of a search over the area
 * ```
 *
 * @category Selection helpers
 */
export function itemsCovering(items: StacItemJson[], area: Bbox | GeoJsonArea, gridSize = 32): StacItemJson[] {
    const points = samplePoints(area, gridSize);
    return items.filter((item) => {
        const fp = footprintOf(item);
        return points.length > 0 && points.every((p) => containsPoint(fp, p.x, p.y));
    });
}

/**
 * A calendar period for grouping items by time, in UTC: `"day"`, `"week"` (ISO 8601 week), `"month"`,
 * `"quarter"`, `"year"`, or `"solar-day"` (the local day at the item's own centre longitude, see
 * {@link solarLongitude}, so that one satellite pass that crosses midnight UTC stays in one day). Every function
 * of the library that groups by solar day uses that same rule: {@link groupItems}, {@link bestPerPeriod},
 * `StacClient.select` with `pick.per` and `GeoTiffTileSetModel.create({stac: {items, per}})`.
 *
 * Each period has a label, as returned by {@link periodOf}: `"2024"` (year), `"2024-Q3"` (quarter), `"2024-07"`
 * (month), `"2024-W29"` (week), `"2024-07-15"` (day and solar day). Labels sort in time order as strings.
 *
 * @category Selection helpers
 */
export type Period = "day" | "solar-day" | "week" | "month" | "quarter" | "year";

/**
 * The period key of an item: "2024", "2024-Q3", "2024-07", "2024-W29", "2024-07-15".
 *
 * Keys sort chronologically as strings. Weeks are ISO 8601 weeks with their ISO year (late December can be week 1
 * of the next year).
 *
 * @param item The item; its `datetime`, else `start_datetime`, is used.
 * @param period The period ({@link Period}). `"day"` and `"solar-day"` give `YYYY-MM-DD` keys.
 * @param longitude For `"solar-day"` only: the longitude in degrees; the time is shifted by `longitude / 15` hours
 *   before taking the date. Default 0 (the UTC day): pass {@link solarLongitude}`(item)` for the rule the library
 *   uses everywhere else.
 * @returns The key, or `"unknown"` when the item has no parsable datetime.
 *
 * @category Selection helpers
 */
export function periodOf(item: StacItemJson, period: Period, longitude = 0): string {
    const t = Date.parse(String(item.properties.datetime ?? item.properties.start_datetime ?? ""));
    if (Number.isNaN(t)) return "unknown";
    // Solar day: UTC shifted by longitude/15 hours, so one satellite pass is one day everywhere (odc-stac).
    const d = new Date(period === "solar-day" ? t + (longitude / 15) * 3600e3 : t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    const p2 = (n: number) => String(n).padStart(2, "0");
    switch (period) {
        case "year": return `${y}`;
        case "quarter": return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
        case "month": return `${y}-${p2(m)}`;
        case "week": {
            const date = new Date(Date.UTC(y, m - 1, day));
            const dow = date.getUTCDay() || 7;
            date.setUTCDate(date.getUTCDate() + 4 - dow);
            const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
            return `${date.getUTCFullYear()}-W${p2(Math.ceil(((date.getTime() - yearStart) / 86400e3 + 1) / 7))}`;
        }
        default: return `${y}-${p2(m)}-${p2(day)}`;
    }
}

/**
 * The best item (or, with an area, the best covering set) per period: "the clearest scene per year". Periods
 * without a candidate meeting `minCoverage` are left out.
 *
 * Items are grouped with {@link periodOf} (solar days at each item's centre longitude, {@link solarLongitude}).
 * Without an area each period keeps the item with the lowest score; with an area each period keeps the set chosen
 * by {@link coverArea} with the same score.
 *
 * @param items Candidate items, for example a search over several years.
 * @param options The period, the score and the optional area.
 * @returns One entry per kept period, sorted by period key (chronologically). Items without a datetime fall in an
 *   `"unknown"` period.
 * @example
 * ```ts
 * const client = await StacClient.connect(api);  // api: the STAC API URL configured by the application
 * const collection = "...";                       // a collection id chosen by the user
 * const area: Bbox = [west, south, east, north];  // drawn by the user, in degrees
 * const items = await client.search({collections: [collection], area, datetime: "2018/2024"}).collect();
 * for (const {period, items: scenes} of bestPerPeriod(items, {period: "year", area})) {
 *     console.log(period, scenes.map((s) => s.id));
 * }
 * ```
 *
 * @category Selection helpers
 */
export function bestPerPeriod(items: StacItemJson[], options: {
    /** The period to group by. */
    period: Period;
    /** Item score, lower is better. Default {@link defaultScore} (least cloud, then newest). */
    score?: (item: StacItemJson) => number;
    /** An area to cover (bbox `[west, south, east, north]` or GeoJSON (multi)polygon, in degrees). Without it, one item per period. */
    area?: Bbox | GeoJsonArea;
    /** With an area: minimum covered fraction for a period to be kept. Default 0.99. */
    minCoverage?: number;
}): {
    /** The period key, as from {@link periodOf}. */
    period: string;
    /** The best item (without an area) or the covering set, best first (with an area). */
    items: StacItemJson[];
    /** With an area: the fraction of the area the items cover (0..1). */
    coverage?: number;
}[] {
    const score = options.score ?? defaultScore;
    const groups = groupItems(items, (i) => periodOf(i, options.period, solarLongitude(i)));
    const out: { period: string; items: StacItemJson[]; coverage?: number }[] = [];
    for (const [period, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!options.area) {
            out.push({period, items: [[...group].sort((a, b) => score(a) - score(b))[0]]});
            continue;
        }
        const cover = coverArea(group, options.area, {score});
        if (cover.coverage >= (options.minCoverage ?? 0.99)) out.push({period, items: cover.items, coverage: cover.coverage});
    }
    return out;
}

/**
 * The longitude that decides an item's solar day: the centre of its bbox (2D or 3D; a bbox crossing the antimeridian,
 * `west > east`, is centred across it), else of its geometry, else 0.
 *
 * @param item The STAC item.
 * @returns A longitude in degrees, -180..180.
 * @example
 * ```ts
 * const item: StacItemJson = searchResult;  // an item returned by a search
 * const day = periodOf(item, "solar-day", solarLongitude(item));
 * ```
 *
 * @category Selection helpers
 */
export function solarLongitude(item: StacItemJson): number {
    const b = item.bbox;
    let west: number, east: number;
    if (b && b.length >= 4) {
        [west, east] = b.length >= 6 ? [b[0], b[3]] : [b[0], b[2]];
    } else {
        try { [west, , east] = bboxOf(item.geometry as GeoJsonArea); } catch { return 0; }
    }
    if (!Number.isFinite(west) || !Number.isFinite(east)) return 0;
    const centre = west > east ? (west + east + 360) / 2 : (west + east) / 2;
    return centre > 180 ? centre - 360 : centre;
}

/**
 * Groups items by a key: "solar-day", "datetime", "crs" (proj:code / proj:epsg), a property name, or a function.
 *
 * `"solar-day"` uses each item's centre longitude ({@link solarLongitude}); `"crs"` gives `proj:code`, else `EPSG:{proj:epsg}`, else
 * `"unknown"`; `"datetime"` and property names give the property as a string (`""` when missing).
 *
 * @param items The items to group.
 * @param by The key: one of the names above, any other item property name (`"platform"`), or a function giving
 *   the key of an item.
 * @returns A map from key to items, keys in order of first appearance and items in their original order.
 * @example
 * ```ts
 * // A stacked model needs one coordinate reference: keep the largest group.
 * const groups = groupItems(items, "crs"); // items: results of a search
 * const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
 * ```
 *
 * @category Selection helpers
 */
export function groupItems(items: StacItemJson[], by: string | ((item: StacItemJson) => string)): Map<string, StacItemJson[]> {
    const key = typeof by === "function" ? by
        : by === "solar-day" ? (i: StacItemJson) => periodOf(i, "solar-day", solarLongitude(i))
            : by === "crs" ? (i: StacItemJson) => String(i.properties["proj:code"] ?? (i.properties["proj:epsg"] !== undefined ? `EPSG:${i.properties["proj:epsg"]}` : "unknown"))
                : by === "datetime" ? (i: StacItemJson) => String(i.properties.datetime ?? "")
                    : (i: StacItemJson) => String(i.properties[by] ?? "");
    const out = new Map<string, StacItemJson[]>();
    for (const item of items) {
        const k = key(item);
        const list = out.get(k);
        if (list) list.push(item); else out.set(k, [item]);
    }
    return out;
}

/**
 * The key that identifies an item: `` `${collection}/${id}` `` (an empty collection when missing). Item ids are only
 * unique within a collection, and items of different catalogs can share an id: use this key for list rows, map
 * features and sets of chosen items. {@link dedupeItems} and {@link itemFootprints} use it.
 *
 * @param item The STAC item.
 * @returns The key, for example `"sentinel-2-l2a/S2B_T33TVL_20240814"`.
 * @example
 * ```ts
 * const chosen = new Set<string>();     // keys of the items the user ticked
 * const item: StacItemJson = ...;       // a row of the list
 * chosen.add(itemKey(item));
 * ```
 *
 * @category Selection helpers
 */
export function itemKey(item: StacItemJson): string {
    return `${item.collection ?? ""}/${item.id}`;
}

/**
 * The footprints of items as a GeoJSON FeatureCollection in longitude/latitude, for a vector layer while the user
 * chooses items. The same features as `SearchPage.footprints()`.
 *
 * Each feature's `id` and `properties.key` are {@link itemKey}; its other properties are `id`, `collection`,
 * `datetime`, `eo:cloud_cover` and `thumbnail` (the href of the `thumbnail` asset). Items without a geometry get a
 * MultiPolygon computed from their bbox ({@link footprintOf}).
 *
 * @param items The items, for example `StacClient.select(...).candidates.map((c) => c.item)`.
 * @returns A FeatureCollection with one feature per item, in the order of `items`.
 * @example
 * ```ts
 * import {GeoJsonCodec} from "@luciad/ria/model/codec/GeoJsonCodec.js";
 * import {MemoryStore} from "@luciad/ria/model/store/MemoryStore.js";
 * import {FeatureModel} from "@luciad/ria/model/feature/FeatureModel.js";
 * import {FeatureLayer} from "@luciad/ria/view/feature/FeatureLayer.js";
 * import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const found = await catalog.select(...); // catalog: a connected StacClient
 * const json = JSON.stringify(itemFootprints(found.items));
 * const crs84 = getReference("CRS:84");
 * const store = new MemoryStore({reference: crs84, data: new GeoJsonCodec().decode({content: json, contentType: "application/json"})});
 * map.layerTree.addChild(new FeatureLayer(new FeatureModel(store, {reference: crs84}), {label: "Footprints"}));
 * ```
 *
 * @category Selection helpers
 */
export function itemFootprints(items: StacItemJson[]): {
    /** Always `"FeatureCollection"`. */
    type: "FeatureCollection";
    /** One GeoJSON Feature per item. */
    features: {
        /** Always `"Feature"`. */
        type: "Feature";
        /** {@link itemKey} of the item. */
        id: string;
        /** The item's geometry, or a MultiPolygon of its bbox. */
        geometry: unknown;
        /** `key`, `id`, `collection`, `datetime`, `eo:cloud_cover` and `thumbnail`. */
        properties: Record<string, unknown>;
    }[];
} {
    return {
        type: "FeatureCollection",
        features: items.map((i) => ({
            type: "Feature", id: itemKey(i),
            geometry: i.geometry ?? {type: "MultiPolygon", coordinates: footprintOf(i)},
            properties: {key: itemKey(i), id: i.id, collection: i.collection, datetime: i.properties.datetime,
                "eo:cloud_cover": i.properties["eo:cloud_cover"], thumbnail: i.assets?.thumbnail?.href},
        })),
    };
}

/**
 * Items without duplicates (same collection and id by default; some catalogs return a scene twice).
 *
 * @param items The items, in any order.
 * @param key The identity of an item. Default {@link itemKey}: `` `${collection}/${id}` ``.
 * @returns A new list keeping the first item of each key, in the original order.
 * @example
 * ```ts
 * const unique = dedupeItems(items); // items: results of one or more searches
 * const byScene = dedupeItems(items, (i) => String(i.properties["s2:product_uri"] ?? i.id)); // a catalog-specific key
 * ```
 *
 * @category Selection helpers
 */
export function dedupeItems(items: StacItemJson[], key: (item: StacItemJson) => string = itemKey): StacItemJson[] {
    const seen = new Set<string>();
    return items.filter((i) => { const k = key(i); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Sorts items by properties (`datetime`, `eo:cloud_cover`, ...); undefined values last.
 *
 * Fields are compared in order until one differs: numbers numerically, anything else as strings (which sorts
 * RFC 3339 datetimes chronologically). `id` and `collection` read the item itself; other names read
 * `item.properties` (a `properties.` prefix is ignored). Missing and `null` values go last in both directions.
 *
 * @param items The items; the list is not modified.
 * @param sortby Sort keys, most significant first: `field` a property name, `direction` `"asc"` (default) or
 *   `"desc"`.
 * @returns A new, sorted list.
 * @example
 * ```ts
 * const sorted = sortItems(items, [{field: "eo:cloud_cover"}, {field: "datetime", direction: "desc"}]);
 * ```
 *
 * @category Selection helpers
 */
export function sortItems(items: StacItemJson[], sortby: {
    /** A property name, or `id` / `collection`. */
    field: string;
    /** `"asc"` or `"desc"`. Default `"asc"`. */
    direction?: "asc" | "desc";
}[]): StacItemJson[] {
    const get = (i: StacItemJson, f: string) => {
        const name = f.replace(/^properties\./, "");
        return name === "id" ? i.id : name === "collection" ? i.collection : i.properties[name];
    };
    return [...items].sort((a, b) => {
        for (const {field, direction = "asc"} of sortby) {
            const x = get(a, field), y = get(b, field);
            if (x === y) continue;
            if (x === undefined || x === null) return 1;
            if (y === undefined || y === null) return -1;
            const c = typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : 1;
            return direction === "desc" ? -c : c;
        }
        return 0;
    });
}
