/**
 * The ria-geotiff manifest: the options of `GeoTiffTileSetModel.create()` as a JSON file, ready for an application
 * to open with `GeoTiffTileSetModel.create({manifest})`. Same keys (`inputs`, `bands`, `style`, `dataType`, `tileSize`, ...), plus what
 * only a file needs: `type` and `version`, a title and description, named `styles`, URLs relative to the file, and
 * JSON stand-ins for what JSON cannot hold (`"sign": "planetary-computer"` for a signing function, `"nodata": "nan"`
 * for NaN, `"dataType": "elevation"` for `RasterDataType.ELEVATION`).
 *
 * Instead of `inputs`, a manifest may give a `stac` source: item URLs, or a catalog and a selection.
 * Specification: docs/manifest.md. JSON Schema: schema/ria-geotiff-stack-1.schema.json.
 */
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import type {BandInput, CreateModelOptions, ElevationOptions, GeoTiffTileSetModel, ResolvedInput} from "../GeoTiffTileSetModel.js";
import {modelInputs} from "../GeoTiffTileSetModel.js";
import type {HttpAccessOptions} from "../fileutils.js";
import {accessFetch, discoveredInputs, originOf, type AccessHook, type RiaGeoTiffRequest, type RiaGeoTiffRequestListener} from "../http.js";
import {RiaGeoTiffError, type RiaGeoTiffProblem} from "../errors.js";
import {resolveReference} from "../shared.js";
import type {BandStyle} from "../rs/style.js";
import type {Bbox, GeoJsonArea} from "../stac/json.js";
import type {Period} from "../stac/select.js";

/** The value of the `type` property of every manifest: `"ria-geotiff/stack"`.
 *
 * @category Manifests */
export const MANIFEST_TYPE = "ria-geotiff/stack";

/** A {@link BandInput} in JSON: `url` may be relative to the manifest; `sign` and `nodata: "nan"` stand in for non-JSON values.
 *
 * @category Manifests */
export interface ManifestInput extends Omit<BandInput, "url" | "file" | "sign" | "nodata"> {
    /** URL of the COG: absolute, or relative to the manifest (or to the `base` option). */
    url: string;
    /** Raw value that marks missing data; `"nan"` stands for NaN, `null` for none. Default: the file's GDAL_NODATA tag. */
    nodata?: number | "nan" | null;
    /** `"planetary-computer"` signs the URL with Microsoft Planetary Computer SAS tokens (see {@link BandInput.sign}). */
    sign?: "planetary-computer";
}

/**
 * A STAC source in JSON: item URLs (relative to the manifest or absolute), or a catalog URL and a selection. The
 * JSON form of {@link StacModelSource}.
 *
 * @category Manifests
 */
export interface ManifestStacSource {
    /** URLs of STAC items (instead of `catalog`), fetched when the manifest is opened. */
    items?: string[];
    /** The period that groups items: items of one period are a mosaic, several periods a time series. Default `"day"`. */
    per?: Period;
    /** Asset keys to use. Default: the assets the style reads. */
    assets?: string[];
    /** Band names: EO common names (default) or asset keys. */
    naming?: "common-name" | "asset-key";
    /** Band names per asset key, overriding the catalog's (`{"visual": ["red", "green", "blue"]}`). */
    bandNames?: Record<string, string | string[]>;
    /** Resampling per asset key, overriding the metadata-based choice. */
    resampling?: Record<string, "nearest" | "bilinear">;
    /** URL of a STAC API to search (instead of `items`). */
    catalog?: string;
    /** Id of the collection to search (with `catalog`). */
    collection?: string;
    /** Area of interest: a `[west, south, east, north]` bounding box in longitude/latitude, or a GeoJSON (Multi)Polygon. */
    area?: Bbox | GeoJsonArea;
    /** Date or period of the items: a STAC datetime string, or `[start, end]` with null for an open end. */
    datetime?: string | [string | null, string | null];
    /** Filters on item properties, per property a comparison such as `{"lt": 20}` (`eq`, `lt`, `in`, `between`, ...). */
    where?: Record<string, Record<string, unknown>>;
    /** Maximum cloud cover in percent (a shorthand for a `where` on `eo:cloud_cover`). */
    maxCloud?: number;
    /** Band roles the collection must offer (`["red", "nir"]`), checked before the search. */
    bands?: string[];
    /** Stop the search after this many items. Default 300. */
    maxItems?: number;
    /** Which of the items found are used: the `Pick` of `StacClient.select`. */
    pick?: {
        /** Items whose footprint contains the whole area ("full", default with an area), or the best covering ones. */
        coverage?: "full" | "best";
        /** Default least-cloud (then newest). `closestTo` takes a "MM-DD" day of the year (the season) or a date. */
        rank?: "least-cloud" | "newest" | "oldest" | {
            /** A "MM-DD" day of the year (the season) or a date: items closest to it rank first. */
            closestTo: string;
        };
        /** Items per period: a time series with bands named `${band}_${period}`. */
        per?: Period;
        /** Keep only items of these months (1–12), e.g. a dry season. */
        months?: number[];
    };
}

/** Model options that a manifest may set (the JSON ones of {@link CreateModelOptions}). */
// Headers and parameters (secrets) are never part of a manifest: they are passed when opening it.
const MODEL_OPTIONS = ["tileSize", "cacheSize", "byteCacheSize", "statisticsSize", "decodedBlocks", "credentials", "bands", "elevation"] as const;

/**
 * A ria-geotiff manifest (`"type": "ria-geotiff/stack"`, version 1): the JSON form of {@link CreateModelOptions}.
 * It also holds the JSON model options `tileSize`, `cacheSize`, `byteCacheSize`, `statisticsSize`, `decodedBlocks`,
 * `credentials` (a mode, not a secret), `bands` (band names by 1-based location, `{"red": "f1_b3"}`) and
 * `elevation`, documented on {@link CreateModelOptions}, and `reference` as an identifier. `requestHeaders` and `requestParameters` are never in a manifest: secrets are
 * passed when opening it.
 *
 * Give either `inputs` or `stac`, not both.
 *
 * @category Manifests
 */
export interface StackManifest extends Partial<Pick<CreateModelOptions, typeof MODEL_OPTIONS[number]>> {
    /** URL of the JSON Schema, for editors. Not used when opening. */
    $schema?: string;
    /** Always {@link MANIFEST_TYPE}. */
    type: typeof MANIFEST_TYPE;
    /** Version of the manifest format: 1. */
    version: 1;
    /** Title of the data, for display. */
    title?: string;
    /** Description of the data, for display. */
    description?: string;
    /** Attribution or copyright notice of the data, for display. */
    attribution?: string;
    /** `"image"` (default) or `"elevation"`: the {@link CreateModelOptions.dataType}. */
    dataType?: "image" | "elevation";
    /**
     * The {@link CreateModelOptions.reference} as a LuciadRIA reference identifier (`"EPSG:32633"`, `"CRS:1"` for
     * pixel coordinates), resolved with `getReference` when the manifest is opened. Default: the files' own
     * reference.
     */
    reference?: string;
    /** The COGs that provide the bands (instead of `stac`). */
    inputs?: ManifestInput[];
    /** STAC items, or a STAC search, that give the inputs when the manifest is opened (instead of `inputs`). */
    stac?: ManifestStacSource;
    /** The style the model opens with (imagery). Default: {@link autoStyle}. */
    style?: BandStyle;
    /** Further named styles, for a style picker. */
    styles?: Record<string, BandStyle>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN = new Set(["$schema", "type", "version", "title", "description", "attribution", "dataType", "reference", "inputs", "stac", "style",
    "styles", ...MODEL_OPTIONS]);
const INPUT_KEYS = new Set(["url", "bands", "scale", "offset", "nodata", "resampling", "sign", "crsName"]);
const STAC_KEYS = new Set(["items", "per", "assets", "naming", "bandNames", "resampling", "catalog", "collection", "area", "datetime",
    "where", "maxCloud", "bands", "maxItems", "pick"]);

/**
 * Checks a parsed manifest against the manifest format: `type` and `version`, unknown properties, either `inputs`
 * or `stac`, input properties, band names and locations, the data type and the positive numbers. Styles are only
 * checked for being objects: their content is checked when the model is created.
 *
 * @param value the parsed JSON
 * @returns the problems found, each with its JSON path; an empty array when the manifest is valid
 *
 * @example
 * ```ts
 * const json = ...;                        // text of a manifest, provided by the application
 * const problems = validateManifest(JSON.parse(json));
 * for (const p of problems) console.log(`${p.path || "manifest"}: ${p.message}`);
 * ```
 *
 * @category Manifests
 */
export function validateManifest(value: unknown): RiaGeoTiffProblem[] {
    const problems: RiaGeoTiffProblem[] = [];
    const add = (path: string, message: string) => problems.push({path, severity: "error", message});
    if (!isObject(value)) return [{path: "", severity: "error", message: "a manifest is a JSON object"}];
    if (value.type !== MANIFEST_TYPE) add("type", `must be "${MANIFEST_TYPE}"`);
    if (value.version !== 1) add("version", "must be 1");
    for (const k of Object.keys(value)) if (!KNOWN.has(k)) add(k, "unknown property");
    if ((value.inputs === undefined) === (value.stac === undefined)) add("", "give either inputs or stac");
    if (value.inputs !== undefined) {
        if (!Array.isArray(value.inputs) || value.inputs.length === 0) add("inputs", "must be a non-empty array");
        else value.inputs.forEach((input: unknown, i: number) => {
            const p = `inputs[${i}]`;
            if (!isObject(input)) return add(p, "must be an object");
            for (const k of Object.keys(input)) if (!INPUT_KEYS.has(k)) add(`${p}.${k}`, "unknown property");
            if (typeof input.url !== "string" || !input.url) add(`${p}.url`, "must be a URL or a path relative to the manifest");
            const b = input.bands;
            if (b !== undefined) {
                const names = typeof b === "string" ? [b] : Array.isArray(b) ? b.filter((x) => x !== null) : null;
                if (!names) add(`${p}.bands`, "must be a band name or a list of names in file order (null skips a band)");
                else names.forEach((n) => { if (typeof n !== "string" || !IDENTIFIER.test(n)) add(`${p}.bands`, `"${String(n)}" is not a valid band name`); });
            }
            for (const k of ["scale", "offset"] as const) if (input[k] !== undefined && typeof input[k] !== "number") add(`${p}.${k}`, "must be a number");
            if (input.nodata !== undefined && input.nodata !== null && input.nodata !== "nan" && typeof input.nodata !== "number") add(`${p}.nodata`, 'must be a number, "nan" or null');
            if (input.resampling !== undefined && input.resampling !== "nearest" && input.resampling !== "bilinear") add(`${p}.resampling`, 'must be "nearest" or "bilinear"');
            if (input.sign !== undefined && input.sign !== "planetary-computer") add(`${p}.sign`, 'must be "planetary-computer"');
            if (input.crsName !== undefined && (typeof input.crsName !== "string" || !input.crsName.trim())) add(`${p}.crsName`, 'must be a reference identifier such as "EPSG:2056"');
        });
    }
    if (value.stac !== undefined) {
        const s = value.stac;
        if (!isObject(s)) add("stac", "must be an object");
        else {
            for (const k of Object.keys(s)) if (!STAC_KEYS.has(k)) add(`stac.${k}`, "unknown property");
            if ((s.items === undefined) === (s.catalog === undefined)) add("stac", "give either items or catalog");
            if (s.items !== undefined && (!Array.isArray(s.items) || s.items.length === 0 || s.items.some((u) => typeof u !== "string"))) {
                add("stac.items", "must be a non-empty list of item URLs");
            }
            if (s.catalog !== undefined) {
                if (typeof s.catalog !== "string") add("stac.catalog", "must be the URL of a STAC API");
                if (typeof s.collection !== "string") add("stac.collection", "must be a collection id");
            }
            if (s.bands !== undefined && (!Array.isArray(s.bands) || s.bands.some((b) => typeof b !== "string"))) add("stac.bands", "must be a list of band names");
        }
    }
    if (value.bands !== undefined) {
        if (!isObject(value.bands)) add("bands", 'must map band names to locations ("f1_b3", or "b3" with one input)');
        else Object.entries(value.bands).forEach(([n, ref]) => {
            if (!IDENTIFIER.test(n)) add(`bands.${n}`, "is not a valid band name");
            if (typeof ref !== "string" || !/^(f\d+_)?b\d+$/.test(ref)) add(`bands.${n}`, 'must be a location such as "f1_b3" (or "b3" with one input)');
        });
    }
    if (value.dataType !== undefined && value.dataType !== "image" && value.dataType !== "elevation") add("dataType", 'must be "image" or "elevation"');
    if (value.elevation !== undefined && !isObject(value.elevation)) add("elevation", "must be an object");
    if (value.dataType === "elevation" && value.style !== undefined) add("style", "an elevation manifest has no style");
    if (value.style !== undefined && !isObject(value.style)) add("style", "must be a style object");
    if (value.styles !== undefined && !isObject(value.styles)) add("styles", "must map names to styles");
    if (value.reference !== undefined && (typeof value.reference !== "string" || !value.reference.trim())) add("reference", 'must be a reference identifier such as "EPSG:32633"');
    for (const k of ["tileSize", "cacheSize", "byteCacheSize", "statisticsSize", "decodedBlocks"] as const) {
        if (value[k] !== undefined && (typeof value[k] !== "number" || !((value[k] as number) > 0))) add(k, "must be a positive number");
    }
    return problems;
}

/**
 * Rejection of `GeoTiffTileSetModel.create({manifest})` and {@link readManifest} when a manifest is invalid. The message lists every
 * problem; {@link ManifestError.problems} holds them one by one.
 *
 * @category Errors
 */
export class ManifestError extends RiaGeoTiffError {
    /**
     * Creates the error.
     *
     * @param problems the problems found by {@link validateManifest}
     */
    constructor(
        problems: RiaGeoTiffProblem[]) {
        super(`Invalid manifest: ${problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join("; ")}`, problems);
        this.name = "ManifestError";
    }
}

/**
 * Reads and validates a manifest from a URL, a File or Blob, a JSON string or an object, without opening it: for
 * showing its title and styles first. `GeoTiffTileSetModel.create({manifest})` reads it the same way.
 *
 * A string that starts with `{` is parsed as JSON; any other string is a URL, resolved against the page location
 * in browsers and fetched with the HTTP options (or those `options.access` gives for kind `"manifest"`).
 *
 * @param source a URL (string or `URL`), a `File` / `Blob` with JSON text, a JSON string, or a parsed manifest
 * @param options HTTP options for fetching the manifest (credentials, headers, parameters), and an optional
 *   `access` hook that decides them instead. Default none.
 * @returns a promise for the validated `manifest` and, when it was fetched from a URL, its absolute URL as `base`
 *   (for relative input URLs)
 * @throws {@link ManifestError} with the `problems` when the manifest is invalid
 * @throws `Error` when the URL cannot be fetched (HTTP error status); `SyntaxError` when the text is not JSON
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const manifestUrl = ...;                 // URL of a manifest, provided by the application
 * const {manifest, base} = await readManifest(manifestUrl);
 * console.log(manifest.title, Object.keys(manifest.styles ?? {}));
 * const model = await GeoTiffTileSetModel.create({manifest, base});
 * map.layerTree.addChild(new RasterTileSetLayer(model, {label: manifest.title ?? "Manifest"}));
 * ```
 *
 * @category Manifests
 */
export async function readManifest(source: string | URL | Blob | StackManifest, options: HttpAccessOptions & {
    /** Decides the options of the request instead, see {@link CreateModelOptions.access}. */
    access?: AccessHook;
    /** Called after the request (kind `"manifest"`), see {@link RiaGeoTiffRequest}. */
    onRequest?: RiaGeoTiffRequestListener;
} = {}): Promise<{
    /** The validated manifest. */
    manifest: StackManifest;
    /** Absolute URL the manifest was fetched from (the base for relative input URLs); unset otherwise. */
    base?: string;
}> {
    let value: unknown, base: string | undefined;
    if (source instanceof URL || (typeof source === "string" && !source.trimStart().startsWith("{"))) {
        base = new URL(String(source), typeof location !== "undefined" ? location.href : undefined).toString();
        const response = await accessFetch(base, options.access ? options.access(new URL(base), "manifest") : options, {}, fetch,
            {onRequest: options.onRequest, kind: "manifest"});
        if (!response.ok) throw new Error(`Cannot fetch manifest ${String(source)}: HTTP ${response.status}`);
        value = await response.json();
    } else if (typeof source === "string") {
        value = JSON.parse(source);
    } else if (typeof Blob !== "undefined" && source instanceof Blob) {
        value = JSON.parse(await source.text());
    } else {
        value = source;
    }
    const problems = validateManifest(value);
    if (problems.length) throw new ManifestError(problems);
    return {manifest: value as StackManifest, base};
}

/**
 * The create options a manifest stands for (its source and JSON options).
 *
 * @internal
 *
 * @category Manifests
 */
export async function manifestToOptions(manifest: StackManifest, base: string | undefined,
    resolve: ((url: string) => ResolvedInput | Promise<ResolvedInput>) | undefined): Promise<Partial<CreateModelOptions>> {
    const out: Record<string, unknown> = {};
    for (const k of MODEL_OPTIONS) if (manifest[k] !== undefined) out[k] = manifest[k];
    if (manifest.dataType === "elevation") out.dataType = RasterDataType.ELEVATION;
    if (manifest.reference !== undefined) out.reference = resolveReference(manifest.reference);
    if (manifest.style !== undefined) out.style = manifest.style;
    if (manifest.inputs) {
        const needsSigner = manifest.inputs.some((i) => i.sign === "planetary-computer");
        const signer = needsSigner ? (await import("../stac/assets.js")).planetaryComputerSigner() : undefined;
        const inputs: BandInput[] = [];
        // Listed files get the model's credentials, headers and parameters only on the manifest's own origin.
        const origin = base ? originOf(base) : null;
        for (const entry of manifest.inputs) {
            const {url, sign, nodata, ...rest} = entry;
            const target = resolve ? await resolve(url) : resolveUrl(url, base);
            const isUrl = typeof target === "string" || target instanceof URL;
            const input: BandInput = {
                ...rest,
                ...(isUrl ? {url: String(target)} : {url, file: target}),
                ...(nodata === undefined ? {} : {nodata: nodata === "nan" ? Number.NaN : nodata}),
                ...(sign && signer ? {sign: signer} : {}),
            };
            if (!resolve) discoveredInputs.set(input, {kind: "file", origin});
            inputs.push(input);
        }
        out.inputs = inputs;
    }
    if (manifest.stac) {
        const s = manifest.stac;
        out.stac = s.items ? {...s, items: s.items.map((u) => resolveUrl(u, base))} : s;
    }
    return out as Partial<CreateModelOptions>;
}

function resolveUrl(url: string, base: string | undefined): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (!base) throw new Error(`Relative URL "${url}" needs a base: open the manifest from a URL or pass options.base`);
    return new URL(url, base).toString();
}

/**
 * The manifest of a model whose inputs were opened from URLs: each input with its band names in file order, and
 * the current style (imagery) or the data type and elevation options (terrain). Throws when an input has no URL
 * (opened from a File or ArrayBuffer only) or the style uses functions.
 *
 * Each input gets its `url` (as given when the model was created), its band names (a string for a single band;
 * mosaic bands appear in each of their inputs), and `scale`, `offset` and `resampling` when they differ from 1, 0
 * and bilinear, `nodata` when it was given for the input (NaN as `"nan"`), and `sign: "planetary-computer"` when
 * the input is signed by the Planetary Computer signer, and `crsName` when the input has one (a STAC asset's
 * `proj:code`, so that a file without an EPSG reference reopens). Inputs without any band in the model are left out. The
 * model's `tileSize` is written when it was set, and `reference` (its identifier) when the model was opened with
 * `options.reference`, so that the manifest reopens in that reference.
 *
 * Not written: `requestHeaders`, `requestParameters` and `credentials`; `cacheSize`, `byteCacheSize`,
 * `statisticsSize` and `decodedBlocks`; function options (`signers` other than Planetary Computer, `sign` functions, `rewriteUrl`,
 * `resolve`, `access`, `onReadError`, `pool`); the region of `computeStatistics`. A STAC source is written as its
 * asset inputs (unsigned URLs), not as items or a selection. URLs are written as the inputs were opened: the
 * inputs of a model opened from a manifest have absolute URLs.
 *
 * @param model the model to describe
 * @param details `title`, `description`, `attribution` and named `styles` to add to the manifest. Default none.
 * @returns the manifest, ready for `JSON.stringify`
 * @throws `Error` when an input was not opened from a URL, or the style uses functions (a `custom` render or a
 *   function colour map)
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const url = ...;                         // URL of a COG, provided by the application
 * const model = await GeoTiffTileSetModel.create({url});
 * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
 * const json = JSON.stringify(toManifest(model, {title: "My view"}), null, 2);
 * ```
 *
 * @category Manifests
 */
export function toManifest(model: GeoTiffTileSetModel, details: Pick<StackManifest, "title" | "description" | "attribution" | "styles"> = {}): StackManifest {
    const opened = modelInputs(model);
    const byInput = new Map<number, { names: (string | null)[]; scale: number; offset: number; resampling: string }>();
    for (const b of model.getBands()) {
        b.locations.forEach((l, i) => {
            const entry = byInput.get(l.input) ?? {names: [], scale: i === 0 ? b.scale : 1, offset: i === 0 ? b.offset : 0, resampling: b.resampling};
            while (entry.names.length < l.sample) entry.names.push(null);
            entry.names[l.sample] = b.name;
            byInput.set(l.input, entry);
        });
    }
    const inputs: ManifestInput[] = [...byInput.entries()].sort(([a], [b]) => a - b).map(([i, e]) => {
        const {input, url, sign} = opened[i];
        if (!url) throw new Error(`Input ${i + 1} was not opened from a URL: it cannot be written to a manifest`);
        const nodata = input.nodata;
        const signer = (sign as { signer?: { id?: string } } | undefined)?.signer?.id ?? (sign as { id?: string } | undefined)?.id;
        const resampling = input.resampling ?? e.resampling;
        return {url, bands: e.names.length === 1 ? e.names[0]! : e.names,
            ...(input.scale !== undefined ? {scale: input.scale} : e.scale !== 1 ? {scale: e.scale} : {}),
            ...(input.offset !== undefined ? {offset: input.offset} : e.offset !== 0 ? {offset: e.offset} : {}),
            ...(resampling !== "bilinear" ? {resampling: resampling as "nearest"} : {}),
            ...(nodata !== undefined ? {nodata: nodata !== null && Number.isNaN(nodata) ? "nan" as const : nodata} : {}),
            ...(signer === "planetary-computer" ? {sign: "planetary-computer" as const} : {}),
            ...(input.crsName ? {crsName: input.crsName} : {})};
    });
    const options = opened[0]?.options ?? {};
    const common = {type: MANIFEST_TYPE as typeof MANIFEST_TYPE, version: 1 as const, ...details, inputs,
        ...(options.reference?.identifier ? {reference: options.reference.identifier} : {}),
        ...(options.tileSize !== undefined ? {tileSize: options.tileSize} : {})};
    const elevation = model.getElevation();
    if (elevation) {
        const e: ElevationOptions = {height: elevation.height, tileSize: elevation.tileSize,
            ...(elevation.noDataHeight !== undefined ? {noDataHeight: elevation.noDataHeight} : {})};
        return {...common, dataType: "elevation", elevation: e};
    }
    const style = model.getStyle()!;
    if (style.render.type === "custom" || (style.render.type === "pseudocolor" && typeof style.render.colorMap === "function")) {
        throw new Error("The style uses functions: it cannot be written to a manifest");
    }
    return {...common, style: JSON.parse(JSON.stringify(style)) as BandStyle};
}
