/**
 * The STAC source of `GeoTiffTileSetModel.create()`: items the user chose (or a selection to search), grouped by
 * period into a mosaic (one period) or a time series (several), with only the assets the style reads.
 */
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import type {BandInput, CreateModelOptions, Resampling} from "../GeoTiffTileSetModel.js";
import {accessFetch, discoveredInputs, originOf, type AccessHook} from "../http.js";
import {expressionBands, toExpressionNode} from "../rs/expression.js";
import {compileStyle} from "../rs/render.js";
import type {BandStyle} from "../rs/style.js";
import {autoStyle} from "../sources/autoStyle.js";
import {assetBandMap, bandInputsOf} from "./bridge.js";
import type {Pick, StacSelection} from "./catalog.js";
import {StacClient, StacError} from "./client.js";
import type {StacItemJson} from "./json.js";
import type {SearchPlan} from "./plan.js";
import {periodOf, solarLongitude, type Period} from "./select.js";

/** How the assets of STAC items become bands; part of {@link StacModelSource}.
 *
 * @category Choosing data */
export interface StacItemOptions {
    /**
     * Asset keys to use, all opened by `create`. Default: every data asset; those holding the bands the style (or the
     * elevation height) reads are opened by `create`, the others when a later style first reads their bands (see
     * {@link StacModelSource}).
     */
    assets?: string[];
    /**
     * Band names: the EO common name (`red`, `nir`, ... so presets work on every catalog), or the asset key.
     * Default `"common-name"`, falling back to the asset key.
     */
    naming?: "common-name" | "asset-key";
    /** Band names per asset key, overriding the catalog's (`{visual: ["red", "green", "blue"]}`). */
    bandNames?: Record<string, string | string[]>;
    /** Resampling per asset key, overriding the metadata-based choice (nearest for classes and masks). */
    resampling?: Record<string, Resampling>;
    /**
     * Decides which credentials, headers and parameters the assets (COGs) get. By default they get none of the
     * model's: the API's token is not the storage's, and assets are reached through `signers` instead.
     *
     * Called before every request to an asset (header and range requests), with kind `"stac-asset"`, so it can
     * return a renewed token. Return `null` for requests that should get nothing.
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     *
     * const map = ...;                         // your LuciadRIA WebGLMap
     * const chosenItems: StacItemJson[] = ...; // items the user ticked, from catalog.select(...)
     * const storageHost = ...;                 // host name of the storage that holds the assets
     * const storageToken = (): string => ...;  // the application's current token for that storage
     * const model = await GeoTiffTileSetModel.create({stac: {
     *   items: chosenItems,
     *   assetAccess: (url) => (url.hostname === storageHost
     *     ? {requestHeaders: {Authorization: `Bearer ${storageToken()}`}} : null),
     * }});
     * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Protected assets"}));
     * ```
     */
    assetAccess?: AccessHook;
}

/** The STAC items the user chose, as a source of {@link GeoTiffTileSetModel.create}.
 *
 * @category Choosing data */
export interface StacItemsSource extends StacItemOptions {
    /**
     * The items: item JSON, or item URLs that are fetched once each, in parallel, with the HTTP options of the
     * model. At least one. All items used in one model must share a coordinate reference, otherwise `GeoTiffTileSetModel.create`
     * rejects with `REFERENCE_MISMATCH`: group them first with `groupItems(items, "crs")`.
     */
    items: StacItemJson[] | string[];
    /**
     * The period that groups the items (see {@link Period}): items of one period are a **mosaic** (bands `red`,
     * `nir`; the first item with data wins), several periods a **time series**. In a time series every band name
     * gets the period label as a suffix, with characters other than letters, digits and `_` replaced by `_`:
     * `red_2024` (year), `red_2024_07` (month), `red_2024_Q3`, `red_2024_W29`, `red_2024_07_15` (day). Where items
     * of one period overlap, the first in the given order wins. With `"solar-day"` each item's day is taken at its
     * own centre longitude ({@link solarLongitude}), as `StacClient.select` does. Default `"day"`.
     */
    per?: Period;
}

/** A selection to search and pick, as a source of {@link GeoTiffTileSetModel.create}: `catalog.select(selection)`.
 *
 * @category Choosing data */
export interface StacCatalogSource extends StacSelection, StacItemOptions {
    /**
     * The catalog: a connected client, or the URL of a STAC API. A URL is connected with the model's
     * `credentials`, `requestHeaders`, `requestParameters` and `access` hook, and otherwise default client
     * options; pass a connected client for other options (`rewriteUrl`, `pageSize`, a saved profile).
     */
    catalog: StacClient | string;
    /**
     * Which of the items found are used, see {@link Pick}. With `pick.per` the items are grouped by that period
     * (a time series when there are several); without it, the picked items are one mosaic, whatever their dates.
     */
    pick?: Pick;
}

/**
 * STAC as a source of {@link GeoTiffTileSetModel.create}: the items the user chose ({@link StacItemsSource}), or a
 * selection to search and pick ({@link StacCatalogSource}).
 *
 * The model has a band for every data asset of the items (`getBandNames()` lists them all), but `create` opens
 * only the assets the style (or the elevation height) reads. The others are opened, once, when a style first reads
 * them: `setStyle`, `withStyle` and `asElevation` then read those COG headers before they resolve. So a preset
 * that needs `swir16` works on a model created with a true-colour style. `getBands()` lists the opened bands only.
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const chosenItems: StacItemJson[] = ...; // items the user ticked, from catalog.select(...)
 * const model = await GeoTiffTileSetModel.create({stac: {items: chosenItems, per: "year"}});
 * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Time series"}));
 * console.log(model.getSource().periods);  // ["2023", "2024"]: bands red_2023, red_2024, ...
 * ```
 *
 * @category Choosing data
 */
export type StacModelSource = StacItemsSource | StacCatalogSource;

/**
 * Inputs, style and source description of a STAC source.
 *
 * @internal
 *
 * @category Choosing data
 */
export async function resolveStac(source: StacModelSource, options: CreateModelOptions, itemOrigin?: string | null): Promise<{
    inputs: BandInput[];
    /** Inputs opened when a style first reads their bands (a subset of `inputs`). */
    deferred: Set<BandInput>;
    style?: CreateModelOptions["style"];
    info: { items: StacItemJson[]; periods?: string[]; plan?: SearchPlan; found?: number };
}> {
    if (!source || typeof source !== "object") throw new RangeError("stac must be {items} or {catalog, collection}");
    let items: StacItemJson[];
    let per: Period | undefined;
    const info: { plan?: SearchPlan; found?: number } = {};
    if ("items" in source && source.items !== undefined) {
        if (!Array.isArray(source.items) || source.items.length === 0) throw new RangeError("stac.items needs at least one item");
        items = await Promise.all((source.items as (StacItemJson | string)[]).map((i) => (typeof i === "string" ? fetchItem(i, options, itemOrigin) : i)));
        per = source.per ?? "day";
    } else {
        const s = source as StacCatalogSource;
        if (!s.catalog) throw new RangeError("stac needs items, or a catalog and a collection");
        const client = typeof s.catalog === "string"
            ? await StacClient.connect(s.catalog, {credentials: options.credentials, requestHeaders: options.requestHeaders,
                requestParameters: options.requestParameters, ...(options.access ? {access: options.access} : {}),
                ...(options.onRequest ? {onRequest: options.onRequest} : {})})
            : s.catalog;
        const {catalog: _c, assets: _a, naming: _n, bandNames: _b, resampling: _r, assetAccess: _x, ...selection} = s;
        const result = await client.select(selection);
        items = result.items;
        info.plan = result.plan;
        info.found = result.found;
        per = s.pick?.per;
    }

    // Items of one period are a mosaic; several periods a time series.
    const groups = new Map<string, StacItemJson[]>();
    for (const item of items) {
        // Solar days at the item's own centre longitude: the rule of select and groupItems.
        const key = per ? periodOf(item, per, solarLongitude(item)) : "";
        groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const periods = [...groups.keys()].sort();
    const series = periods.length > 1;
    const suffix = (period: string) => period.replace(/[^A-Za-z0-9_]/g, "_");
    const rename = (period: string) => (series ? (b: string) => `${b}_${suffix(period)}` : undefined);
    const naming = {naming: source.naming, bandNames: source.bandNames};
    const slices = periods.flatMap((period) => groups.get(period)!.map((item) => ({period, item,
        map: assetBandMap(item, {...naming, assets: source.assets, rename: rename(period)})})));
    const names = [...new Set(slices.flatMap((s) => Object.values(s.map).flat()))];
    if (names.length === 0) {
        // Say what the items do hold: usually zipped or vector downloads (GeoPackage, INTERLIS, Shapefile), not COGs.
        const held = [...new Set(items.flatMap((i) => Object.entries(i.assets ?? {}).map(([k, a]) => `${k}${a.type ? ` (${a.type})` : ""}`)))];
        throw new RangeError(`The STAC items have no GeoTIFF data assets${source.assets ? ` among ${source.assets.join(", ")}` : ""}`
            + (held.length ? `; they hold ${held.slice(0, 4).join(", ")}${held.length > 4 ? ` and ${held.length - 4} more` : ""}` : "; they hold no assets")
            + ". A model needs Cloud Optimized GeoTIFF assets (image/tiff), not zipped or vector files.");
    }

    // The style (or height) decides which assets are opened.
    let style: CreateModelOptions["style"];
    let required: Set<string> | null = null;
    if (options.bands) {
        // Locations name the bands: the style refers to those names, known once the inputs are open.
        style = options.style;
    } else if (options.dataType === RasterDataType.ELEVATION) {
        const height = options.elevation?.height?.trim();
        if (height) {
            required = /^[A-Za-z_][A-Za-z0-9_]*$/.test(height) ? new Set([height]) : expressionBands(toExpressionNode(height));
        }
    } else {
        const resolved = options.style === undefined ? defaultStacStyle(names, series ? suffix(periods[periods.length - 1]) : null)
            : typeof options.style === "function" ? options.style(names) : options.style;
        required = new Set(compileStyle(resolved, names).requiredBands);
        style = resolved;
    }
    if (options.bands || source.assets) required = null;   // locations refer to every input; assets are explicit

    const inputs: BandInput[] = [];
    const deferred = new Set<BandInput>();
    for (const {period, item, map} of slices) {
        for (const key of Object.keys(map)) {
            const later = required !== null && !map[key].some((n) => required!.has(n));
            let input: BandInput;
            try {
                [input] = bandInputsOf(item, {...naming, assets: [key], resampling: source.resampling, rename: rename(period),
                    signers: options.signers}, options.rewriteUrl !== undefined);
            } catch (e) {
                // An asset the style does not read and a browser cannot read (s3:// only, requester pays): no band.
                if (later && e instanceof RangeError) continue;
                throw e;
            }
            // Assets are discovered URLs: no credentials, headers or parameters unless assetAccess gives them.
            discoveredInputs.set(input, {kind: "stac-asset", origin: null, hook: source.assetAccess});
            inputs.push(input);
            if (later) deferred.add(input);
        }
    }
    if (inputs.length === deferred.size) throw new RangeError(`No asset of the STAC items holds the bands needed: ${[...required ?? []].join(", ")}`);
    return {inputs, deferred, style, info: {items, ...(series ? {periods} : {}), ...info}};
}

/** True colour when possible (of the last period for a time series), else the first band in grey. */
function defaultStacStyle(names: string[], lastPeriod: string | null): BandStyle {
    if (!lastPeriod) return autoStyle(names);
    const [r, g, b] = ["red", "green", "blue"].map((c) => `${c}_${lastPeriod}`);
    if ([r, g, b].every((n) => names.includes(n))) {
        return {render: {type: "rgb", red: r, green: g, blue: b, stretch: {type: "percentile", low: 1, high: 99}}};
    }
    const first = names.find((n) => n.endsWith(`_${lastPeriod}`)) ?? names[0];
    return {render: {type: "pseudocolor", band: first, stretch: {type: "percentile", low: 2, high: 98}}};
}

async function fetchItem(url: string, options: CreateModelOptions, itemOrigin: string | null | undefined): Promise<StacItemJson> {
    let response: Response;
    const access = options.access ? options.access(new URL(url), "stac-api")
        : itemOrigin === undefined || originOf(url) === itemOrigin ? options : null;
    try {
        response = await accessFetch(url, access, {}, fetch, {onRequest: options.onRequest, kind: "stac-api"});
    } catch (e) {
        throw new StacError(`Cannot fetch STAC item ${url}: ${(e as Error).message}`, undefined, url);
    }
    if (!response.ok) throw new StacError(`Cannot fetch STAC item ${url}: HTTP ${response.status}`, response.status, url);
    return await response.json() as StacItemJson;
}
