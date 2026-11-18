/**
 * Band descriptions of STAC assets, from STAC 1.1 `bands` (with `eo:` and `raster:` fields inside) or STAC 1.0
 * `eo:bands` + `raster:bands`. One normalised shape for both.
 */
import type {StacAssetJson} from "./json.js";

/** One band of an asset, normalised from STAC 1.1 `bands` or STAC 1.0 `eo:bands` + `raster:bands`.
 *
 * @category Assets and bands */
export interface BandDescriptor {
    /** Band name in the catalog (`B04`, `red`, ...). */
    name?: string;
    /** EO common name (`red`, `nir`, `swir16`, ...), when declared. */
    commonName?: string;
    /** Centre wavelength in micrometres. */
    centerWavelength?: number;
    /** Multiplier from raw to physical values (`value = raw * scale + offset`), when declared. */
    scale?: number;
    /** Offset from raw to physical values (`value = raw * scale + offset`), when declared. */
    offset?: number;
    /** Raw value that marks missing data, when declared (`"nan"`, `"inf"` and `"-inf"` become NaN and infinities). */
    nodata?: number;
    /** Raw data type of the band (`uint16`, `float32`, ...), when declared. */
    dataType?: string;
    /** Unit of the physical values (`m`, `K`, ...), when declared. */
    unit?: string;
    /** Spatial resolution in metres. */
    resolution?: number;
}

const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v === "nan") return Number.NaN;
    if (v === "inf") return Infinity;
    if (v === "-inf") return -Infinity;
    return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The EO extension's common band names; other values (some catalogs use "quality", "cloud") are not roles.
 *
 * @category Assets and bands */
export const EO_COMMON_NAMES = new Set(["coastal", "blue", "green", "red", "yellow", "pan", "rededge", "rededge071", "rededge075",
    "rededge078", "nir", "nir08", "nir09", "cirrus", "swir16", "swir22", "lwir", "lwir11", "lwir12"]);

/**
 * The bands of an asset (an empty list when it describes none).
 *
 * Band `i` merges entry `i` of `bands` (STAC 1.1, `eo:` / `raster:` prefixed fields), `eo:bands` and
 * `raster:bands` (STAC 1.0); the first defined value wins in that order. Asset-level `nodata`, `data_type`, `unit`
 * and `gsd` fill fields the bands leave out. Common names outside `EO_COMMON_NAMES` are dropped, numbers given
 * as strings are parsed, and fields without a value are omitted.
 *
 * @param asset A STAC asset (its `href` is not needed).
 * @returns One descriptor per band, as many as the longest of the three band arrays.
 * @example
 * ```ts
 * const item: StacItemJson = searchResult;  // an item returned by a search
 * for (const [key, asset] of Object.entries(item.assets)) {
 *     const bands = assetBands(asset);
 *     console.log(key, bands.map((b) => b.commonName ?? b.name), bands[0]?.scale, bands[0]?.nodata);
 * }
 * ```
 *
 * @category Assets and bands
 */
export function assetBands(asset: Omit<StacAssetJson, "href">): BandDescriptor[] {
    // STAC 1.1: `bands` with eo:/raster: prefixed fields; 1.0: separate eo:bands and raster:bands arrays.
    const unified = Array.isArray(asset.bands) ? asset.bands : [];
    const eo = Array.isArray(asset["eo:bands"]) ? asset["eo:bands"] : [];
    const raster = Array.isArray(asset["raster:bands"]) ? asset["raster:bands"] : [];
    const count = Math.max(unified.length, eo.length, raster.length);
    const out: BandDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        const u = (unified[i] ?? {}) as Record<string, unknown>;
        const e = (eo[i] ?? {}) as Record<string, unknown>;
        const r = (raster[i] ?? {}) as Record<string, unknown>;
        const pick = (...values: unknown[]) => values.find((v) => v !== undefined && v !== null);
        out.push(clean({
            name: str(pick(u.name, e.name, r.name)),
            commonName: ((c) => (c && EO_COMMON_NAMES.has(c) ? c : undefined))(str(pick(u["eo:common_name"], u.common_name, e.common_name))),
            centerWavelength: num(pick(u["eo:center_wavelength"], u.center_wavelength, e.center_wavelength)),
            // eo:bands as the last fallback: some catalogs (INPE BDC) put scale and nodata there.
            scale: num(pick(u["raster:scale"], u.scale, r.scale, e.scale)),
            offset: num(pick(u["raster:offset"], u.offset, r.offset, e.offset)),
            nodata: num(pick(u.nodata, r.nodata, asset.nodata, e.nodata)),
            dataType: str(pick(u.data_type, r.data_type, asset.data_type, e.data_type)),
            unit: str(pick(u.unit, r.unit, asset.unit)),
            resolution: num(pick(u["raster:spatial_resolution"], r.spatial_resolution, u.gsd, asset.gsd)),
        }));
    }
    return out;
}

function clean<T extends object>(o: T): T {
    for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
    return o;
}

const COG_TYPE = /image\/tiff/i;

/**
 * Whether an asset is a (Cloud Optimized) GeoTIFF by media type, or by file extension when it has no type.
 *
 * @param asset The asset; `type` and `href` are read.
 * @returns `true` when `type` contains `image/tiff` (any profile, case-insensitive), or, without `type`, when
 *   `href` ends in `.tif` or `.tiff` (before any query string).
 *
 * @category Assets and bands
 */
export function isGeoTiffAsset(asset: Partial<StacAssetJson>): boolean {
    if (asset.type) return COG_TYPE.test(asset.type);
    return typeof asset.href === "string" && /\.tiff?($|\?)/i.test(asset.href);
}

/** The format of a STAC asset, see {@link assetFormat}. */
export interface AssetFormat {
    /** Short name for display: `"COG"`, `"GeoTIFF"`, `"GeoTIFF (zipped)"`, `"INTERLIS (zipped)"`, `"CSV"`, ... */
    format: string;
    /** Whether a model can open it: a GeoTIFF by media type or extension ({@link isGeoTiffAsset}). */
    openable: boolean;
    /** Whether it declares the cloud-optimized profile (`profile=cloud-optimized`). A GeoTIFF without it may still be a COG. */
    cog: boolean;
}

/** Media type or extension patterns to display names, first match wins. */
const FORMATS: [RegExp, string][] = [
    [/interlis|\.xtf\b/i, "INTERLIS"], [/ms-access|\.mdb\b/i, "MS Access"], [/geopackage|\.gpkg\b/i, "GeoPackage"],
    [/shapefile|esri-shape|\.shp\b/i, "Shapefile"], [/geo\+json|\.geojson\b/i, "GeoJSON"], [/parquet|\.parquet\b/i, "GeoParquet"],
    [/x-ndjson|\.ndjson\b/i, "NDJSON"], [/json|\.json\b/i, "JSON"], [/csv|\.csv\b/i, "CSV"], [/xml|\.xml\b/i, "XML"],
    [/jpeg|\.jpe?g\b/i, "JPEG"], [/png|\.png\b/i, "PNG"], [/jp2|\.j2k\b|\.jp2\b/i, "JPEG 2000"], [/pdf|\.pdf\b/i, "PDF"],
    [/netcdf|x-hdf|\.nc\b|\.h5\b|\.hdf\b/i, "NetCDF/HDF"], [/zarr/i, "Zarr"], [/las|\.la[sz]\b|copc/i, "Point cloud"],
    [/dxf|dwg|\.dxf\b|\.dwg\b/i, "CAD"], [/gltf|glb|3d-tiles|\.b3dm\b/i, "3D"], [/html|\.html?\b/i, "HTML"],
    [/text\/plain|\.txt\b/i, "Text"], [/google-earth|\.km[lz]\b/i, "KML"], [/grib|\.grib2?\b/i, "GRIB"], [/zip|\.zip\b/i, "ZIP"],
];

/**
 * Names the format of a STAC asset and says whether a model can open it, for lists that show every asset and grey
 * out the ones that cannot be used (downloads in ZIP, vector formats, documents).
 *
 * The media type decides; without one, the extension of `href`. Only GeoTIFFs open: `"COG"` when the type declares
 * `profile=cloud-optimized`, else `"GeoTIFF"`. A zipped file (`application/x.tiff+zip`, `.tif.zip`) cannot be read
 * with range requests, so it is `"GeoTIFF (zipped)"` and not openable.
 *
 * @param asset The asset; `type` and `href` are read.
 * @returns Its display format, whether it opens, and whether it declares the COG profile.
 *
 * @example
 * ```ts
 * for (const [key, asset] of Object.entries(item.assets)) {
 *     const {format, openable} = assetFormat(asset);
 *     console.log(`${key}: ${format}${openable ? "" : " (cannot be opened)"}`);
 * }
 * ```
 *
 * @category Assets and bands
 */
export function assetFormat(asset: Partial<StacAssetJson>): AssetFormat {
    const type = asset.type ?? "";
    const path = typeof asset.href === "string" ? asset.href.replace(/[?#].*$/, "") : "";
    const subject = type || path;
    const zipped = /\+zip\b|zip$|\.zip$/i.test(type) || /\.zip$/i.test(path);
    if (isGeoTiffAsset(asset) && !zipped) {
        const cog = /profile=cloud-optimized/i.test(type);
        return {format: cog ? "COG" : "GeoTIFF", openable: true, cog};
    }
    // What is zipped: the media type before +zip, else the extension before .zip.
    const inner = zipped ? (type.replace(/\+zip.*$/i, "") || path.replace(/\.zip$/i, "")) : subject;
    const named = /tiff?\b/i.test(inner) ? "GeoTIFF" : FORMATS.find(([pattern]) => pattern.test(inner))?.[1];
    const format = zipped ? (named && named !== "ZIP" ? `${named} (zipped)` : "ZIP")
        : named ?? (type ? type.split(";")[0].replace(/^[a-z]+\/(x[.-])?/i, "").toUpperCase() : path.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() ?? "unknown");
    return {format, openable: false, cog: false};
}

/**
 * Assets that are imagery data (not thumbnails, overviews or metadata).
 *
 * @param key The asset key in the item.
 * @param asset The asset; `roles`, `type` and `href` are read.
 * @returns `false` for the roles `thumbnail`, `overview` or `metadata`, for `visual` without `data`, for keys
 *   `thumbnail`, `preview`, `rendered_preview` and `tilejson`, and for assets that are not GeoTIFFs
 *   ({@link isGeoTiffAsset}); `true` otherwise.
 *
 * @category Assets and bands
 */
export function isDataAsset(key: string, asset: Partial<StacAssetJson>): boolean {
    const roles = asset.roles ?? [];
    if (roles.some((r) => r === "thumbnail" || r === "overview" || r === "metadata")) return false;
    if (roles.includes("visual") && !roles.includes("data")) return false;
    return isGeoTiffAsset(asset) && !/^(thumbnail|preview|rendered_preview|tilejson)$/i.test(key);
}

/** Common names that differ between sensors for the same role; used when the plain name is free. */
const ROLE_ALIASES: Record<string, string> = {nir08: "nir", lwir11: "lwir"};

/** A name made a valid band identifier: other characters become `_`, a leading digit gets a `_` prefix. */
export const bandIdentifier = (s: string): string => {
    const name = s.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
};

/**
 * The band names of a list of assets, by the one naming rule shared by `itemBandNames`, `assetBandMap` (items)
 * and `collectionBands` (a collection's item_assets).
 *
 * - A single-band (or undescribed) asset takes its EO common name when `naming` is `"common-name"` and no other
 *   single-band asset of the list shares it (Sentinel-2's three `rededge` assets keep their keys); otherwise, or
 *   when that name is taken, its key.
 * - A multiband asset takes one name per band: its common name (unless `naming` is `"asset-key"`), else its name,
 *   else `{key}_b{n}` (1-based).
 * - Every name is made a valid identifier (other characters become `_`, a leading digit gets a `_` prefix).
 * - Landsat's `nir08` / `lwir11` (single-band) become `nir` / `lwir` when no band of the list has that name.
 *
 * @param assets The assets, in order, with their bands (from {@link assetBands}).
 * @param naming `"common-name"` (default) or `"asset-key"`.
 * @returns Asset key to its band names (one for a single-band asset), in the order of `assets`.
 *
 * @internal
 *
 * @category Assets and bands
 */
export function nameAssetBands(assets: { key: string; bands: BandDescriptor[] }[], naming: "common-name" | "asset-key" = "common-name"): Record<string, string[]> {
    const single = assets.filter((a) => a.bands.length <= 1);
    const commonOf = (a: { bands: BandDescriptor[] }) => (naming === "common-name" ? a.bands[0]?.commonName : undefined);
    const counts = new Map<string, number>();
    for (const a of single) { const c = commonOf(a); if (c) counts.set(c, (counts.get(c) ?? 0) + 1); }
    const names = new Map<string, string[]>();
    const taken = new Set<string>();
    for (const a of single) {
        // A common name shared by several assets is ambiguous: those assets keep their keys.
        const c = commonOf(a);
        const common = c && counts.get(c) === 1 ? c : undefined;
        let name = bandIdentifier(common && !taken.has(common) ? common : a.key);
        if (taken.has(name)) name = bandIdentifier(a.key);
        names.set(a.key, [name]);
        taken.add(name);
    }
    for (const a of assets) {
        if (a.bands.length <= 1) continue;
        const list = a.bands.map((b, i) => bandIdentifier((naming !== "asset-key" && b.commonName) || b.name || `${a.key}_b${i + 1}`));
        names.set(a.key, list);
        list.forEach((n) => taken.add(n));
    }
    // Role aliases (Landsat nir08 → nir) only where the plain name is free: Sentinel-2 has both nir (B08) and nir08 (B8A).
    for (const a of single) {
        const [name] = names.get(a.key)!;
        const alias = ROLE_ALIASES[name];
        if (alias && !taken.has(alias)) { names.set(a.key, [alias]); taken.delete(name); taken.add(alias); }
    }
    return Object.fromEntries(assets.map((a) => [a.key, names.get(a.key)!]));
}
