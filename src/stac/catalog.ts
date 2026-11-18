/**
 * Capabilities and choice, the first two steps of the workflow, as implemented by {@link StacClient}:
 *
 * 1. `collections(filter)` and `collection(id)`: what a catalog offers (extents, bands, filterable properties).
 * 2. `check(selection, collection)`: problems found before any search; `select(selection)`: search and pick items.
 */
import type {RiaGeoTiffProblem} from "../errors.js";
import {isDataAsset, nameAssetBands} from "./bands.js";
import {StacError, type CollectionDescription, type Queryable, type StacClient} from "./client.js";
import type {WhereComparison} from "./cql2.js";
import {bboxOf, bboxesIntersect, coverageOf} from "./geometry.js";
import type {Bbox, GeoJsonArea, StacCollectionJson, StacItemJson} from "./json.js";
import {normaliseDatetime, type SearchPlan, type StacSearchRequest} from "./plan.js";
import {bestPerPeriod, coverArea, defaultScore, groupItems, itemsCovering, periodOf, solarLongitude, type Period} from "./select.js";
import type {StacProgress} from "./client.js";

/** A collection, summarised for choosing data; see {@link StacClient.collections}.
 *
 * @category Choosing data */
export interface CollectionSummary {
    /** The collection id, for searches. */
    id: string;
    /** Human-readable title, when the collection has one. */
    title?: string;
    /** Spatial extent `[west, south, east, north]` in degrees, when declared. */
    bbox?: Bbox;
    /** Temporal extent `[start, end]` as RFC 3339 strings; `null` for an open end. */
    interval: [string | null, string | null];
    /** Band names a model would get (EO common names, else asset keys), from the collection's item_assets. */
    bands: string[];
    /** Properties described by summaries (candidates for filters). */
    properties: string[];
    /**
     * Where the names in `bands` come from: `"common-names"` (the collection's item_assets give EO common names such
     * as `red` and `nir`, so presets fit), `"asset-keys"` (item_assets without common names, as INPE's: the names are
     * the asset keys), or `"none"` (no item_assets: `bands` is empty). A model made from the items names its bands
     * from the items themselves (`itemBandNames`), which may describe more than the collection does: its
     * `getBandNames()` is the final answer.
     */
    bandNaming: "common-names" | "asset-keys" | "none";
    /** Keywords of the collection, when declared. */
    keywords?: string[];
}

/** A collection in detail, see {@link StacClient.collection}: the summary plus queryables, assets and the JSON.
 *
 * @category Choosing data */
export interface CollectionDetails extends CollectionSummary {
    /** Longer description (CommonMark), when given. */
    description?: string;
    /** License identifier, when given. */
    license?: string;
    /** Properties a search can filter on (the queryables endpoint, else the summaries); empty when unknown. */
    queryables: Queryable[];
    /** Data assets declared in item_assets, with their bands. */
    assets: CollectionDescription["assets"];
    /** EO common names to asset keys (`{red: "B04"}`). */
    commonNames: Record<string, string>;
    /** The collection JSON. */
    raw: StacCollectionJson;
}

/** What you want from a collection: step 2 of the workflow, checked with {@link StacClient.check}.
 *
 * @category Choosing data */
export interface StacSelection {
    /** The collection id. */
    collection: string;
    /**
     * The area of interest: a bbox `[west, south, east, north]` or a GeoJSON (multi)polygon, in WGS 84 longitude
     * and latitude degrees. Without an area the search is not limited in space and `pick.coverage` is ignored.
     */
    area?: Bbox | GeoJsonArea;
    /**
     * A date or interval, in UTC, as the `datetime` of a search request: a partial date is the whole period
     * (`"2024"` is all of 2024, `"2024-06"` all of June), `"2018/2026"` runs from the start of 2018 to the end of
     * 2026, and `[start, null]` is open at the end. Dates without a time zone are taken as UTC.
     */
    datetime?: string | [string | null, string | null];
    /**
     * Band roles you need (`["red", "nir"]`). {@link StacClient.check} reports roles the collection does not offer;
     * the search itself does not use them, and neither does the model: it has every band of the items.
     */
    bands?: string[];
    /** Property predicates (`{"platform": {eq: "..."}}`), as the `where` of a search request. */
    where?: Record<string, WhereComparison>;
    /**
     * Maximum cloud cover in percent: a shorthand for `where: {"eo:cloud_cover": {lt: maxCloud}}` (strictly less
     * than). Items without `eo:cloud_cover` usually do not match: most servers leave them out.
     */
    maxCloud?: number;
    /**
     * Stop the search after this many items. Default 300. {@link StacClient.select} requests 100 items per page
     * (the server or the profile may lower it), so 300 items cost about 3 requests. `select` counts only items
     * with a GeoTIFF data asset: it skips the others (zipped or vector downloads, see `skipped`) and reads on, up
     * to {@link SELECT_SCAN_LIMIT} items in all.
     */
    maxItems?: number;
}

/**
 * How {@link StacClient.select} chooses among the items found. Default (`{}`): the one best item (least cloud,
 * then newest) whose footprint contains the whole area.
 *
 * The steps run in this order: `months` filters the items; `coverage` filters them when there is an area; then
 * either `per` picks the best item (or covering set) of each period, or, without `per`, one item (or one covering
 * set) is picked by `rank`.
 *
 * @category Choosing data */
export interface Pick {
    /**
     * With an area: `"full"` (default) keeps only items whose footprint contains the whole area, then picks the
     * best one (or the best per period). `"best"` keeps every item: when no item covers the area alone, the result
     * is the fewest items that together cover it (a mosaic, best ranked first, all in one coordinate reference as
     * with `per`); otherwise the best ranked among the items that cover nearly as much as the best one. Ignored
     * without an area.
     */
    coverage?: "full" | "best";
    /**
     * Which item is best. Default `"least-cloud"`: lowest `eo:cloud_cover` (50 when missing), then newest.
     * `"newest"` and `"oldest"` use the item's `datetime` (else `start_datetime`). `{closestTo}` takes the item
     * nearest in time to a `"MM-DD"` day of any year (a season) or to an RFC 3339 date. Ties keep the server order.
     */
    rank?: "least-cloud" | "newest" | "oldest" | {
        /** `"MM-DD"` for the item closest to that day of the year (across year ends too), or an RFC 3339 date. */
        closestTo: string;
    };
    /**
     * The best item (or covering set) per period: a time series, see {@link Period} for the periods and their
     * labels. A model needs one coordinate reference, so the candidates are first grouped by `proj:code` (or
     * `proj:epsg`) and one group is used (see {@link StacSelectionResult.dropped} for the rule); the items of the
     * other groups are reported in `dropped` and as a warning in `problems`. With `coverage: "best"` each period
     * keeps the set that covers most of the area, even when it covers it only partly.
     */
    per?: Period;
    /** Keep only items of these months (1–12, in UTC), e.g. a dry season. Items without a datetime are left out. */
    months?: number[];
}

/** What {@link StacClient.select} found and picked.
 *
 * @category Choosing data */
export interface StacSelectionResult {
    /** The picked items: for `GeoTiffTileSetModel.create({stac: {items}})`, or for the user to choose from. */
    items: StacItemJson[];
    /**
     * Period labels in time order, one per period kept (with `pick.per` only): `"2024"`, `"2024-07"`, ..., see
     * {@link periodOf}. `items` holds the items of these periods in the same order.
     */
    periods?: string[];
    /** Number of items the search returned with a GeoTIFF data asset (at most `maxItems`), before `pick` filtered them. */
    found: number;
    /**
     * Items the search returned without any GeoTIFF data asset (zipped files, vector or text downloads), which no
     * model can open: skipped, so that they do not use up `maxItems`, and not listed in `candidates`.
     */
    skipped: number;
    /** How the search was sent to the server, with its degradations. */
    plan: SearchPlan;
    /**
     * The warnings of {@link StacClient.check} (errors stop before the search), plus a warning with path `"pick"`
     * when candidates were dropped (see `dropped`).
     */
    problems: RiaGeoTiffProblem[];
    /**
     * Candidates left out because a model needs one coordinate reference, one entry per other reference: empty
     * when nothing was left out. This happens only when the result can hold several items (with `pick.per`, or
     * the mosaic of `coverage: "best"`) and the candidates have several `proj:code` (or `proj:epsg`) values.
     *
     * The reference group used is chosen deterministically: with an area, the group whose items together cover
     * most of it; then the group with most candidates; then the reference that sorts first. A single picked item
     * never drops anything.
     */
    dropped: {
        /** The coordinate reference of the dropped items (`proj:code`, `EPSG:{proj:epsg}`, or `"unknown"`). */
        reference: string;
        /** The dropped candidates, in search order. */
        items: StacItemJson[];
    }[];
    /**
     * Every item the search found, in search order, with how much of the area it covers, its period, and whether
     * it was picked or why not: for a list where the user sees every candidate and can change the choice.
     */
    candidates: StacCandidate[];
}

/** An item found by {@link StacClient.select}, as listed in {@link StacSelectionResult.candidates}.
 *
 * @category Choosing data */
export interface StacCandidate {
    /** The item. */
    item: StacItemJson;
    /** True when the item is in {@link StacSelectionResult.items}. */
    picked: boolean;
    /**
     * Why it was not picked (unset when picked), in the order the rules apply:
     * - `"months"`: its month is not in `pick.months`;
     * - `"coverage"`: with `coverage: "full"` (the default), its footprint does not contain the whole area;
     * - `"reference"`: its coordinate reference is not the one used, see {@link StacSelectionResult.dropped};
     * - `"rank"`: other items ranked better (or, in a mosaic, it added too little to the area covered).
     */
    reason?: "months" | "coverage" | "reference" | "rank";
    /** With an area: the fraction of the area its footprint covers (0..1, from {@link coverageOf}). */
    coverage?: number;
    /** With `pick.per`: its period label (see {@link periodOf}). */
    period?: string;
}

/**
 * Whether a collection looks like elevation (a terrain or surface model, bathymetry), from its metadata, and why.
 *
 * STAC has no field that says so, so this reads what catalogs write: the keywords (`Elevation`, `DEM`, `DSM`), the
 * title and description ("digital terrain model", "digital elevation model", "surface model", DEM / DTM / DSM,
 * bathymetry) and the `item_assets` keys (`dem`, `dtm`, `dsm`, `elevation`). Derived products are not elevation:
 * vegetation or canopy height, relief shading and hillshade. A hint, not a guarantee: open such a collection with
 * `dataType: RasterDataType.ELEVATION` when it is right for you.
 *
 * @param collection The collection JSON (`CollectionDetails.raw`, or a collection of `StacClient.listCollections`).
 * @returns The evidence (`'its description says "digital terrain model"'`), or `null` when nothing points to elevation.
 *
 * @example
 * ```ts
 * import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
 *
 * const details = await client.collection(collectionId);
 * const hint = elevationHint(details.raw);
 * const dataType = hint ? RasterDataType.ELEVATION : RasterDataType.IMAGE;   // and say why: hint
 * ```
 *
 * @category Choosing data
 */
export function elevationHint(collection: StacCollectionJson): string | null {
    const title = collection.title ?? "";
    const description = collection.description ?? "";
    // Products derived from heights, which are not the ground: no terrain.
    const derived = /\b(vegetation|canopy|tree|building)s? height|relief shading|shaded relief|hill ?shad/i;
    if (derived.test(title) || derived.test(collection.id)) return null;
    const keyword = (collection.keywords ?? []).find((k) => /^(elevation|dem|dtm|dsm|terrain|bathymetry|topography)$/i.test(k.trim()));
    if (keyword) return `its keywords include "${keyword}"`;
    const phrase = /\b(digital )?(terrain|elevation|surface|height) model\b|\bbathymetr\w*|\b(DEM|DTM|DSM)s?\b/;
    for (const [where, text] of [["title", title], ["description", description]] as const) {
        const words = phrase.exec(text) ?? (/\b(digital (terrain|elevation|surface) model|bathymetr\w*)/i.exec(text));
        if (words && !(where === "description" && derived.test(description.slice(0, 200)))) return `its ${where} says "${words[0]}"`;
    }
    const key = Object.keys(collection.item_assets ?? {}).find((k) => /^(dem|dtm|dsm|elevation|height)$/i.test(k));
    return key ? `its items have an asset "${key}"` : null;
}

/**
 * Band names a collection's items would give (from item_assets), as the bridge names them.
 *
 * The rule is the one of {@link itemBandNames} and {@link assetBandMap}, applied to the collection's data assets: a
 * single-band asset gives its EO common name when no other asset shares it, else its key; a multiband asset gives
 * one name per band (common name, else name, else `{key}_b{n}`); names are made valid identifiers; `nir08` /
 * `lwir11` become `nir` / `lwir` when those are free. Items can describe their assets differently from the
 * collection, so the result is an estimate of what an item gives.
 *
 * @param description The collection, as described by `describeCollectionJson` (or `StacClient.describeCollection`).
 * @returns Band names, in asset order; empty when the collection has no item_assets.
 * @example
 * ```ts
 * const collectionJson: StacCollectionJson = ...; // a collection read from a catalog
 * const bands = collectionBands(describeCollectionJson(collectionJson));
 * const canNdvi = bands.includes("red") && bands.includes("nir");
 * ```
 *
 * @category Choosing data
 */
export function collectionBands(description: CollectionDescription): string[] {
    return Object.values(nameAssetBands(description.assets)).flat();
}

/**
 * A collection description as a summary.
 *
 * @internal
 *
 * @category Choosing data
 */
export function summarise(d: CollectionDescription): CollectionSummary {
    return {
        id: d.id, title: d.title, bbox: d.bbox, interval: d.interval, bands: collectionBands(d), properties: Object.keys(d.summaries),
        bandNaming: d.assets.some((a) => a.bands.some((b) => b.commonName !== undefined)) ? "common-names"
            : d.assets.length ? "asset-keys" : "none",
        keywords: d.keywords,
    };
}

/**
 * Problems of a selection against a collection (no network).
 *
 * @internal
 *
 * @category Choosing data
 */
export function checkSelection(selection: StacSelection, collection: CollectionDetails | undefined): RiaGeoTiffProblem[] {
    const problems: RiaGeoTiffProblem[] = [];
    if (!collection) return [{path: "collection", severity: "error", message: `the catalog has no collection "${selection.collection}"`}];
    if (selection.area && collection.bbox && !bboxesIntersect(bboxOf(selection.area), collection.bbox)) {
        problems.push({path: "area", severity: "error", message: `outside the collection's extent ${collection.bbox.map((v) => v.toFixed(2)).join(", ")}`});
    }
    const dt = normaliseDatetime(selection.datetime);
    if (dt) {
        const [a, b] = dt.includes("/") ? dt.split("/") : [dt, dt];
        const start = a === ".." ? -Infinity : Date.parse(a), end = b === ".." ? Infinity : Date.parse(b);
        const c0 = collection.interval[0] ? Date.parse(collection.interval[0]) : -Infinity, c1 = collection.interval[1] ? Date.parse(collection.interval[1]) : Infinity;
        if (start > c1 || end < c0) {
            problems.push({path: "datetime", severity: "error", message: `outside the collection's period ${collection.interval[0] ?? ".."} – ${collection.interval[1] ?? ".."}`});
        }
    }
    if (selection.bands?.length) {
        const missing = selection.bands.filter((b) => !collection.bands.includes(b));
        if (!collection.bands.length || collection.bandNaming !== "common-names") {
            // Collections often describe their assets less than their items do (INPE: item_assets without common names).
            if (missing.length) problems.push({path: "bands", severity: "warning", message: `the collection does not name its bands by role (assets: ${collection.bands.join(", ") || "not described"}): ${missing.join(", ")} can only be checked on the items`});
        } else if (missing.length) {
            problems.push({path: "bands", severity: "error", message: `not offered: ${missing.join(", ")} (available: ${collection.bands.join(", ")})`});
        }
    }
    // Only the server's own queryables count: collection summaries are often incomplete.
    const queryables = collection.queryables.filter((q) => q.source === "queryables").map((q) => q.name);
    const filtered = [...Object.keys(selection.where ?? {}), ...(selection.maxCloud !== undefined ? ["eo:cloud_cover"] : [])];
    for (const p of filtered) {
        if (queryables.length && !queryables.includes(p)) {
            problems.push({path: p === "eo:cloud_cover" && selection.maxCloud !== undefined ? "maxCloud" : `where.${p}`, severity: "warning",
                message: `the collection does not describe "${p}": items may lack it, and a filter on it may remove everything`});
        }
    }
    return problems;
}

/**
 * Item score for a rank (lower is better).
 *
 * @internal
 *
 * @category Choosing data
 */
export function rankOf(rank: Pick["rank"]): (i: StacItemJson) => number {
    const time = (i: StacItemJson) => Date.parse(String(i.properties.datetime ?? i.properties.start_datetime ?? ""));
    if (rank === "newest") return (i) => -time(i);
    if (rank === "oldest") return time;
    if (rank && typeof rank === "object") {
        const target = rank.closestTo;
        if (/^\d{2}-\d{2}$/.test(target)) {
            const [m, d] = target.split("-").map(Number);
            // The nearest occurrence of the day: in the item's year, the year before or the year after.
            return (i) => {
                const t = time(i), y = new Date(t).getUTCFullYear();
                return Math.min(...[y - 1, y, y + 1].map((year) => Math.abs(t - Date.UTC(year, m - 1, d))));
            };
        }
        const t0 = Date.parse(target);
        return (i) => Math.abs(time(i) - t0);
    }
    return defaultScore;
}

/**
 * The search request {@link StacClient.select} sends for a selection, for listing every item it would consider
 * ("all items found, no pick") with the same filters: the collection, `area`, `datetime`, `where` and `maxCloud`
 * (as `where: {"eo:cloud_cover": {lt: maxCloud}}`, merged with `where`), 100 items per page, up to `maxItems`
 * (default 300). `bands` and `pick` are not part of the search.
 *
 * @param selection The selection.
 * @returns A new request for {@link StacClient.search}.
 * @example
 * ```ts
 * const selection: StacSelection = {collection: id, area, datetime: "2024", maxCloud: 20};   // what the user chose
 * const everything = await catalog.search(selectionToRequest(selection)).collect();         // catalog: a StacClient
 * ```
 *
 * @category Choosing data
 */
export function selectionToRequest(selection: StacSelection): StacSearchRequest {
    const where = {...(selection.where ?? {}), ...(selection.maxCloud !== undefined ? {"eo:cloud_cover": {lt: selection.maxCloud}} : {})};
    return {
        collections: [selection.collection], ...(selection.area ? {area: selection.area} : {}),
        ...(selection.datetime !== undefined ? {datetime: selection.datetime} : {}),
        ...(Object.keys(where).length ? {where} : {}), limit: 100, maxItems: selection.maxItems ?? 300,
    };
}

/**
 * How many items {@link StacClient.select} reads at most, counting the ones it skips for having no GeoTIFF data
 * asset (see {@link StacSelectionResult.skipped}): 2000, about 20 requests of 100.
 *
 * @category Choosing data
 */
export const SELECT_SCAN_LIMIT = 2000;

/**
 * Searches and picks items for a selection.
 *
 * @internal
 *
 * @category Choosing data
 */
export async function selectItems(client: StacClient, selection: StacSelection & { pick?: Pick },
    options: { signal?: AbortSignal; onProgress?: (progress: StacProgress) => void } = {}): Promise<StacSelectionResult> {
    const {signal, onProgress} = options;
    onProgress?.({step: "collection", pages: 0, scanned: 0, kept: 0});
    const details = await client.collection(selection.collection).catch(() => undefined);
    if (signal?.aborted) throw signal.reason;
    const problems = checkSelection(selection, details);
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) {
        throw new StacError(`The selection does not fit ${selection.collection}: ${errors.map((p) => `${p.path}: ${p.message}`).join("; ")}`,
            undefined, undefined, undefined, problems);
    }
    let last: StacProgress = {step: "search", pages: 0, scanned: 0, kept: 0};
    // Only items with a GeoTIFF data asset count towards maxItems: catalogs such as swisstopo's list hundreds of
    // zipped tiles beside the one COG, which would otherwise fill the result and hide it.
    const limit = selection.maxItems ?? 300;
    const request = {...selectionToRequest(selection), maxItems: Math.max(limit, SELECT_SCAN_LIMIT)};
    const search = client.search(request, {signal, onProgress: (p) => { last = p; onProgress?.(p); }});
    const found: StacItemJson[] = [];
    let skipped = 0;
    for await (const item of search.items()) {
        if (!Object.entries(item.assets ?? {}).some(([key, asset]) => isDataAsset(key, asset))) skipped++;
        else if (found.push(item) >= limit) break;
    }
    if (signal?.aborted) throw signal.reason;
    onProgress?.({...last, step: "pick"});
    const pick = selection.pick ?? {};
    const area = selection.area;
    const records = new Map<StacItemJson, StacCandidate>(found.map((item) => [item, {
        item, picked: false,
        ...(area ? {coverage: coverageOf(item, area)} : {}),
        ...(pick.per ? {period: periodOf(item, pick.per, solarLongitude(item))} : {}),
    }]));
    const exclude = (items: StacItemJson[], reason: NonNullable<StacCandidate["reason"]>) => {
        for (const item of items) { const r = records.get(item); if (r && !r.picked && !r.reason) r.reason = reason; }
    };
    let candidates = found;
    if (pick.months?.length) {
        const kept = candidates.filter((i) => pick.months!.includes(new Date(String(i.properties.datetime ?? i.properties.start_datetime)).getUTCMonth() + 1));
        exclude(candidates.filter((i) => !kept.includes(i)), "months");
        candidates = kept;
    }
    const coverage = pick.coverage ?? "full";
    if (area && coverage === "full") {
        const kept = itemsCovering(candidates, area);
        exclude(candidates.filter((i) => !kept.includes(i)), "coverage");
        candidates = kept;
    }
    if (!candidates.length) {
        const without = skipped ? `; ${skipped} more had no GeoTIFF data asset (zipped or vector downloads) and were skipped` : "";
        throw new StacError(`No ${selection.collection} item meets the selection (${found.length} found by the search${without})`,
            undefined, undefined, undefined, [...problems, ...emptyReasons(found, [...records.values()], selection, search.rejected)]);
    }
    const score = rankOf(pick.rank);
    const result = (items: StacItemJson[], dropped: StacSelectionResult["dropped"] = []): StacSelectionResult => {
        for (const item of items) { const r = records.get(item); if (r) { r.picked = true; delete r.reason; } }
        for (const d of dropped) exclude(d.items, "reference");
        exclude(found, "rank");
        return {
            items, found: found.length, skipped, plan: search.plan, dropped, candidates: [...records.values()],
            problems: dropped.length ? [...problems, {path: "pick", severity: "warning",
                message: `left out ${dropped.reduce((n, d) => n + d.items.length, 0)} item(s) in ${dropped.map((d) => d.reference).join(", ")}: a model needs one coordinate reference`}] : problems,
        };
    };
    if (pick.per) {
        const {items: group, dropped} = oneReference(candidates, area);
        const periods = bestPerPeriod(group, {period: pick.per, score, ...(area && coverage === "best" ? {area, minCoverage: 0} : {})});
        return {...result(periods.flatMap((p) => p.items), dropped), periods: periods.map((p) => p.period)};
    }
    if (area && coverage === "best") {
        const best = Math.max(...candidates.map((i) => records.get(i)?.coverage ?? coverageOf(i, area)));
        if (best < 0.99) {
            // No item covers the area alone: the fewest items that together cover it, a mosaic in one reference.
            const {items: group, dropped} = oneReference(candidates, area);
            return result(coverArea(group, area, {score}).items, dropped);
        }
        candidates = candidates.filter((i) => (records.get(i)?.coverage ?? 0) >= best - 0.05);
    }
    return result([[...candidates].sort((a, b) => score(a) - score(b))[0]]);
}

/** When no item is left: one warning per rule that excluded items, saying what to relax. */
function emptyReasons(found: StacItemJson[], records: StacCandidate[], selection: StacSelection & { pick?: Pick },
    rejected: Record<string, number>): RiaGeoTiffProblem[] {
    if (!found.length) {
        // Requirements tested in the browser (static catalogs, items endpoints, client-side filters): how many items each excluded.
        const counted = Object.entries(rejected).filter(([, n]) => n > 0);
        if (counted.length) {
            const read = counted.reduce((n, [, c]) => n + c, 0);
            return counted.map(([key, n]) => ({
                path: key === "where.eo:cloud_cover" && selection.maxCloud !== undefined && !selection.where?.["eo:cloud_cover"] ? "maxCloud" : key,
                severity: "warning" as const,
                message: `excluded ${n} of the ${read} item(s) read: widen it to keep them`,
            }));
        }
        const filters = [selection.area ? "the area" : "", selection.datetime ? "the period (datetime)" : "",
            selection.maxCloud !== undefined ? "maxCloud" : "", ...Object.keys(selection.where ?? {}).map((k) => `where.${k}`)].filter(Boolean);
        return [{path: "", severity: "warning", message: `the search found no item${filters.length ? `: widen ${filters.join(", ")}` : ""}`}];
    }
    const out: RiaGeoTiffProblem[] = [];
    const months = records.filter((r) => r.reason === "months").length;
    if (months) out.push({path: "pick.months", severity: "warning", message: `excluded ${months} of ${found.length} item(s) found: none of their months is in [${selection.pick!.months!.join(", ")}]`});
    const partial = records.filter((r) => r.reason === "coverage");
    if (partial.length) {
        const best = Math.max(...partial.map((r) => r.coverage ?? 0));
        out.push({path: "pick.coverage", severity: "warning",
            message: `excluded ${partial.length} of ${found.length} item(s) found: none covers the whole area (the best covers ${Math.round(best * 100)} %); use coverage "best" for a mosaic`});
    }
    return out;
}

/**
 * The candidates of one coordinate reference, and the others: with an area the group covering most of it, then the
 * largest group, then the reference that sorts first.
 */
function oneReference(candidates: StacItemJson[], area: StacSelection["area"]): { items: StacItemJson[]; dropped: StacSelectionResult["dropped"] } {
    const groups = [...groupItems(candidates, "crs").entries()];
    if (groups.length === 1) return {items: candidates, dropped: []};
    const covered = new Map(groups.map(([ref, items]) => [ref, area ? coverArea(items, area, {target: 1, minGain: 0}).coverage : 0]));
    groups.sort(([a, x], [b, y]) => covered.get(b)! - covered.get(a)! || y.length - x.length || (a < b ? -1 : a > b ? 1 : 0));
    return {items: groups[0][1], dropped: groups.slice(1).map(([reference, items]) => ({reference, items}))};
}
