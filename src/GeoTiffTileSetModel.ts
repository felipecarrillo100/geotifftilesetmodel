import {RasterTileSetModel} from "@luciad/ria/model/tileset/RasterTileSetModel.js";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {TileData} from "@luciad/ria/model/tileset/TileData.js";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode.js";
import type {CoordinateReference} from "@luciad/ria/reference/CoordinateReference.js";
import {addReference, isValidReferenceIdentifier, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import type {Bounds} from "@luciad/ria/shape/Bounds.js";
import {createBounds} from "@luciad/ria/shape/ShapeFactory.js";
import type {ModelDescriptor} from "@luciad/ria/model/ModelDescriptor.js";
import {fromArrayBuffer, fromBlob, type GeoTIFF, type GeoTIFFImage, type Pool} from "geotiff";

import {DecodedBlockCache} from "./blockCache.js";
import {
    chooseImage, DEFAULT_ELEVATION_TILE_SIZE, elevationTileStructure, interpolate, samplePositions, sampleWindow,
} from "./elevation.js";
import {GeoTiffModelError, GeoTiffReadError, type GeoTiffReadErrorListener} from "./errors.js";
import {getReferenceFromPrjFile, type HttpAccessOptions} from "./fileutils.js";
import {discoveredInputs, originOf, type AccessHook, type Observe, type RiaGeoTiffRequest, type RiaGeoTiffRequestListener} from "./http.js";
import type {HttpRequestHeaders, HttpRequestOptions, HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";
import {areaExtent, columnOf, gridOfMainImage, gridOfOverview, rowOf, type RasterGrid} from "./geometry.js";
import {PixelMeaningEnum} from "./interfaces.js";
import {encodeLuciadElevationPng} from "./luciadElevationPng.js";
import {defaultPool, mapLimited, openURL, readImages, resolveReference} from "./shared.js";
import {colorMapOf, gdalBandDescription, gdalScaleOffset, geoKeysOf, isMaskImage, photometricOf} from "./tiff.js";
import {
    analyzePixelFormat, bitsPerSampleOf, canRepresentElevation, detectSamplingMode, isConvertedToRGB,
    referenceIdentifierFromGeoKeys, sampleFormatOf, type NumericArray,
} from "./utils.js";
import {formatColor} from "./rs/colormaps.js";
import {compileExpression, expressionBands, toExpressionNode, type BandArrays} from "./rs/expression.js";
import {compileStyle, legendOf, type CompiledStyle, type Legend} from "./rs/render.js";
import {computeStatistics, type BandStatistics, type ResolvedStretch} from "./rs/stats.js";
import {StyleError, type BandStyle} from "./rs/style.js";
import {autoStyle} from "./sources/autoStyle.js";
import {analyzeCog, type CogProbe} from "./sources/cog.js";
import type {StackManifest} from "./sources/manifest.js";
import {DEFAULT_SIGNERS, type AssetSigner} from "./stac/assets.js";
import type {StacItemJson} from "./stac/json.js";
import type {SearchPlan} from "./stac/plan.js";
import type {StacModelSource} from "./stac/source.js";

// ----------------------------------------------------------------------------------------------------- options

/**
 * How values are taken from a file whose pixels do not line up with the tiles: `"nearest"` takes the value of the
 * pixel that contains the sample, `"bilinear"` blends the 4 nearest pixel centres (next to missing data it takes
 * the nearest valid one instead).
 *
 * For each imagery tile the model reads one image of each file: the coarsest overview whose pixels are still at
 * least as fine as the tile's pixels (the full-resolution image when none is). It resamples that image onto the
 * tile. Elevation models ignore this setting: heights are always interpolated bilinearly, nodata aware.
 *
 * @category Model
 */
export type Resampling = "nearest" | "bilinear";

/**
 * One GeoTIFF of a {@link GeoTiffTileSetModel}: a single-band file (one Sentinel-2 band), a multiband file whose
 * bands get names, or one tile of a mosaic. Give `url` or `file`.
 *
 * Inputs whose bands have the same name form a **mosaic** of that band: where they overlap, the first input with
 * data at a pixel wins.
 *
 * `credentials`, `requestHeaders` and `requestParameters` override the model's options for this input; they are
 * sent only to the origin of its `url`.
 *
 * @category Model
 */
export interface BandInput extends HttpAccessOptions {
    /**
     * URL of a Cloud Optimized GeoTIFF, streamed with range requests. With `file` as well, the URL only says where
     * the file came from (for read error reports, manifests and the `.prj` lookup) and is not opened.
     */
    url?: string | URL;
    /**
     * The GeoTIFF from memory: a `File` or `Blob` (an `<input type="file">`), an `ArrayBuffer` with the whole
     * file, or a `GeoTIFF` already opened with geotiff.js. Used instead of `url`. In browsers a `Blob` is read in
     * slices as needed; an `ArrayBuffer` is already in memory. No `.prj` file is looked up for a file without
     * a `url`: give {@link CreateModelOptions.reference} when the file declares no EPSG reference.
     */
    file?: Blob | ArrayBuffer | GeoTIFF;
    /**
     * Names of the bands to use. A string names the first band of the file; an array names the file's bands in
     * order (`null` skips a band, and so does a missing entry at the end). Names must be identifiers (letters,
     * digits, `_`, not starting with a digit). The same name in several inputs makes a mosaic of that band.
     * Default: the GDAL band descriptions when they are all valid, unique identifiers (such as `Jan`..`Dec`), else
     * `b1`..`bN` with one input and `f1_b1`.. with several. Exception: for terrain (`dataType: ELEVATION`) from
     * several single-band inputs, none with `bands`, every input is band `elevation`: one mosaic (a tiled DEM).
     * Ignored when {@link CreateModelOptions.bands} is given.
     *
     * Skipped bands do not exist in the model: styles, expressions and {@link GeoTiffTileSetModel.getValuesAt}
     * cannot use them, and they are never read.
     */
    bands?: string | (string | null)[];
    /**
     * Scale of `value = raw * scale + offset`, applied to every band of the file before styling, statistics and
     * heights. Default: the file's GDAL scale tag of each band, else 1.
     */
    scale?: number;
    /**
     * Offset of `value = raw * scale + offset`, see {@link BandInput.scale}. Default: the file's GDAL offset tag of
     * each band, else 0.
     */
    offset?: number;
    /**
     * Raw value (before scale and offset) that marks missing data. `null` means the file has no nodata value, even
     * when it declares one. Leave it out to use the file's GDAL_NODATA tag. NaN is always missing data, and so are
     * pixels hidden by the file's internal mask.
     */
    nodata?: number | null;
    /**
     * Resampling of imagery where the file is coarser than the tiles or not aligned with them, see
     * {@link Resampling}. Default `"bilinear"`, also for class rasters: set `"nearest"` yourself for classes and
     * bit masks (Sentinel-2 SCL, Landsat QA_PIXEL, land cover). STAC sources choose `"nearest"` for class and mask
     * assets automatically. Ignored by elevation models.
     */
    resampling?: Resampling;
    /**
     * Returns a fresh URL for `url`, for services with expiring tokens (Planetary Computer SAS tokens). Called once
     * when the input is opened, and again when a read fails: the file is then reopened with the new URL and the
     * read is retried once. It is not called for each range request. Default: the first of
     * {@link CreateModelOptions.signers} that matches the URL, if any. Not used with `file`.
     */
    sign?: (url: string) => Promise<string>;
    /**
     * Identifier of the input's coordinate reference (`"EPSG:2056"`), used when the file itself declares no EPSG
     * reference: GeoTIFFs with a user-defined projection (GeoKey 32767) that only name it in a citation. The file's
     * own EPSG reference always wins; this comes before the `.prj` lookup. STAC sources set it from the asset's
     * `proj:code` or `proj:epsg` (else the item's). Like the file's reference, it is not a reprojection: the
     * georeferencing must be in it. Ignored with {@link CreateModelOptions.reference}.
     */
    crsName?: string;
}

/** Elevation options of {@link CreateModelOptions.elevation}, used with `dataType: RasterDataType.ELEVATION`.
 *
 * @category Model */
export interface ElevationOptions {
    /**
     * Which values are the heights: a band name (`"dem_2024"`), or an expression over the bands
     * (`"where(isnan(lidar), national, lidar)"`, see {@link parseExpression}). Required when the model has several
     * bands; with one band, that band is the height.
     *
     * LuciadRIA expects metres. The values are used as stored, after the input's `scale` and `offset`: nothing is
     * converted, so a DEM in feet needs `scale: 0.3048` on its input. Where the result is NaN there is no data.
     */
    height?: string;
    /**
     * Number of samples along each side of an elevation tile, an integer >= 2. Default 64
     * ({@link DEFAULT_ELEVATION_TILE_SIZE}), as in LuciadFusion. A value that is not an integer >= 2 makes
     * `GeoTiffTileSetModel.create` and `asElevation` reject with a `RangeError`, before any request.
     * {@link CreateModelOptions.tileSize} does not apply to elevation models.
     */
    tileSize?: number;
    /**
     * Height, in metres, given to LuciadRIA where there is no data. By default missing samples are delivered as
     * nodata in the LuciadElev0 encoding (sample value 0), and LuciadRIA treats them as missing. Set a finite number
     * to deliver that height instead (a non-finite value makes `GeoTiffTileSetModel.create` and `asElevation` reject with a
     * `RangeError`).
     */
    noDataHeight?: number;
}

/** A value of {@link CreateModelOptions.resolve}: a URL, or the file itself.
 *
 * @category Model */
export type ResolvedInput = string | URL | Blob | ArrayBuffer | GeoTIFF;

/**
 * Options of {@link GeoTiffTileSetModel.create}: exactly one source (`url`, `file`, `inputs`, `stac` or
 * `manifest`), plus the options common to every source, including the HTTP options of {@link HttpAccessOptions},
 * which apply to every request (files, manifests and STAC items).
 *
 * @category Model
 */
export interface CreateModelOptions extends HttpAccessOptions {
    /** Source: one GeoTIFF by URL, streamed with range requests. Shortcut for `inputs: [{url}]`. */
    url?: string | URL;
    /** Source: one GeoTIFF from memory (`File`, `Blob`, `ArrayBuffer` or opened `GeoTIFF`). Shortcut for `inputs: [{file}]`. */
    file?: Blob | ArrayBuffer | GeoTIFF;
    /**
     * Source: several GeoTIFFs, as bands (different names) and/or as a mosaic (the same name). Their order gives
     * the input numbers of band locations (the first input is `f1`) and the mosaic priority (the first input with
     * data at a pixel wins).
     */
    inputs?: BandInput[];
    /** Source: STAC items the user chose, or a selection to search and pick, see {@link StacModelSource}. */
    stac?: StacModelSource;
    /**
     * Source: a manifest (these same options saved as JSON, see {@link StackManifest}): its URL, a `File` / `Blob`,
     * JSON text or a parsed manifest. Options given next to `manifest` override the manifest's.
     */
    manifest?: string | URL | Blob | StackManifest;
    /**
     * Names for the bands, given once by location: `{red: "f1_b3", nir: "f2_b1"}` is band 3 of the first input and
     * band 1 of the second (both 1-based, as in GDAL); with one input, `"b3"` is enough. The keys are the names
     * (identifiers), the values the locations; the order of the keys is the order of
     * {@link GeoTiffTileSetModel.getBandNames}.
     *
     * Only the bands named here exist in the model, and the inputs' own `bands` are ignored. Bands that are not
     * named cannot be used by styles, expressions or {@link GeoTiffTileSetModel.getValuesAt}, and are never read.
     * Every input is still opened (its header is read), even when none of its bands is named. Default: names from
     * the inputs' `bands`, the files' GDAL band descriptions, or `b1`…`bN` (one input) / `f1_b1`… (several);
     * for terrain from several unnamed single-band inputs, one mosaic band `elevation`.
     */
    bands?: Record<string, string>;
    /**
     * Imagery only: the style, or a function that receives the band names and returns the style. Default for
     * `url`, `file`, `inputs` and manifests without a style: a single-band palette file gets its colour table,
     * every other model {@link autoStyle}. Default for STAC time series: true colour of the last period (1–99 %
     * percentile stretch), else its first band in grey. Rejected with a `RangeError` together with
     * `dataType: ELEVATION`.
     */
    style?: BandStyle | ((bandNames: string[]) => BandStyle);
    /**
     * `RasterDataType.IMAGE` (default) for imagery, `RasterDataType.ELEVATION` for terrain (heights in metres, see
     * {@link ElevationOptions}). LuciadRIA fixes the data type of a model when it is created: use
     * {@link GeoTiffTileSetModel.asElevation} and {@link GeoTiffTileSetModel.withStyle} for the other kind.
     */
    dataType?: RasterDataType;
    /** Terrain only: which values are the heights, tile size and nodata height, see {@link ElevationOptions}. */
    elevation?: ElevationOptions;
    /**
     * Overrides the reference of every input (the files are then not checked for a common reference, and no
     * `.prj` file is requested). The inputs' georeferencing is still used for their position, so it must be in
     * this reference: no reprojection happens. Use `getReference("CRS:1")` for a file without georeferencing, in
     * pixel coordinates. Default: the files' EPSG reference, else for a URL the reference of a `.prj` file next to
     * it.
     */
    reference?: CoordinateReference;
    /**
     * Gives the definition of a coordinate reference LuciadRIA does not know, so that files in any EPSG code open in
     * one call. Called with the identifier the files declare (`"EPSG:32633"`) when LuciadRIA has no reference of that
     * name; return its WKT (for example from your own service, or `gdalsrsinfo -o wkt1`), or `null` when unknown. The
     * result is parsed with LuciadRIA's `parseWellKnownText` and registered with `addReference` under that
     * identifier, so later models use it directly. Not called with `options.reference`. When it returns `null`,
     * rejects or gives WKT LuciadRIA cannot parse, `create` rejects with `UnknownIdentifier` (`originalError` holds
     * the reason).
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     *
     * const map = ...;                                          // your LuciadRIA WebGLMap
     * const url = ...;                                          // URL of a COG in any EPSG code
     * const wktOf = async (identifier: string): Promise<string | null> => ...;   // your source of WKT definitions
     * const model = await GeoTiffTileSetModel.create({url, resolveReference: wktOf});
     * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
     * ```
     */
    resolveReference?: (identifier: string) => Promise<string | null>;
    /**
     * Called after every request the model makes, from `create` on: the source (manifest, STAC items and API),
     * the headers and data of the files, `.prj` files. For logs, request counters and progress; see
     * {@link RiaGeoTiffRequest}. URLs are reported unsigned and before `rewriteUrl`. Twins share it.
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     *
     * const map = ...;   // your LuciadRIA WebGLMap
     * const url = ...;   // URL of a COG
     * let requests = 0;
     * const model = await GeoTiffTileSetModel.create({url, onRequest: (r) => {
     *     requests++;
     *     console.debug(r.kind, r.method, r.url, r.range ?? "", r.status ?? r.error, `${Math.round(r.ms)} ms`);
     * }});
     * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
     * ```
     */
    onRequest?: RiaGeoTiffRequestListener;
    /**
     * Imagery only: tile width and height in pixels, an integer from 16 to 4096. Default 256; normally 256 or 512.
     * Larger tiles mean fewer, larger reads and renders per view. Another value makes `GeoTiffTileSetModel.create`
     * reject with a `RangeError`, before any request. Elevation models use {@link ElevationOptions.tileSize}
     * instead (this option is then not checked).
     */
    tileSize?: number;
    /**
     * geotiff.js decoder pool (web workers). Default: one pool shared by all models, created on first use in
     * browsers with one worker per CPU core (geotiff.js' default), and none outside browsers. `null` decodes on
     * the main thread.
     */
    pool?: Pool | null;
    /**
     * Called with a {@link GeoTiffReadError} when data of a file cannot be read while serving tiles or statistics;
     * the affected area is then shown as no data. Same as calling `model.addReadErrorListener` right after
     * creation. Without listeners the errors are logged with `console.warn`.
     */
    onReadError?: GeoTiffReadErrorListener;
    /**
     * Memory limit of the decoded tile cache, in MiB. Default 256. The cache holds the band values of rendered
     * tiles (Float32, `tileSize × tileSize × 4` bytes per band per tile: 256 KiB at 256 px), so restyling needs no
     * reads. It is shared with twins, and the least recently used tiles are dropped first.
     */
    cacheSize?: number;
    /**
     * Memory limit of the fetched-bytes cache of each input, in MiB: the raw (still compressed) bytes of range
     * requests, kept in 64 KiB blocks so that reading a block again costs a decode, not a request. Default 16
     * (256 blocks). Each input has its own cache, shared with twins, so a model can hold up to `byteCacheSize`
     * MiB times the number of inputs: lower it for large mosaics, raise it for few inputs viewed at length. A
     * value that is not a positive number makes `GeoTiffTileSetModel.create` reject with a `RangeError`.
     */
    byteCacheSize?: number;
    /**
     * Number of decoded file blocks kept in memory, shared by all inputs of the model and its twins. Default 96.
     * Tiles are usually smaller than the blocks of the files, so neighbouring tiles reuse a decoded block instead
     * of decoding it again. A block uses `blockWidth × blockHeight × bands × bytes per sample`: a 512 × 512 Float32
     * single-band block is 1 MiB, a 1024 × 1024 one 4 MiB.
     */
    decodedBlocks?: number;
    /**
     * Number of sample points along the longer side of the area used for statistics; the shorter side gets
     * proportionally fewer. Default 512. Larger values give more precise stretches and cost more reads.
     */
    statisticsSize?: number;
    /**
     * Signers for URLs that need tokens, tried in order on every input URL without its own `sign`; the first whose
     * `matches(url)` is true signs it. Default {@link DEFAULT_SIGNERS} (Planetary Computer storage of Planetary
     * Computer items). Pass `[]` to sign nothing. Not used for `file` inputs.
     */
    signers?: AssetSigner[];
    /**
     * Rewrites every input URL before it is opened, after signing, for example through a CORS proxy. It applies
     * to GeoTIFF URLs and to the `.prj` files next to them (signed and rewritten as their GeoTIFF), not to the
     * manifest URL or STAC item or API URLs. For a STAC API, pass a connected `StacClient` with its own
     * `rewriteUrl` as `stac.catalog`.
     */
    rewriteUrl?: (url: string) => string;
    /**
     * Manifest source only: base URL for relative input URLs. Default: the manifest's own URL when opened from one.
     */
    base?: string;
    /**
     * Manifest source only: resolves an input URL yourself (local files dropped with the manifest, a proxy, ...):
     * receives the `url` of each input exactly as written in the manifest and returns a URL or the file itself.
     * When given, `base` is not used.
     */
    resolve?: (url: string) => ResolvedInput | Promise<ResolvedInput>;
    /**
     * Decides per request which credentials, headers and parameters to send, replacing the default rule: the
     * options go only to the origin of a URL the application gave for them (`url`, `inputs[i].url`, the manifest
     * URL, files a manifest lists on its own origin, STAC item URLs), never to discovered URLs (files of a manifest
     * on another origin, STAC assets, signer token endpoints). Return `null` for none.
     *
     * Called before every request (so it can return a renewed token) with the URL and its kind: `"file"` for
     * GeoTIFFs and `.prj` files, `"manifest"`, `"stac-api"` for STAC items and API requests of a catalog given as a
     * URL, `"stac-asset"` for STAC assets without a `stac.assetAccess` hook (`"source"` is only used by
     * `identifySource`). Not called for signer token endpoints.
     */
    access?: AccessHook;
}

/**
 * Options for {@link GeoTiffTileSetModel.infoFromURL}: the HTTP options of {@link HttpAccessOptions}.
 *
 * @category Model
 */
export interface GetInfoGeotiffFromUrlOptions extends HttpAccessOptions {
}

/** Information read from a GeoTIFF, see {@link GeoTiffTileSetModel.infoFromURL} and {@link GeoTiffTileSetModel.getModelInfo}.
 *
 * @category Model */
export interface GeoTiffTileSetModelInfo {
    /** Width of each tile (block) of the full-resolution image, in pixels. */
    tileWidth: number;
    /** Height of each tile (block) of the full-resolution image, in pixels. */
    tileHeight: number;
    /** Width of the full-resolution image, in pixels. */
    width: number;
    /** Height of the full-resolution image, in pixels. */
    height: number;
    /** Bytes per pixel. */
    bytesPerPixel: number;
    /** Bits per sample, for one band or per band. */
    bitsPerSample: number | number[];
    /** Number of bands. */
    bands: number;
    /** Whether the image is stored in tiles (rather than strips). */
    isTiled: boolean;
    /** What the pixel values mean. */
    pixelMeaning: PixelMeaningEnum;
    /** LuciadRIA pixel format matching the data natively (detected). */
    pixelFormat: PixelFormat | null;
    /** Whether the file is a Cloud Optimized GeoTIFF, by the checks of {@link probeCog} (its `isCog`); for every input of a model see {@link BandLocation.isCog}. */
    isCog: boolean;
    /** Coordinate reference identifier, such as `"EPSG:3857"`, or null when unknown. */
    crsName: string | null;
    /** Sampling mode declared by the file. */
    samplingMode: RasterSamplingMode;
    /** Whether the bands hold plain numbers usable as elevation. */
    canBeElevation: boolean;
    /**
     * Images of the file (full resolution first, mask images left out). Only set by
     * {@link GeoTiffTileSetModel.infoFromURL}.
     */
    tileMatrix?: {
        /** Index of the image: 0 = full resolution, higher = coarser overviews. */
        zoom: number;
        /** Number of tile columns of the image. */
        tileColumnCount: number;
        /** Number of tile rows of the image. */
        tileRowCount: number;
        /** Width of each tile (block) of the image, in pixels. */
        tileWidth: number;
        /** Height of each tile (block) of the image, in pixels. */
        tileHeight: number;
    }[];
}

/** Where a band is stored: one input and one band of its file.
 *
 * @category Model */
export interface BandLocation {
    /** Zero-based index of the input (input 0 is location `f1`). */
    input: number;
    /** URL of the input, when it was opened from a URL (unsigned, as given). */
    url?: string;
    /** Zero-based band of the file: 0 is GDAL's band 1 (location `"b1"`). */
    sample: number;
    /**
     * Whether the input is a Cloud Optimized GeoTIFF (the analysis of `probeCog`, from the header already read);
     * undefined when its header could not be analysed.
     */
    isCog?: boolean;
}

/** A band of the model, as returned by {@link GeoTiffTileSetModel.getBands}.
 *
 * @category Model */
export interface BandInfo {
    /** Name of the band, as used in styles and expressions. */
    name: string;
    /** Zero-based index of the (first) input of the band (input 0 is location `f1`). */
    input: number;
    /** URL of the (first) input, when it was opened from a URL (unsigned, as given). */
    url?: string;
    /** Zero-based band of the (first) file: 0 is GDAL's band 1 (location `"b1"`). */
    sample: number;
    /** Scale applied to the raw values of the (first) input (`value = raw * scale + offset`). */
    scale: number;
    /** Offset applied to the raw values of the (first) input (`value = raw * scale + offset`). */
    offset: number;
    /** Pixel size (x) of the finest full-resolution image of the band, in units of the model reference (metres, degrees, ...). */
    resolution: number;
    /** How values of the (first) input are resampled onto the tiles. */
    resampling: Resampling;
    /** Every input of the band, in priority order: one for a plain band, several for a mosaic. */
    locations: BandLocation[];
}

/** Timing counters, for performance displays; see {@link GeoTiffTileSetModel.getPerformance}.
 *
 * @category Model */
export interface ModelPerformance {
    /** Number of tiles rendered. */
    tiles: number;
    /** Number of tiles rendered from cached band values only, without reads. */
    cacheHits: number;
    /** Average time to read and decode the bands of a tile (ms), over the reads made for tiles. */
    readMs: number;
    /** Average time to evaluate the style and render a tile (ms). */
    renderMs: number;
    /** Bytes held in the decoded tile cache. */
    cacheBytes: number;
}

/** What a model was opened from, as returned by {@link GeoTiffTileSetModel.getSource}.
 *
 * @category Model */
export interface ModelSource {
    /** `"inputs"` for `url`, `file` and `inputs`; `"stac"` for STAC items; `"manifest"` for a manifest. */
    kind: "inputs" | "stac" | "manifest";
    /** The STAC items the model was built from (STAC sources, and manifests with a `stac` source). */
    items?: StacItemJson[];
    /**
     * Period labels in time order, for a time slider: set for a STAC time series (several periods), unset for a
     * single period. Labels are those of `periodOf`: `"2024"`, `"2024-Q3"`, `"2024-07"`, `"2024-W29"`,
     * `"2024-07-15"`. Band names use the label with every character other than a letter, digit or `_` replaced by
     * `_`: period `"2024-07"` gives `red_2024_07`.
     */
    periods?: string[];
    /** How the STAC search was sent to the server (STAC sources with a selection). */
    plan?: SearchPlan;
    /** Number of items the STAC search found, before picking (STAC sources with a selection). */
    found?: number;
    /** The manifest (manifest sources). */
    manifest?: StackManifest;
}

// ----------------------------------------------------------------------------------------------------- internals

/** The live credentials, headers and parameters of a model and its twins (setters change them). */
interface HttpState { credentials?: boolean | RequestCredentials; requestHeaders?: HttpRequestHeaders | null; requestParameters?: HttpRequestParameters | null }

interface OpenFile {
    index: number;
    /** The options of the next request to this file. */
    access: () => HttpRequestOptions | null;
    blocks: DecodedBlockCache;
    input: BandInput;
    url?: string;
    tiff: GeoTIFF;
    images: GeoTIFFImage[];
    grids: RasterGrid[];
    /** Internal mask image matching each image (same size), or null. */
    masks: (GeoTIFFImage | null)[];
    nodata: number | null;
    resampling: Resampling;
    /** Bands of the file as read (3 for colour models converted to RGB). */
    bandCount: number;
    /** YCbCr, CIELab or CMYK data: read as RGB with readRGB. */
    colourModel: boolean;
    /** The signer in use. */
    sign?: (url: string) => Promise<string>;
    reopening?: Promise<void>;
}

interface BandPart { file: OpenFile; sample: number; scale: number; offset: number }

interface BandSource { info: BandInfo; parts: BandPart[] }

interface ElevationMode {
    kind: "elevation";
    /** The height: a band name or an expression. */
    height: string;
    requiredBands: string[];
    evaluate: (bands: BandArrays, n: number) => Float32Array;
    tileSize: number;
    noDataHeight: number;
    options: ElevationOptions;
}

interface ImageMode { kind: "image"; style: CompiledStyle }

/** State shared by a model and its twins: decoded tiles, reads in flight, read error listeners. */
interface Shared {
    entries: Map<string, Float32Array>;
    bytes: number;
    inflight: Map<string, Promise<Float32Array>>;
    listeners: Set<GeoTiffReadErrorListener>;
    reported: Set<string>;
    http: HttpState;
    /** Models (a model and its twins) not disposed yet. */
    models: number;
}

/**
 * Inputs of a STAC model that are opened when a style first reads their bands. Shared by a model and its twins:
 * an input opened by one is opened for all.
 */
interface DeferredInputs {
    /** Inputs not opened yet, in input order, with the band names each gives. */
    pending: { input: BandInput; names: string[] }[];
    /** The opening in flight of each pending input (cleared on failure, so it is retried). */
    opening: Map<BandInput, Promise<void>>;
    blocks: DecodedBlockCache;
    http: HttpState;
    /** The reference identifier of the opened inputs (undefined with `options.reference`). */
    referenceId?: string | null;
    /** Every band name, opened or not, in input order (the order of `getBandNames`). */
    names: string[];
}

interface ModelInit {
    reference: CoordinateReference;
    /** Opened files; shared with twins, and grows when deferred inputs open. */
    files: OpenFile[];
    /** Opened bands; shared with twins, and grows when deferred inputs open. */
    bands: BandSource[];
    deferred: DeferredInputs | null;
    extent: [number, number, number, number];
    mode: ImageMode | ElevationMode;
    options: CreateModelOptions;
    shared: Shared;
    source: ModelSource;
}

/** A lattice of sample positions: x west to east, y north to south. */
interface Lattice { xs: Float64Array; ys: Float64Array; spacingX: number; spacingY: number }

const STATS_KEY_SEPARATOR = "\u0000";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const noop = () => undefined;

/**
 * A LuciadRIA raster model that streams Cloud Optimized GeoTIFFs: one file, several files as bands, mosaics of
 * tiles, STAC items and manifests, shown as imagery styled with band math, or as terrain.
 *
 * - **Imagery** (default): bands from one or more files, at any resolution, are resampled onto a quadtree of
 *   `tileSize` tiles, and rendered with a {@link BandStyle}: composites, indices, colour maps, class tables,
 *   masks. The quadtree starts at the north-west corner of the data; its deepest level has the pixel size of the
 *   finest input, and level 0 has as few tiles as cover the data. Decoded band values are cached, so
 *   {@link setStyle} re-renders without requests when the bands it needs are cached. Statistics-based stretches use
 *   statistics of a coarse grid over the whole data extent (see {@link computeStatistics}), so colours do not
 *   change when the user pans or zooms.
 * - **Terrain** (`dataType: RasterDataType.ELEVATION`): heights from one band or an expression, used as metres,
 *   served as LuciadFusion serves elevation (64 x 64 point samples per tile, as LuciadElev0 PNG tiles).
 * - **Mosaics**: inputs whose bands have the same name form one band; the first input with data at a pixel wins.
 *
 * Create models with {@link GeoTiffTileSetModel.create} and show them with a `RasterTileSetLayer`. Band locations
 * (`"b3"`, `"f1_b3"`) are 1-based as in GDAL; {@link BandInfo.sample} is 0-based.
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const redUrl = ...;                      // URL of a single-band COG with red reflectance
 * const nirUrl = ...;                      // URL of a single-band COG with near infrared reflectance
 * const model = await GeoTiffTileSetModel.create({
 *   inputs: [{url: redUrl, bands: "red"}, {url: nirUrl, bands: "nir"}],
 *   style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9],
 *            colorMap: {stops: [{position: 0, color: "#a50026"}, {position: 1, color: "#006837"}]}}},
 * });
 * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "NDVI"}));
 * ```
 *
 * @category Model
 */
export class GeoTiffTileSetModel extends RasterTileSetModel {
    private readonly _init: ModelInit;
    private readonly _files: OpenFile[];
    private readonly _bands = new Map<string, BandSource>();
    private readonly _tileSize: number;
    private readonly _pool: Pool | null | undefined;
    private readonly _statisticsSize: number;
    private readonly _cacheLimit: number;
    private readonly _shared: Shared;
    private readonly _extent: [number, number, number, number];
    private readonly _elevation: ElevationMode | null;
    private readonly _httpOptions: CreateModelOptions;
    private readonly _perf = {tiles: 0, cacheHits: 0, reads: 0, readMs: 0, renderMs: 0};
    private readonly _styleListeners = new Set<() => void>();
    private _style: CompiledStyle | null;
    private _styleToken = 0;
    private _statistics = new Map<string, BandStatistics | null>();
    private _statisticsSample: { lattice: Lattice; bands: BandArrays; bounds: [number, number, number, number] } | null = null;
    private _statisticsPending: Promise<void> | null = null;
    private _disposed = false;

    private constructor(init: ModelInit) {
        super(structureOf(init));
        const elevation = init.mode.kind === "elevation" ? init.mode : null;
        this._init = init;
        this._elevation = elevation;
        this._tileSize = elevation ? elevation.tileSize : (init.options.tileSize ?? 256);
        this._shared = init.shared;
        this._shared.models++;
        this._files = init.files;
        for (const b of init.bands) this._bands.set(b.info.name, b);
        this._style = init.mode.kind === "image" ? init.mode.style : null;
        this._extent = init.extent;
        this._pool = init.options.pool;
        this._statisticsSize = init.options.statisticsSize ?? 512;
        this._cacheLimit = (init.options.cacheSize ?? 256) * 1024 * 1024;
        this._httpOptions = init.options;
        this.modelDescriptor = {
            name: "GeoTiffTileSetModel",
            description: elevation ? "Terrain from Cloud Optimized GeoTIFFs" : "Bands of Cloud Optimized GeoTIFFs, styled with band math",
            source: "Cloud Optimized GeoTIFF",
        } as ModelDescriptor;
    }

    // ------------------------------------------------------------------------------------------------- factory

    /**
     * Creates a model from exactly one source: `url`, `file`, `inputs`, `stac` or `manifest` (see
     * {@link CreateModelOptions}). The promise resolves when the model is ready to be put in a layer, with the
     * statistics its style needs, so the first tiles already use the final stretch.
     *
     * Requests made before the promise resolves, in this order:
     *
     * 1. **Source**: a manifest URL is fetched once; STAC item URLs are fetched once each, in parallel; a STAC
     *    selection connects to the catalog and runs {@link "ria-geotiff/stac"!StacClient.select | StacClient.select}.
     * 2. **Headers**: each input is signed (when a signer matches) and opened, at most 8 at a time. Opening reads
     *    the file's header in whole 64 KiB range requests: usually one, more when the header is large (many
     *    overviews or tiles). A server without range support sends the whole file.
     * 3. **References**: for each URL input without an EPSG reference or `crsName` (and no `options.reference`), one request
     *    for a `.prj` file next to it, made as the file's own requests are: signed with the input's signer, passed
     *    through `rewriteUrl`, with the input's HTTP options (or `access` hook, kind `"file"`).
     * 4. **Statistics** (imagery whose style has a `percentile`, `stddev` or `minmax` stretch, as the default style
     *    has): a grid of at most `statisticsSize` points per side over the whole data extent, read from the
     *    overview whose pixels match the grid spacing. This costs a few blocks per input, more for large mosaics.
     *    Fixed stretches and elevation models read no data here.
     *
     * - **Band names**: `options.bands` (1-based locations: `"f2_b1"` is band 1 of the second input, `"b3"` band 3
     *   of the only input), else each input's `bands`, else GDAL band descriptions, else `b1`…`bN` (one input) or
     *   `f1_b1`… (several). Terrain from several unnamed single-band inputs is one mosaic band, `elevation`.
     * - **Mosaics**: the same band name in several inputs is one band; the first input with data at a pixel wins.
     *   The extent is the union of the inputs, which must all use the same reference.
     * - **Elevation** (`dataType: RasterDataType.ELEVATION`): one band is the height; with several,
     *   `elevation.height` names one or combines them with an expression.
     * - **STAC** items of one period are a mosaic; several periods a time series with bands `red_2024`, ...
     *   (see {@link StacModelSource}). The model has a band for every data asset, but only the assets the style
     *   reads are opened here; the others are opened when a later style first reads them.
     *
     * The function never throws synchronously: every problem rejects the promise, and nothing is cached after a
     * rejection, so calling `GeoTiffTileSetModel.create` again retries from the start. Inputs are signed (their `sign`, else a
     * matching signer) and rewritten (`rewriteUrl`) before opening. Files do not have to be COGs: a GeoTIFF in
     * strips or without overviews opens too, but reads more data per tile.
     *
     * @param options exactly one source, and the model options, see {@link CreateModelOptions}
     * @returns a promise for the model, with the statistics its style needs. Without `options.style` the model
     *   starts with a default style (a single-band palette file's colours; a STAC time series: true colour of the
     *   last period; else `autoStyle(bandNames)`): read it with `getStyle()`, for example to fill a style editor.
     *   Whether each file is a COG is in `getBands()[i].locations[j].isCog`.
     * @throws {@link GeoTiffModelError} (rejection) with `cause` `ERROR_LOADING_FILE` when a file cannot be fetched
     *   or read (`originalError` holds the network or geotiff.js error), `BoundsMissing` when a file has no
     *   georeferencing or no EPSG reference (and no `options.reference`), `UnknownIdentifier` when LuciadRIA does
     *   not know the reference (`identifier` holds it), `REFERENCE_MISMATCH` when the inputs declare different
     *   references, `INVALIDELEVATION` when elevation is requested from data that cannot hold heights
     *   (`pixelFormat` describes it)
     * @throws {@link StyleError} (rejection) when the style (or `elevation.height`) is invalid for the bands;
     *   `path` names the property
     * @throws {@link ManifestError} (rejection) with the `problems` when a manifest is invalid
     * @throws {@link "ria-geotiff/stac"!StacError | StacError} (rejection, from `ria-geotiff/stac`) when a STAC
     *   request fails (`status`, `url`, `body`), or a selection does not fit or finds no suitable item (`problems`)
     * @throws `RangeError` (rejection) for invalid options: not exactly one source, no inputs, an input without
     *   `url` or `file`, invalid or duplicate band locations, a band name that is not an identifier, no band named,
     *   a `style` with elevation, a missing `elevation.height` with several bands (the message lists the bands), a
     *   non-finite `elevation.noDataHeight`, an `elevation.tileSize` that is not an integer >= 2, an imagery
     *   `tileSize` that is not an integer from 16 to 4096, a `byteCacheSize` that is not a positive number, STAC
     *   items without readable data assets or without the bands needed
     * @throws `Error` (rejection) for a manifest URL that answers with an HTTP error status, or a relative URL in a
     *   manifest without a base (see {@link CreateModelOptions.base})
     * @throws `SyntaxError` (rejection) when manifest text is not JSON
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     * import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
     *
     * const map = ...;   // your LuciadRIA WebGLMap
     *
     * // One COG, with the automatic style.
     * const cogUrl = ...;   // URL of a COG
     * const model = await GeoTiffTileSetModel.create({url: cogUrl});
     * map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
     *
     * // One DEM as terrain.
     * const demUrl = ...;   // URL of a single-band DEM
     * const terrain = await GeoTiffTileSetModel.create({url: demUrl, dataType: RasterDataType.ELEVATION});
     * map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
     *
     * // Name the bands once, then style by name (locations are 1-based, as in GDAL).
     * const named = await GeoTiffTileSetModel.create({
     *   url: cogUrl,
     *   bands: {red: "b3", nir: "b4"},
     *   style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9]}},
     * });
     * map.layerTree.addChild(new RasterTileSetLayer(named, {label: "NDVI"}));
     * ```
     */
    static async create(options: CreateModelOptions): Promise<GeoTiffTileSetModel> {
        const {resolveSource} = await import("./sources/resolve.js");
        const resolved = await resolveSource(options);
        return GeoTiffTileSetModel.build(resolved.inputs, resolved.options, resolved.source, resolved.deferred);
    }

    /**
     * Opens resolved inputs and creates the model.
     *
     * @internal
     */
    static async build(all: BandInput[], options: CreateModelOptions, source: ModelSource, deferredInputs: Set<BandInput> = new Set()): Promise<GeoTiffTileSetModel> {
        const inputs = all?.filter((i) => !deferredInputs.has(i));
        if (!inputs?.length) throw new RangeError("GeoTiffTileSetModel needs at least one input");
        const elevationRequested = options.dataType === RasterDataType.ELEVATION;
        if (elevationRequested && options.style !== undefined) {
            throw new RangeError("A style cannot be used with dataType ELEVATION: create the terrain model, then an imagery twin with withStyle()");
        }
        checkElevationNumbers(options.elevation);
        if (!elevationRequested) checkTileSize(options.tileSize);
        if (options.byteCacheSize !== undefined && !(Number.isFinite(options.byteCacheSize) && options.byteCacheSize > 0)) {
            throw new RangeError(`byteCacheSize must be a positive number of MiB, got ${options.byteCacheSize}`);
        }
        const blocks = new DecodedBlockCache(options.decodedBlocks ?? 96);
        const http: HttpState = {credentials: options.credentials, requestHeaders: options.requestHeaders, requestParameters: options.requestParameters};
        const files = await mapLimited(inputs, 8, (input) => openInput(input, options, blocks, http));
        await Promise.all(files.map((f) => probeOpened(f.tiff)));   // for getModelInfo().isCog and BandLocation.isCog
        files.forEach((f, i) => { f.index = i; });

        let reference = options.reference;
        let referenceId: string | null | undefined;
        if (!reference) {
            const references = await referencesOf(files, options);
            const other = references.findIndex((r) => r !== references[0]);
            if (other > 0) {
                throw new GeoTiffModelError(`All inputs must use the same reference: ${references[0]} (input 1) and ${references[other]} (input ${other + 1})`,
                    "REFERENCE_MISMATCH");
            }
            referenceId = references[0];
            reference = await referenceFor(references[0], options.resolveReference);
        }

        const bands: BandSource[] = [];
        const addBand = (file: OpenFile, sample: number, name: string) => addBandTo(bands, file, sample, name);
        if (options.bands) {
            for (const [name, ref] of Object.entries(options.bands)) {
                if (bands.some((b) => b.info.name === name)) throw new RangeError(`Duplicate band name "${name}"`);
                const {file, sample} = locateBand(ref, files, name);
                await addBand(file, sample, name);
            }
        } else if (options.dataType === RasterDataType.ELEVATION && files.length > 1
            && files.every((f) => f.bandCount === 1 && f.input.bands === undefined)) {
            // Terrain from several unnamed single-band files is a tiled DEM: one mosaic band, in input order.
            for (const file of files) await addBand(file, 0, "elevation");
        } else {
            for (const file of files) {
                const names = await bandNamesOf(file, files.length);
                for (let sample = 0; sample < file.bandCount; sample++) {
                    const name = names[sample];
                    if (name) await addBand(file, sample, name);
                }
            }
        }
        if (bands.length === 0) throw new RangeError("No band is named: the model would have no bands");

        const areas = files.map((f) => areaExtent(f.grids[0]));
        const extent: [number, number, number, number] = [
            Math.min(...areas.map((a) => a[0])), Math.min(...areas.map((a) => a[1])),
            Math.max(...areas.map((a) => a[2])), Math.max(...areas.map((a) => a[3])),
        ];
        const deferred: DeferredInputs | null = deferredInputs.size ? {
            pending: all.filter((i) => deferredInputs.has(i)).map((input) => ({input, names: declaredNames(input)})),
            opening: new Map(), blocks, http, referenceId,
            names: [...new Set(all.flatMap((i) => (deferredInputs.has(i) ? declaredNames(i) : files[inputs.indexOf(i)] ? bandsOfFile(bands, files[inputs.indexOf(i)]) : [])))],
        } : null;
        const bandNames = [...new Set([...bands.map((b) => b.info.name), ...(deferred?.pending.flatMap((p) => p.names) ?? [])])];
        const shared: Shared = {entries: new Map(), bytes: 0, inflight: new Map(), listeners: new Set(), reported: new Set(), http, models: 0};
        if (options.onReadError) shared.listeners.add(options.onReadError);
        const base = {reference, files, bands, deferred, extent, options, shared, source};
        if (elevationRequested) {
            return new GeoTiffTileSetModel({...base, mode: elevationMode(bands, options.elevation ?? {})});
        }
        const styleSpec = options.style === undefined
            ? defaultStyle(files, bands)
            : typeof options.style === "function" ? options.style(bandNames) : options.style;
        const model = new GeoTiffTileSetModel({...base, mode: {kind: "image", style: compileStyle(styleSpec, bandNames)}});
        await model.ensureStatistics(model._style!);
        return model;
    }

    /** Adds the bands opened by a twin (or by this model) since the last call. */
    private syncBands(): void {
        if (this._bands.size === this._init.bands.length) return;
        for (const b of this._init.bands) if (!this._bands.has(b.info.name)) this._bands.set(b.info.name, b);
    }

    /** Opens the deferred inputs that hold any of `names` (once each, shared with twins). */
    private async openBands(names: Iterable<string>): Promise<void> {
        const deferred = this._init.deferred;
        if (deferred) {
            const wanted = new Set(names);
            const needed = deferred.pending.filter((p) => p.names.some((n) => wanted.has(n)));
            const fresh = needed.filter((p) => !deferred.opening.has(p.input));
            if (fresh.length) {
                const job = this.openDeferred(fresh);
                for (const p of fresh) deferred.opening.set(p.input, job);
                job.catch(() => { for (const p of fresh) if (deferred.opening.get(p.input) === job) deferred.opening.delete(p.input); });
            }
            await Promise.all([...new Set(needed.map((p) => deferred.opening.get(p.input)!))]);
        }
        this.syncBands();
    }

    private async openDeferred(entries: { input: BandInput; names: string[] }[]): Promise<void> {
        const deferred = this._init.deferred!;
        const options = this._init.options;
        const files = await mapLimited(entries.map((e) => e.input), 8, (input) => openInput(input, options, deferred.blocks, deferred.http));
        await Promise.all(files.map((f) => probeOpened(f.tiff)));
        if (deferred.referenceId !== undefined) {
            const references = await referencesOf(files, options);
            const other = references.findIndex((r) => r !== deferred.referenceId);
            if (other >= 0) {
                throw new GeoTiffModelError(`All inputs must use the same reference: ${deferred.referenceId} (the model) and ${references[other]} (${files[other].url ?? "an input"})`,
                    "REFERENCE_MISMATCH");
            }
        }
        for (const file of files) {
            file.index = this._init.files.length;
            this._init.files.push(file);
            const names = await bandNamesOf(file, 2);
            for (let sample = 0; sample < file.bandCount; sample++) if (names[sample]) await addBandTo(this._init.bands, file, sample, names[sample]!);
        }
        deferred.pending = deferred.pending.filter((p) => !entries.includes(p));
    }

    // ------------------------------------------------------------------------------------------------- public API

    /**
     * What the model was opened from: the kind of source and, for STAC sources, the items, the periods of a time
     * series, the search plan and the number of items found; for manifests, the manifest. Twins share the source.
     * Makes no requests.
     *
     * @returns the source description; a time slider reads `periods`, an item list `items`
     *
     * @example
     * ```ts
     * // model: a GeoTiffTileSetModel created from STAC items
     * const {kind, items, periods} = model.getSource();
     * if (periods) console.log(`time series of ${periods.length} periods: ${periods.join(", ")}`);
     * else if (kind === "stac") console.log(`mosaic of ${items!.length} items`);
     * ```
     */
    getSource(): ModelSource {
        return {...this._init.source};
    }

    /**
     * Names of the available bands, in input order: every band a style can read. For a STAC model this includes
     * the bands whose assets are not opened yet (see {@link StacModelSource}); {@link getBands} lists the opened
     * ones.
     *
     * @returns the band names (in the order of `options.bands` when it was given)
     */
    getBandNames(): string[] {
        this.syncBands();
        const all = this._init.deferred?.names;
        if (!all) return [...this._bands.keys()];
        return [...all, ...[...this._bands.keys()].filter((n) => !all.includes(n))];
    }

    /**
     * Details of every opened band, including all inputs of mosaic bands. For a STAC model, bands whose assets are
     * not opened yet (no style has read them) are not listed: their details are known once the files are opened.
     *
     * @returns a copy of the {@link BandInfo} of each opened band, in the order they were opened
     */
    getBands(): BandInfo[] {
        this.syncBands();
        return [...this._bands.values()].map((b) => ({...b.info, locations: b.info.locations.map((l) => ({...l}))}));
    }

    /**
     * Whether this is a terrain model (`dataType: RasterDataType.ELEVATION`, or made with {@link asElevation}): it
     * has no style, and goes on the map as LuciadRIA's elevation. Same as `dataType === RasterDataType.ELEVATION`,
     * without importing LuciadRIA's enum.
     */
    get isElevation(): boolean {
        return this._elevation !== null;
    }

    /**
     * The style in use (imagery models).
     *
     * @returns the style last applied (by `GeoTiffTileSetModel.create`, or by a {@link setStyle} whose statistics are ready); null for
     *   elevation models
     */
    getStyle(): BandStyle | null {
        return this._style?.style ?? null;
    }

    /**
     * The height of an elevation model.
     *
     * @returns the band name or expression that gives the heights, with the tile size and the nodata height (when
     *   set); null for imagery models
     */
    getElevation(): {
        /** Band name or expression that gives the heights. */
        height: string;
        /** Number of samples along each side of a tile. */
        tileSize: number;
        /** Height delivered where there is no data, when set. */
        noDataHeight?: number;
    } | null {
        const e = this._elevation;
        if (!e) return null;
        return {height: e.height, tileSize: e.tileSize, ...(Number.isNaN(e.noDataHeight) ? {} : {noDataHeight: e.noDataHeight})};
    }

    /**
     * Applies a new style (imagery models). Asynchronous: the method never throws, every problem rejects the
     * returned promise. The style is validated first, before anything is read. The promise resolves once the
     * statistics the style needs are available, the style is applied and the layer has been invalidated.
     *
     * Requests: none when the bands the style reads are already in the decoded tile cache and its statistics are
     * known. A style that reads other bands costs reads for its statistics (only the new bands of the statistics
     * grid) and for the visible tiles. In a STAC model, bands whose assets are not opened yet are opened first: the
     * header of each of their COGs is read once, for this model and its twins.
     *
     * The style is applied once its statistics exist: until then the layer keeps drawing the previous style. When
     * calls overlap, the last one wins; earlier ones resolve without applying their style. Style change listeners
     * are called when the style is applied. Tiles that are loading when the style changes are not lost: LuciadRIA
     * re-requests them after the invalidation, and their reads in flight continue and fill the cache.
     *
     * @param style the new style
     * @returns a promise that resolves when the style is applied (or superseded by a later call)
     * @throws {@link StyleError} (rejection) when the style is invalid for the bands; `path` names the property, and
     *   the current style stays in use
     * @throws {@link GeoTiffModelError} (rejection) when an asset the style needs cannot be opened (`ERROR_LOADING_FILE`)
     *   or uses another reference (`REFERENCE_MISMATCH`); the current style stays in use, and a later call retries
     * @throws `RangeError` (rejection) for an elevation model (make an imagery twin with {@link withStyle})
     *
     * @example
     * ```ts
     * // model: a GeoTiffTileSetModel with bands "red" and "nir"
     * await model.setStyle({
     *   render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9]},
     * });
     * ```
     */
    async setStyle(style: BandStyle): Promise<void> {
        if (this._elevation) throw new RangeError("An elevation model has no style: make an imagery twin with withStyle()");
        const compiled = compileStyle(style, this.getBandNames());
        const token = ++this._styleToken;
        await this.openBands(compiled.requiredBands);
        await this.ensureStatistics(compiled);
        if (token !== this._styleToken) return;
        this._style = compiled;
        this._styleListeners.forEach((l) => l());
        this.invalidate();
    }

    /**
     * An imagery twin over the same files with another style, for example a true-colour twin to compare against
     * with a swipe, or a coloured view of an elevation model. It shares the open files, downloads, decoded blocks
     * and the decoded tile cache: data read by one is not read again by the other.
     *
     * The twin has its own statistics and style change listeners; read error listeners, the source, the band names
     * and the HTTP options are shared. It starts with this model's statistics region (the last
     * {@link computeStatistics} region, else the whole data extent) and with copies of its statistics, so that a
     * swipe between the two compares the same stretch for the same source. Statistics its style needs beyond
     * those are computed over that region before the promise resolves, reusing the band values of the statistics
     * grid this model has already read. Later {@link computeStatistics} calls on either model change only that
     * model's region.
     *
     * @param style the style of the new model
     * @returns a promise for the imagery twin
     * @throws {@link StyleError} (rejection) when the style is invalid for the bands
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     *
     * const map = ...;                         // your LuciadRIA WebGLMap
     * // model: a GeoTiffTileSetModel with bands "red", "green" and "blue", already on the map
     * const trueColour = await model.withStyle({render: {type: "rgb", red: "red", green: "green", blue: "blue"}});
     * map.layerTree.addChild(new RasterTileSetLayer(trueColour, {label: "True colour"}));
     * ```
     */
    async withStyle(style: BandStyle): Promise<GeoTiffTileSetModel> {
        const compiled = compileStyle(style, this.getBandNames());
        await this.openBands(compiled.requiredBands);
        const twin = new GeoTiffTileSetModel({...this._init, mode: {kind: "image", style: compiled},
            options: {...this._init.options, dataType: RasterDataType.IMAGE}});
        // Same statistics region (and the statistics already known for it), so twins draw the same stretches.
        twin._statistics = new Map(this._statistics);
        const sample = this._statisticsSample;
        if (sample) twin._statisticsSample = {...sample, bands: {...sample.bands}};
        await twin.ensureStatistics(compiled);
        return twin;
    }

    /**
     * An elevation twin over the same files: the bands served as terrain. It shares the open files, downloads,
     * decoded blocks and decoded tiles with this model, so showing one DEM as terrain and as a coloured layer reads
     * nothing twice. Creating the twin makes no requests.
     *
     * @param elevation which values are the heights, tile size and nodata height, see {@link ElevationOptions}.
     *   Default: the elevation options of this model when it is an elevation model, else none (one band).
     * @returns a promise for the elevation twin
     * @throws `RangeError` (rejection) when the model has several bands and `elevation.height` is missing (the
     *   message lists the bands), or `noDataHeight` is not finite
     * @throws {@link StyleError} (rejection) when `elevation.height` is not a band or a valid expression over the
     *   bands; `path` is `elevation.height`
     * @throws {@link GeoTiffModelError} (rejection) with cause `INVALIDELEVATION` when a band of the height cannot
     *   hold heights
     *
     * @example
     * ```ts
     * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
     *
     * const map = ...;                         // your LuciadRIA WebGLMap
     * // model: a GeoTiffTileSetModel of a DEM, shown as imagery
     * const terrain = await model.asElevation();
     * map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
     * ```
     */
    async asElevation(elevation?: ElevationOptions): Promise<GeoTiffTileSetModel> {
        const options = elevation ?? this._elevation?.options ?? {};
        checkElevationNumbers(options);
        await this.openBands(heightBands(options.height));
        const mode = elevationMode([...this._bands.values()], options);
        return new GeoTiffTileSetModel({...this._init, mode,
            options: {...this._init.options, dataType: RasterDataType.ELEVATION, elevation: options}});
    }

    /**
     * Registers a listener that is called after each {@link setStyle}, once the new style is applied.
     *
     * @param listener called without arguments; read the new style with {@link getStyle}
     * @returns a handle whose `remove()` unregisters the listener
     */
    addStyleChangeListener(listener: () => void): {
        /** Unregisters the listener. */
        remove(): void;
    } {
        this._styleListeners.add(listener);
        return {remove: () => { this._styleListeners.delete(listener); }};
    }

    /**
     * Statistics of the style's sources, computed when missing (also for styles that do not need them, such as
     * fixed stretches: for histograms in a user interface). Same region as the last {@link computeStatistics}.
     *
     * @returns a promise for the statistics, one entry per source of the style (see {@link getStatistics}); empty
     *   for elevation models
     */
    async requestStatistics(): Promise<(BandStatistics | null)[]> {
        if (!this._style) return [];
        await this.ensureStatistics(this._style, true);
        return this.getStatistics();
    }

    /**
     * Statistics of the style's sources (null where not computed or no valid data).
     *
     * A source (a "value source") is a band or expression of the style: the red, green and blue channels of an RGB
     * render, the band or expression of a pseudocolor render, the `sources` of a custom render. It is not the same
     * as the model's source ({@link getSource}). Statistics leave out missing data and pixels hidden by the style's
     * mask. They are kept per source and mask, so a later style with the same source and mask reuses them.
     *
     * @returns one entry per source of the style, in order; null where not computed or without valid data; empty
     *   for elevation models
     */
    getStatistics(): (BandStatistics | null)[] {
        const style = this._style;
        if (!style) return [];
        return style.sources.map((s) => this._statistics.get(this.statisticsKey(style, s.key)) ?? null);
    }

    /**
     * The stretch ranges in effect for the style's sources.
     *
     * @returns one resolved stretch per source of the style, in order, computed from the current statistics; empty
     *   for elevation models
     */
    getResolvedStretches(): ResolvedStretch[] {
        return this._style ? this._style.resolveStretches(this.getStatistics()) : [];
    }

    /**
     * A legend for the current style, using the resolved stretch ranges.
     *
     * @returns a ramp (with a CSS gradient and stops in data units), a class table, the three RGB channels with
     *   their ranges, or for function colour maps and custom renders only the range, see {@link Legend}; null for
     *   elevation models
     *
     * @example
     * ```ts
     * // model: a GeoTiffTileSetModel with a pseudocolor style
     * const legend = model.getLegend();
     * if (legend?.kind === "ramp") {
     *   legendElement.style.background = legend.gradient;  // legendElement: an HTMLElement of the application
     *   legendElement.title = `${legend.min} – ${legend.max}`;
     * }
     * ```
     */
    getLegend(): Legend | null {
        return this._style ? legendOf(this._style, this.getStatistics()) : null;
    }

    /**
     * Recomputes the statistics of the style's sources from a sample of `bounds` (in the model reference), or of
     * the whole data extent. Use it for a stretch adapted to the current view. Invalidates the layer.
     *
     * Statistics are never updated by themselves: without this call they describe the whole data extent, and
     * colours stay the same while the user pans and zooms. After this call they describe the region until the
     * next call.
     *
     * The region is clipped to the data extent and sampled on a grid with `statisticsSize` points along its longer
     * side. Each input is read from the overview whose pixels match the grid spacing, so a small region is read at
     * a finer resolution than the whole extent. The new statistics replace the old ones as a whole once computed;
     * until then tiles keep using the old ones. Later style changes compute their statistics over the same region,
     * and twins made afterwards with {@link withStyle} start with it; twins that already exist keep their own.
     * When the region does not overlap the data, nothing is computed and the current statistics are returned.
     * Elevation models have no statistics.
     *
     * @param bounds the region, as LuciadRIA `Bounds` or `[minX, minY, maxX, maxY]`, in the model reference.
     *   Default: the whole data extent.
     * @returns a promise for the new statistics, one entry per source of the style (see {@link getStatistics})
     *
     * @example
     * ```ts
     * import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
     *
     * const map = ...;                         // your LuciadRIA WebGLMap
     * // model: a GeoTiffTileSetModel on the map
     * const visible = createTransformation(map.reference, model.reference).transformBounds(map.mapBounds);
     * await model.computeStatistics(visible);  // stretch for the current view
     * await model.computeStatistics();         // back to statistics of the whole data extent
     * ```
     */
    async computeStatistics(bounds?: Bounds | [number, number, number, number]): Promise<(BandStatistics | null)[]> {
        const style = this._style;
        if (!style) return [];
        const area = bounds
            ? (Array.isArray(bounds) ? bounds : [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height]) as [number, number, number, number]
            : this._extent;
        const [e0, e1, e2, e3] = this._extent;
        const clipped: [number, number, number, number] = [Math.max(area[0], e0), Math.max(area[1], e1), Math.min(area[2], e2), Math.min(area[3], e3)];
        if (!(clipped[2] > clipped[0] && clipped[3] > clipped[1])) return this.getStatistics();
        const next = new Map<string, BandStatistics | null>();
        const sample = await this.computeStatisticsFor(style, clipped, next, null);
        this._statistics = next;
        this._statisticsSample = sample;
        if (this._style !== style) await this.ensureStatistics(this._style!);
        this.invalidate();
        return this.getStatistics();
    }

    /**
     * Band values at a point, and the values of the style's sources (for elevation models: `height`).
     * `options.bands` limits the bands read (default: all); the bands the style or the height needs are always
     * included. Returns null outside the data extent.
     *
     * The point is in the model reference (`model.reference`), not in map or view coordinates: transform a mouse
     * position first, as in the example. Imagery values are read from the full-resolution image of each input
     * (not from the tile cache), with the input's resampling; elevation heights are interpolated from the finest
     * image. Each call makes range requests unless the blocks are among the fetched bytes kept in memory. Values
     * have scale and offset applied; missing data is NaN. Mosaic bands give the first input with data. Unknown
     * names in `options.bands` are ignored.
     *
     * @param x x coordinate in the model reference
     * @param y y coordinate in the model reference
     * @param options `bands`: names of the bands to read. Default: all bands.
     * @returns a promise for the values, or for null when the point lies outside the data extent. `sources` is
     *   keyed by the source's text: the band name, the expression as written (trimmed), or the JSON text of a
     *   JSON-array expression.
     *
     * @example
     * ```ts
     * import {createPoint} from "@luciad/ria/shape/ShapeFactory.js";
     * import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
     * import {LocationMode} from "@luciad/ria/transformation/LocationMode.js";
     *
     * const map = ...;                         // your LuciadRIA WebGLMap
     * // model: a GeoTiffTileSetModel with bands "red" and "nir" and an NDVI style, on the map
     * const mapToModel = createTransformation(map.reference, model.reference);
     * map.domNode.addEventListener("click", async (event) => {
     *   const rect = map.domNode.getBoundingClientRect();
     *   const viewPoint = createPoint(null, [event.clientX - rect.left, event.clientY - rect.top]);
     *   try {
     *     const mapPoint = map.getViewToMapTransformation(LocationMode.CLOSEST_SURFACE).transform(viewPoint);
     *     const p = mapToModel.transform(mapPoint);
     *     const values = await model.getValuesAt(p.x, p.y, {bands: ["red", "nir"]});
     *     if (values) console.log(values.bands.red, values.bands.nir, values.sources["(nir - red) / (nir + red)"]);
     *   } catch {
     *     // the click is not on the earth, or outside the model reference's domain
     *   }
     * });
     * ```
     */
    async getValuesAt(x: number, y: number, options: {
        /** Names of the bands to read. Default: all bands. */
        bands?: string[];
    } = {}): Promise<{
        /** Value of each band read, by band name. */
        bands: Record<string, number>;
        /** Value of each source of the style (band name or expression text, as in the legend), or `height`. */
        sources: Record<string, number>;
    } | null> {
        const [minX, minY, maxX, maxY] = this._extent;
        if (x < minX || x > maxX || y < minY || y > maxY) return null;
        const finest = Math.min(...this._files.map((f) => f.grids[0].resX));
        const lattice: Lattice = {xs: Float64Array.of(x), ys: Float64Array.of(y), spacingX: finest, spacingY: finest};
        const required = this._style ? this._style.requiredBands : this._elevation!.requiredBands;
        if (options.bands) await this.openBands(options.bands);
        const names = options.bands
            ? [...new Set([...options.bands, ...required])].filter((b) => this._bands.has(b))
            : [...this._bands.keys()];
        const arrays = this._elevation
            ? await this.sampleHeights(names, lattice.xs, lattice.ys, finest, finest, null)
            : await this.sampleBands(names, lattice, null, true);
        const bands: Record<string, number> = {};
        for (const name of names) bands[name] = arrays[name][0];
        const sources: Record<string, number> = {};
        if (this._style) {
            const values = this._style.evaluate(arrays, 1);
            this._style.sources.forEach((s, i) => { sources[s.key] = values[i][0]; });
        } else {
            sources.height = this._elevation!.evaluate(arrays, 1)[0];
        }
        return {bands, sources};
    }

    /**
     * Registers a listener for read errors, see {@link GeoTiffReadError}: data of a file that cannot be read while
     * serving tiles or statistics. The affected values are then read from a finer image (elevation) or missing (no
     * data). Each combination of file and image is reported once. Listeners are shared with twins
     * ({@link withStyle}, {@link asElevation}), which read the same files. While at least one listener is registered
     * the model does not log these errors itself.
     *
     * @param listener called with each {@link GeoTiffReadError}
     * @returns a handle whose `remove()` unregisters the listener
     */
    addReadErrorListener(listener: GeoTiffReadErrorListener): {
        /** Unregisters the listener. */
        remove(): void;
    } {
        this._shared.listeners.add(listener);
        return {remove: () => { this._shared.listeners.delete(listener); }};
    }

    /**
     * Timing counters since creation.
     *
     * @returns tile counts, average read and render times, and the bytes in the decoded tile cache (shared with
     *   twins)
     */
    getPerformance(): ModelPerformance {
        const p = this._perf;
        return {tiles: p.tiles, cacheHits: p.cacheHits, readMs: p.reads ? p.readMs / p.reads : 0,
            renderMs: p.tiles ? p.renderMs / p.tiles : 0, cacheBytes: this._shared.bytes};
    }

    /**
     * Extent of the data `[minX, minY, maxX, maxY]` in the model reference.
     *
     * @returns a copy of the union of the outer pixel edges of all inputs (the tile set bounds can be different)
     */
    getDataExtent(): [number, number, number, number] {
        return [...this._extent];
    }

    /**
     * Releases the decoded tile cache (shared with twins). Tiles drawn afterwards read their band values again.
     * Reads in flight still complete into the cache.
     */
    clearCache(): void {
        this._shared.entries.clear();
        this._shared.bytes = 0;
    }

    /**
     * Releases the model, for example when its layer is removed from the map: its statistics, style listeners and
     * read error listeners are dropped and it delivers no more tiles (LuciadRIA gets an error for each). The data
     * shared with twins (decoded tiles, decoded blocks, fetched bytes, open files) is released with the last of
     * them to be disposed. Remove the layer from the map first. Calling it again does nothing.
     *
     * @example
     * ```ts
     * const map = ...;     // your LuciadRIA WebGLMap
     * const layer = ...;   // a RasterTileSetLayer of a GeoTiffTileSetModel, on the map
     * map.layerTree.removeChild(layer);
     * (layer.model as GeoTiffTileSetModel).dispose();
     * ```
     */
    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._statistics.clear();
        this._statisticsSample = null;
        this._styleListeners.clear();
        const shared = this._shared;
        if (--shared.models > 0) return;
        shared.entries.clear();
        shared.bytes = 0;
        shared.inflight.clear();
        shared.listeners.clear();
        for (const file of this._init.files) {
            file.blocks.clear();
            // Drops geotiff.js' cache of fetched bytes (and closes a file reader).
            void Promise.resolve((file.tiff as unknown as { close?: () => unknown }).close?.()).catch(() => undefined);
        }
    }

    /**
     * Information about the first GeoTIFF of the model: size, tiling, bands, pixel layout and reference. Step 1
     * (capabilities) for a single file; see also {@link GeoTiffTileSetModel.infoFromURL}.
     *
     * @returns the information of the full-resolution image; `tileMatrix` is not set
     */
    getModelInfo(): GeoTiffTileSetModelInfo {
        return describeImage(this._files[0].images[0], this._files[0].tiff);
    }

    /**
     * Cookies and HTTP authentication of the next requests (LuciadRIA's option): `true` = `"include"`, `false` or
     * unset = `"same-origin"`, or a fetch mode. Shared with twins; nothing already read is read again.
     *
     * @returns the current value
     */
    get credentials(): boolean | RequestCredentials | undefined {
        return this._shared.http.credentials;
    }

    /**
     * Sets the credentials mode of the next requests.
     *
     * @param value the new value
     */
    set credentials(value: boolean | RequestCredentials | undefined) {
        this._shared.http.credentials = value;
    }

    /**
     * Headers of the next requests to the intended servers. Set it to renew an expiring token: new requests use the
     * new value at once, without rebuilding the model; nothing already read is read again. Shared with twins.
     *
     * It applies to the inputs that get the model's options (see {@link CreateModelOptions.access}) and have no
     * `requestHeaders` of their own. STAC assets never get it: renew their tokens in the `stac.assetAccess` hook,
     * which is called for every request.
     *
     * @returns the current headers, or null/undefined for none
     *
     * @example
     * ```ts
     * // model: a GeoTiffTileSetModel created with requestHeaders; token: a renewed token of the application
     * model.requestHeaders = {Authorization: `Bearer ${token}`};
     * ```
     */
    get requestHeaders(): HttpRequestHeaders | null | undefined {
        return this._shared.http.requestHeaders;
    }

    /**
     * Sets the headers of the next requests.
     *
     * @param value the new headers, or null for none
     */
    set requestHeaders(value: HttpRequestHeaders | null | undefined) {
        this._shared.http.requestHeaders = value;
    }

    /**
     * Query parameters of the next requests to the intended servers (`{token: "…"}`), as {@link requestHeaders}.
     *
     * @returns the current parameters, or null/undefined for none
     */
    get requestParameters(): HttpRequestParameters | null | undefined {
        return this._shared.http.requestParameters;
    }

    /**
     * Sets the query parameters of the next requests.
     *
     * @param value the new parameters, or null for none
     */
    set requestParameters(value: HttpRequestParameters | null | undefined) {
        this._shared.http.requestParameters = value;
    }

    /**
     * Reads the header of a GeoTIFF and returns what is known about it, without creating a model: step 1
     * (capabilities) for a single file.
     *
     * Use it to decide how to show a file (imagery or elevation, bands) before creating the model. The file does not
     * need to be a COG. When the file declares no EPSG reference, `crsName` is read from a `.prj` file next to it,
     * if there is one. It reads the header as {@link create} does (whole 64 KiB range requests, usually one), plus
     * at most one `.prj` request, and no pixel data. `url` is used as given: no signers, no `rewriteUrl`. `crsName`
     * is not checked against LuciadRIA's known references. `bands` counts the file's samples, so band names are
     * `b1`…`bN` unless the file has GDAL band descriptions (see {@link BandInput.bands}).
     *
     * @param url URL of the GeoTIFF
     * @param options HTTP options for the requests. Default none.
     * @returns a promise for the information, including `tileMatrix`: one entry per image, full resolution first
     * @throws {@link GeoTiffModelError} with cause `ERROR_LOADING_FILE` when the file cannot be read
     *
     * @example
     * ```ts
     * import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
     *
     * const url = ...;                         // URL of a GeoTIFF, provided by the application
     * const info = await GeoTiffTileSetModel.infoFromURL(url);
     * console.log(`${info.width} x ${info.height}, ${info.bands} band(s), ${info.crsName}, COG: ${info.isCog}`);
     * const dataType = info.canBeElevation && info.bands === 1 ? RasterDataType.ELEVATION : RasterDataType.IMAGE;
     * ```
     */
    static async infoFromURL(url: string, options: GetInfoGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModelInfo> {
        const tiff = await openURL(url, () => options);
        const images = await readImages(tiff);
        await probeOpened(tiff);
        const info = describeImage(images[0], tiff);
        info.tileMatrix = images
            .filter((image) => !isMaskImage(image))
            .sort((a, b) => b.getWidth() * b.getHeight() - a.getWidth() * a.getHeight())
            .map((image, zoom) => ({
                zoom,
                tileColumnCount: Math.ceil(image.getWidth() / image.getTileWidth()),
                tileRowCount: Math.ceil(image.getHeight() / image.getTileHeight()),
                tileWidth: image.getTileWidth(),
                tileHeight: image.getTileHeight(),
            }));
        if (!info.crsName) info.crsName = await getReferenceFromPrjFile(url, options);
        return info;
    }

    // ------------------------------------------------------------------------------------------------- tiles

    /**
     * Not used: this model delivers its tiles through {@link getTileData}. Always calls `onError` with an `Error`.
     *
     * @param tile the requested tile
     * @param _s not called
     * @param onError called with the tile and an `Error`
     */
    override getImage(tile: TileCoordinate, _s: unknown, onError: (tile: TileCoordinate, error?: unknown) => void): void {
        onError(tile, new Error("GeoTiffTileSetModel delivers tiles through getTileData"));
    }

    /**
     * Delivers one tile; called by LuciadRIA.
     *
     * Imagery: the band values the style needs are taken from the decoded tile cache, or read (from the most
     * suitable image of each file) and cached, then the style renders an RGBA tile of `tileSize` pixels. Elevation:
     * heights are interpolated at the tile's sample positions (falling back to a finer image when an overview
     * cannot be read) and delivered as a LuciadFusion LuciadElev0 PNG. Reads in flight are shared and never
     * cancelled: a tile requested again after an abort joins the read.
     *
     * @param tile the requested tile
     * @param onSuccess called with the tile and its data, unless the request was aborted
     * @param onError called with the tile and the error when the tile cannot be produced; not called for aborted
     *   requests
     * @param signal LuciadRIA's abort signal for the request
     */
    override getTileData(
        tile: TileCoordinate,
        onSuccess: (tile: TileCoordinate, data: TileData) => void,
        onError: (tile: TileCoordinate, error: unknown) => void,
        signal: AbortSignal | null,
    ): void {
        if (this._disposed) {
            onError(tile, new Error("The GeoTiffTileSetModel was disposed"));
            return;
        }
        const run = this._elevation ? this.elevationTile(tile, this._elevation, signal) : this.renderTile(tile, signal);
        run.then(
            (data) => { if (!signal?.aborted) onSuccess(tile, data); },
            (error) => { if (!signal?.aborted) onError(tile, error); },
        );
    }

    /** Band values of a tile from the cache, else read once (shared by concurrent requests and twins). */
    private async tileBands(names: string[], key: string, read: (names: string[]) => Promise<BandArrays>, signal: AbortSignal | null): Promise<BandArrays> {
        const bands: BandArrays = {};
        const missing: string[] = [];
        for (const name of names) {
            const cached = this.cacheGet(`${name}@${key}`);
            if (cached) bands[name] = cached;
            else missing.push(name);
        }
        this._perf.tiles++;
        if (missing.length === 0) {
            this._perf.cacheHits++;
            return bands;
        }
        // Reads are shared and never cancelled: LuciadRIA aborts the pending tiles of a layer when it is invalidated
        // (every restyle), and the re-requested tiles need exactly the same band data.
        const inflight = this._shared.inflight;
        const toRead = missing.filter((name) => !inflight.has(`${name}@${key}`));
        if (toRead.length) {
            const start = now();
            const reading = read(toRead).then((values) => {
                for (const name of toRead) this.cachePut(`${name}@${key}`, values[name]);
                this._perf.reads++;
                this._perf.readMs += now() - start;
                return values;
            }).finally(() => {
                for (const name of toRead) inflight.delete(`${name}@${key}`);
            });
            for (const name of toRead) inflight.set(`${name}@${key}`, reading.then((values) => values[name]));
        }
        const values = await Promise.all(missing.map((name) => inflight.get(`${name}@${key}`)
            ?? Promise.resolve(this.cacheGet(`${name}@${key}`)!)));
        missing.forEach((name, i) => { bands[name] = values[i]; });
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        return bands;
    }

    private async renderTile(tile: TileCoordinate, signal: AbortSignal | null): Promise<TileData> {
        const n = this._tileSize;
        const style = this._style!;
        // Never draw with a fallback stretch: a region change (computeStatistics) can race a restyle.
        if (!this.statisticsReady(style)) await this.ensureStatistics(style);
        const fast = await this.fastRgbTile(tile, style).catch(() => null);
        if (fast) return fast;
        const key = `i${n}:${tile.level}/${tile.x}/${tile.y}`;
        const bands = await this.tileBands(style.requiredBands, key, (names) => {
            const b = this.getTileBounds(tile);
            return this.sampleBands(names, latticeOf(b.x, b.y, b.x + b.width, b.y + b.height, n, n), null, false);
        }, signal);
        const start = now();
        const rgba = style.render(bands, n * n, this.getStatistics());
        this._perf.renderMs += now() - start;
        return {data: rgba.buffer as ArrayBuffer, pixelFormat: PixelFormat.RGBA_8888, width: n, height: n};
    }

    /**
     * Fast path for RGB composites of three 8-bit bands of one file, on tiles whose pixels coincide with the
     * pixels of an image of the file: the bytes go through a 256-entry table per channel, without resampling or
     * the decoded tile cache. Returns null when the tile does not qualify.
     */
    private async fastRgbTile(tile: TileCoordinate, style: CompiledStyle): Promise<TileData | null> {
        const render = style.style.render;
        if (render.type !== "rgb" || style.style.mask?.length || (render.saturation ?? 1) !== 1) return null;
        if (style.sources.some((s) => !s.band)) return null;
        const sources = style.sources.map((s) => this._bands.get(s.band!)!);
        if (sources.some((s) => s.parts.length !== 1)) return null;
        const file = sources[0].parts[0].file;
        if (sources.some((s) => s.parts[0].file !== file || s.parts[0].scale !== 1 || s.parts[0].offset !== 0)) return null;
        const main = file.images[0];
        if (file.colourModel || file.nodata !== null || file.masks.some(Boolean) || bitsPerSampleOf(main) !== 8 || sampleFormatOf(main) !== 1) return null;
        const n = this._tileSize;
        const b = this.getTileBounds(tile);
        const spacingX = b.width / n, spacingY = b.height / n;
        const k = chooseImage(file.grids, spacingX, spacingY);
        const grid = file.grids[k];
        const aligned = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
        const c0 = columnOf(grid, b.x + spacingX / 2), r0 = rowOf(grid, b.y + b.height - spacingY / 2);
        if (Math.abs(spacingX / grid.resX - 1) > 1e-9 || Math.abs(spacingY / grid.resY - 1) > 1e-9 || !aligned(c0) || !aligned(r0)) return null;
        const left = Math.round(c0), top = Math.round(r0);
        const x0 = Math.max(0, left), y0 = Math.max(0, top);
        const x1 = Math.min(grid.width, left + n), y1 = Math.min(grid.height, top + n);
        const start = now();
        const out = new Uint8ClampedArray(n * n * 4);
        if (x1 > x0 && y1 > y0) {
            const samples = sources.map((s) => s.parts[0].sample);
            const raster = await file.images[k].readRasters({window: [x0, y0, x1, y1], samples, interleave: true,
                pool: this.pool() ?? undefined}) as unknown as Uint8Array;
            // Channel tables from the style itself: 0..255 through stretch and gamma.
            const ramp = new Float32Array(256);
            for (let v = 0; v < 256; v++) ramp[v] = v;
            const table = style.render(Object.fromEntries(style.sources.map((s) => [s.band!, ramp])), 256, this.getStatistics());
            const w = x1 - x0;
            for (let y = y0; y < y1; y++) {
                let src = (y - y0) * w * 3;
                let dst = ((y - top) * n + (x0 - left)) * 4;
                for (let x = x0; x < x1; x++, src += 3, dst += 4) {
                    out[dst] = table[raster[src] * 4];
                    out[dst + 1] = table[raster[src + 1] * 4 + 1];
                    out[dst + 2] = table[raster[src + 2] * 4 + 2];
                    out[dst + 3] = 255;
                }
            }
        }
        this._perf.tiles++;
        this._perf.renderMs += now() - start;
        return {data: out.buffer as ArrayBuffer, pixelFormat: PixelFormat.RGBA_8888, width: n, height: n};
    }

    private async elevationTile(tile: TileCoordinate, mode: ElevationMode, signal: AbortSignal | null): Promise<TileData> {
        const n = mode.tileSize;
        const tileBounds = this.getTileBounds(tile);
        const key = `e${n}:${tile.level}/${tile.x}/${tile.y}`;
        const bands = await this.tileBands(mode.requiredBands, key, (names) => {
            const {xs, ys} = samplePositions(tileBounds, n);
            return this.sampleHeights(names, xs, ys, tileBounds.width / (n - 1), tileBounds.height / (n - 1), signal);
        }, signal);
        const heights = mode.evaluate(bands, n * n);
        if (!Number.isNaN(mode.noDataHeight)) {
            for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) heights[i] = mode.noDataHeight;
        }
        // LuciadRIA's terrain decodes compressed elevation images (LuciadFusion's LuciadElev0 PNG).
        return {data: encodeLuciadElevationPng(heights, n, n), mimeType: "image/png"};
    }

    // ------------------------------------------------------------------------------------------------- sampling

    /** Values of the given bands at the lattice points (NaN where missing), with scale/offset applied; mosaics merged. */
    private async sampleBands(names: string[], lattice: Lattice, signal: AbortSignal | null, fullResolution: boolean): Promise<BandArrays> {
        const byFile = new Map<OpenFile, BandPart[]>();
        const sources = names.map((name) => {
            const source = this._bands.get(name);
            if (!source) throw new Error(`Unknown band ${name}`);
            for (const part of source.parts) {
                const list = byFile.get(part.file) ?? [];
                if (!list.includes(part)) list.push(part);
                byFile.set(part.file, list);
            }
            return source;
        });
        const values = new Map<BandPart, Float32Array>();
        await Promise.all([...byFile.entries()].map(async ([file, parts]) => {
            const read = await this.sampleFile(file, parts.map((p) => p.sample), lattice, signal, fullResolution);
            parts.forEach((p, i) => {
                const v = read[i];
                if (p.scale !== 1 || p.offset !== 0) for (let k = 0; k < v.length; k++) v[k] = v[k] * p.scale + p.offset;
                values.set(p, v);
            });
        }));
        const result: BandArrays = {};
        sources.forEach((source) => {
            const first = values.get(source.parts[0])!;
            const merged = source.parts.length === 1 ? first : Float32Array.from(first);
            for (const part of source.parts.slice(1)) {
                const v = values.get(part)!;
                for (let k = 0; k < merged.length; k++) if (merged[k] !== merged[k]) merged[k] = v[k];
            }
            result[source.info.name] = merged;
        });
        return result;
    }

    private async sampleFile(file: OpenFile, samples: number[], lattice: Lattice, signal: AbortSignal | null, fullResolution: boolean): Promise<Float32Array[]> {
        const {xs, ys} = lattice;
        const count = xs.length * ys.length;
        const empty = () => samples.map(() => new Float32Array(count).fill(Number.NaN));
        const k = fullResolution ? 0 : chooseImage(file.grids, lattice.spacingX, lattice.spacingY);
        const grid = file.grids[k];
        const bilinear = file.resampling === "bilinear";

        // Source pixels (and weights) of each lattice column and row: absolute indices, -1 outside the image.
        const ix0 = new Int32Array(xs.length), ix1 = new Int32Array(xs.length), wx = new Float32Array(xs.length);
        const iy0 = new Int32Array(ys.length), iy1 = new Int32Array(ys.length), wy = new Float32Array(ys.length);
        const prepare = (coords: Float64Array, size: number, i0: Int32Array, i1: Int32Array, w: Float32Array) => {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < coords.length; i++) {
                const c = coords[i];
                // 0 = centre of the first pixel; a pixel covers [c - 0.5, c + 0.5).
                if (!(c >= -0.5 && c < size - 0.5)) { i0[i] = -1; continue; }
                if (bilinear && size > 1) {
                    const f = Math.min(Math.max(c, 0), size - 1);
                    const a = Math.min(Math.floor(f), size - 2);
                    i0[i] = a;
                    i1[i] = a + 1;
                    w[i] = f - a;
                } else {
                    i0[i] = i1[i] = Math.min(Math.max(Math.round(c), 0), size - 1);
                    w[i] = 0;
                }
                lo = Math.min(lo, i0[i]);
                hi = Math.max(hi, i1[i]);
            }
            return [lo, hi + 1];
        };
        const [left, right] = prepare(xs.map((x) => columnOf(grid, x)), grid.width, ix0, ix1, wx);
        const [top, bottom] = prepare(ys.map((y) => rowOf(grid, y)), grid.height, iy0, iy1, wy);
        if (left === Infinity || top === Infinity) return empty();
        const ww = right - left;
        for (const arr of [ix0, ix1]) for (let i = 0; i < arr.length; i++) if (ix0[i] >= 0) arr[i] -= left;
        for (const arr of [iy0, iy1]) for (let i = 0; i < arr.length; i++) if (iy0[i] >= 0) arr[i] -= top;

        let rasters: NumericArray[];
        let mask: NumericArray | null = null;
        try {
            const window = [left, top, right, bottom];
            const maskImage = file.masks[k];
            [rasters, mask] = await Promise.all([
                this.readWithRetry(file, k, window, samples, signal),
                maskImage ? maskImage.readRasters({window, pool: this.pool() ?? undefined})
                    .then((m) => (Array.isArray(m) ? m[0] : m) as unknown as NumericArray) : Promise.resolve(null),
            ]);
        } catch (error) {
            if (signal?.aborted || (error as Error)?.name === "AbortError") throw error;
            this.reportReadFailure(file, k, error, false);
            return empty();
        }

        const nodata = file.nodata;
        // Float32 data holds the nodata value rounded to float32 (GDAL writes it in full double precision).
        const nodata32 = nodata === null ? null : Math.fround(nodata);
        const out = empty();
        samples.forEach((_, s) => {
            const src = rasters[s];
            const dst = out[s];
            const valid = (o: number) => {
                const v = src[o];
                return v === v && v !== nodata && v !== nodata32 && (mask === null || mask[o] !== 0);
            };
            for (let j = 0; j < ys.length; j++) {
                if (iy0[j] < 0) continue;
                const rowA = iy0[j] * ww, rowB = iy1[j] * ww, fy = wy[j];
                for (let i = 0; i < xs.length; i++) {
                    if (ix0[i] < 0) continue;
                    const oa = rowA + ix0[i];
                    if (!bilinear) {
                        if (valid(oa)) dst[j * xs.length + i] = src[oa];
                        continue;
                    }
                    const ob = rowA + ix1[i], oc = rowB + ix0[i], od = rowB + ix1[i];
                    if (valid(oa) && valid(ob) && valid(oc) && valid(od)) {
                        const fx = wx[i];
                        dst[j * xs.length + i] = (src[oa] * (1 - fx) + src[ob] * fx) * (1 - fy) + (src[oc] * (1 - fx) + src[od] * fx) * fy;
                    } else {
                        // Next to missing data: nearest valid neighbour instead of mixing in nodata.
                        const nearest = fy < 0.5 ? (wx[i] < 0.5 ? oa : ob) : (wx[i] < 0.5 ? oc : od);
                        if (valid(nearest)) dst[j * xs.length + i] = src[nearest];
                    }
                }
            }
        });
        return out;
    }

    /**
     * Heights of the given bands at point samples (xs west to east, ys north to south), interpolated from the most
     * suitable image of each input, as LuciadFusion does; mosaics merged in input order. A failed overview read
     * falls back to a finer image of the same file, then to nodata.
     */
    private async sampleHeights(names: string[], xs: Float64Array, ys: Float64Array, spacingX: number, spacingY: number,
        signal: AbortSignal | null): Promise<BandArrays> {
        const nx = xs.length, ny = ys.length;
        const result: BandArrays = {};
        await Promise.all(names.map(async (name) => {
            const source = this._bands.get(name);
            if (!source) throw new Error(`Unknown band ${name}`);
            const blocks = await Promise.all(source.parts.map(async (part) => {
                const [minX, minY, maxX, maxY] = areaExtent(part.file.grids[0]);
                let i0 = 0, i1 = nx - 1, j0 = 0, j1 = ny - 1;
                while (i0 < nx && xs[i0] < minX) i0++;
                while (i1 >= 0 && xs[i1] > maxX) i1--;
                while (j0 < ny && ys[j0] > maxY) j0++;   // ys run north to south
                while (j1 >= 0 && ys[j1] < minY) j1--;
                if (i0 > i1 || j0 > j1) return null;     // the file does not cover these samples
                const fx = xs.subarray(i0, i1 + 1), fy = ys.subarray(j0, j1 + 1);
                const block = await this.readFileHeights(part, chooseImage(part.file.grids, spacingX, spacingY), fx, fy, signal);
                return block ? {block, i0, j0, w: fx.length, h: fy.length} : null;
            }));
            const heights = new Float32Array(nx * ny).fill(Number.NaN);
            blocks.forEach((b, p) => {
                if (!b) return;
                const {scale, offset} = source.parts[p];
                for (let j = 0; j < b.h; j++) {
                    for (let i = 0; i < b.w; i++) {
                        const o = (b.j0 + j) * nx + b.i0 + i;
                        const h = b.block[j * b.w + i];
                        if (Number.isNaN(heights[o]) && !Number.isNaN(h)) heights[o] = h * scale + offset;
                    }
                }
            });
            result[name] = heights;
        }));
        return result;
    }

    private async readFileHeights(part: BandPart, k: number, fx: Float64Array, fy: Float64Array, signal: AbortSignal | null): Promise<Float32Array | null> {
        const file = part.file;
        for (let level = k; level >= 0; level--) {
            const grid = file.grids[level];
            const window = sampleWindow(grid, fx, fy);
            try {
                const [values] = await this.readWithRetry(file, level, window, [part.sample], signal);
                const nodata = file.nodata;
                const nodata32 = nodata === null ? null : Math.fround(nodata);
                const isNoData = nodata === null ? () => false : (v: number) => v === nodata || v === nodata32;
                return interpolate(grid, window, values, fx, fy, isNoData, Number.NaN);
            } catch (error) {
                if (signal?.aborted || (error as Error)?.name === "AbortError") throw error;
                this.reportReadFailure(file, level, error, level > 0);
            }
        }
        return null;
    }

    private async readWithRetry(file: OpenFile, k: number, window: number[], samples: number[], signal: AbortSignal | null): Promise<NumericArray[]> {
        const read = async () => {
            const image = file.images[k];
            const options = {window, pool: this.pool() ?? undefined, signal: signal ?? undefined};
            if (file.colourModel) {
                // YCbCr, CIELab, CMYK: converted to RGB by geotiff.js.
                const rgb = await image.readRGB({...options, interleave: false}) as unknown as NumericArray[];
                return samples.map((s) => rgb[s]);
            }
            const raster = await image.readRasters({...options, samples});
            return (Array.isArray(raster) ? raster : [raster]) as unknown as NumericArray[];
        };
        try {
            return await read();
        } catch (error) {
            if (!file.sign || !file.url || signal?.aborted) throw error;
            // An expired token is the usual cause with signed URLs: sign again, reopen and retry once.
            file.reopening ??= reopen(file, this._httpOptions).finally(() => { file.reopening = undefined; });
            await file.reopening;
            return read();
        }
    }

    private reportReadFailure(file: OpenFile, image: number, error: unknown, willRetry: boolean): void {
        const key = `${file.index}/${image}`;
        const shared = this._shared;
        if (shared.reported.has(key)) return;
        shared.reported.add(key);
        const readError = new GeoTiffReadError({url: file.url ?? `file ${file.index}`, fileIndex: file.index, image,
            recovery: willRetry ? "finerImage" : "nodata", error});
        if (shared.listeners.size === 0) {
            console.warn(`ria-geotiff: ${readError.message}`);
            return;
        }
        shared.listeners.forEach((l) => {
            try { l(readError); } catch (e) { console.error("ria-geotiff: read error listener failed", e); }
        });
    }

    private pool(): Pool | null {
        return this._pool === undefined ? defaultPool() : this._pool;
    }

    // ------------------------------------------------------------------------------------------------- statistics

    private statisticsKey(style: CompiledStyle, sourceKey: string): string {
        return sourceKey + STATS_KEY_SEPARATOR + JSON.stringify(style.style.mask ?? []);
    }

    private statisticsReady(style: CompiledStyle, always = false): boolean {
        if (!always && !style.needsStatistics) return true;
        return style.sources.every((s) => this._statistics.has(this.statisticsKey(style, s.key)));
    }

    /** Computes the statistics `style` lacks (one computation at a time), in the region of the last computation. */
    private ensureStatistics(style: CompiledStyle, always = false): Promise<void> {
        if (this.statisticsReady(style, always)) return Promise.resolve();
        const run = (this._statisticsPending ?? Promise.resolve()).then(async () => {
            if (this.statisticsReady(style, always)) return;
            const target = this._statistics;
            const sample = await this.computeStatisticsFor(style, this._statisticsSample?.bounds ?? this._extent, target, this._statisticsSample);
            if (this._statistics === target) this._statisticsSample = sample;
        });
        this._statisticsPending = run.catch(noop).finally(() => { if (this._statisticsPending === pending) this._statisticsPending = null; });
        const pending = this._statisticsPending;
        return run;
    }

    private async computeStatisticsFor(
        style: CompiledStyle, area: [number, number, number, number], into: Map<string, BandStatistics | null>,
        reuse: { lattice: Lattice; bands: BandArrays; bounds: [number, number, number, number] } | null,
    ) {
        const [minX, minY, maxX, maxY] = area;
        const size = this._statisticsSize;
        const spacing = Math.max(maxX - minX, maxY - minY) / size;
        const nx = Math.max(1, Math.round((maxX - minX) / spacing)), ny = Math.max(1, Math.round((maxY - minY) / spacing));
        const sample = reuse && reuse.bounds.join() === area.join()
            ? reuse
            : {lattice: latticeOf(minX, minY, maxX, maxY, nx, ny), bands: {} as BandArrays, bounds: area};
        const n = sample.lattice.xs.length * sample.lattice.ys.length;
        const missing = style.requiredBands.filter((b) => !sample.bands[b]);
        if (missing.length) Object.assign(sample.bands, await this.sampleBands(missing, sample.lattice, null, false));
        const values = style.evaluate(sample.bands, n);
        const hidden = style.mask(sample.bands, n);
        style.sources.forEach((s, i) => {
            const v = values[i];
            if (hidden) for (let k = 0; k < n; k++) if (hidden[k]) v[k] = Number.NaN;
            into.set(this.statisticsKey(style, s.key), computeStatistics(v));
        });
        return sample;
    }

    // ------------------------------------------------------------------------------------------------- cache

    private cacheGet(key: string): Float32Array | undefined {
        const {entries} = this._shared;
        const value = entries.get(key);
        if (value) {
            entries.delete(key);
            entries.set(key, value);
        }
        return value;
    }

    private cachePut(key: string, value: Float32Array): void {
        const cache = this._shared;
        if (cache.entries.has(key)) return;
        cache.entries.set(key, value);
        cache.bytes += value.byteLength;
        for (const [k, v] of cache.entries) {
            if (cache.bytes <= this._cacheLimit) break;
            cache.entries.delete(k);
            cache.bytes -= v.byteLength;
        }
    }
}

// ----------------------------------------------------------------------------------------------------- helpers

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Pixel centres of an nx x ny raster over the extent. */
function latticeOf(minX: number, minY: number, maxX: number, maxY: number, nx: number, ny: number): Lattice {
    const sx = (maxX - minX) / nx, sy = (maxY - minY) / ny;
    const xs = new Float64Array(nx), ys = new Float64Array(ny);
    for (let i = 0; i < nx; i++) xs[i] = minX + (i + 0.5) * sx;
    for (let j = 0; j < ny; j++) ys[j] = maxY - (j + 0.5) * sy;
    return {xs, ys, spacingX: sx, spacingY: sy};
}

/** The reference of an identifier: LuciadRIA's, else the definition `resolve` gives (registered for later use). */
async function referenceFor(identifier: string | null, resolve: CreateModelOptions["resolveReference"]): Promise<CoordinateReference> {
    if (!identifier || !resolve || isValidReferenceIdentifier(identifier)) return resolveReference(identifier);
    let wkt: string | null;
    try {
        wkt = await resolve(identifier);
    } catch (error) {
        throw new GeoTiffModelError(`Unknown coordinate reference ${identifier}: resolveReference failed`, "UnknownIdentifier", {identifier, error});
    }
    if (!wkt) return resolveReference(identifier);
    try {
        const [authority, code] = identifier.split(":");
        addReference(parseWellKnownText(wkt, authority, code), identifier);
    } catch (error) {
        throw new GeoTiffModelError(`Unknown coordinate reference ${identifier}: its WKT cannot be parsed`, "UnknownIdentifier", {identifier, error});
    }
    return resolveReference(identifier);
}

/** Adds band `name` (sample `sample` of `file`) to `bands`: a new band, or one more part of a mosaic band. */
async function addBandTo(bands: BandSource[], file: OpenFile, sample: number, name: string): Promise<void> {
    if (!IDENTIFIER.test(name)) throw new RangeError(`Band name "${name}" is not a valid identifier`);
    const gdal = file.colourModel ? {scale: 1, offset: 0} : await gdalScaleOffset(file.images[0], sample);
    const part: BandPart = {file, sample, scale: file.input.scale ?? gdal.scale, offset: file.input.offset ?? gdal.offset};
    const cog = cogOfTiff.get(file.tiff)?.isCog;
    const location: BandLocation = {input: file.index, url: file.url, sample, ...(cog !== undefined ? {isCog: cog} : {})};
    const existing = bands.find((b) => b.info.name === name);
    if (existing) {
        if (existing.parts.some((p) => p.file === file)) throw new RangeError(`Duplicate band name "${name}" in input ${file.index + 1}`);
        existing.parts.push(part);
        existing.info.locations.push(location);
        existing.info.resolution = Math.min(existing.info.resolution, file.grids[0].resX);
        return;
    }
    bands.push({parts: [part], info: {
        name, input: file.index, url: file.url, sample, scale: part.scale, offset: part.offset,
        resolution: file.grids[0].resX, resampling: file.resampling, locations: [location],
    }});
}

/** The reference identifier of each file: its GeoKeys, else a `.prj` file next to it. */
async function referencesOf(files: OpenFile[], options: CreateModelOptions): Promise<(string | null)[]> {
    // The file's EPSG reference, else the input's crsName (a STAC asset's proj:code), else a .prj file next to it.
    const references = files.map((f) => referenceIdentifierFromGeoKeys(geoKeysOf(f.images[0])) ?? f.input.crsName ?? null);
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // The .prj file goes through the pipeline of its GeoTIFF: signer, rewriteUrl, HTTP options.
        if (!references[i] && file.url) {
            references[i] = await getReferenceFromPrjFile(file.url, file.access(), (prj) => signedUrl(prj, file.sign, options.rewriteUrl), options.onRequest);
        }
    }
    return references;
}

/** The names of the bands an opened file provides, in sample order. */
function bandsOfFile(bands: BandSource[], file: OpenFile): string[] {
    return bands.filter((b) => b.parts.some((p) => p.file === file))
        .sort((a, b) => a.parts.find((p) => p.file === file)!.sample - b.parts.find((p) => p.file === file)!.sample).map((b) => b.info.name);
}

/** The band names an input declares (`bands`), without opening it. */
function declaredNames(input: BandInput): string[] {
    const b = input.bands;
    return (typeof b === "string" ? [b] : Array.isArray(b) ? b : []).filter((n): n is string => typeof n === "string");
}

/** The band names an elevation height reads (none when it is not given or not valid). */
function heightBands(height: string | undefined): string[] {
    const h = height?.trim();
    if (!h) return [];
    if (IDENTIFIER.test(h)) return [h];
    try {
        return [...expressionBands(toExpressionNode(h))];
    } catch {
        return [];
    }
}

/** The tile structure of a model: an elevation quadtree of point samples, or an imagery quadtree of `tileSize` tiles. */
function structureOf(init: ModelInit): ConstructorParameters<typeof RasterTileSetModel>[0] {
    const elevation = init.mode.kind === "elevation" ? init.mode : null;
    const [minX, minY, maxX, maxY] = init.extent;
    if (elevation) {
        // The union of all files as one grid with the finest pixel size: the deepest level matches the finest data.
        const resX = Math.min(...init.files.map((f) => f.grids[0].resX)), resY = Math.min(...init.files.map((f) => f.grids[0].resY));
        const union: RasterGrid = {
            west: minX, north: maxY, resX, resY,
            width: Math.max(2, Math.round((maxX - minX) / resX)),
            height: Math.max(2, Math.round((maxY - minY) / resY)),
        };
        const s = elevationTileStructure(union, elevation.tileSize);
        const [x, width, y, height] = s.bounds;
        return {
            structure: {
                reference: init.reference, bounds: createBounds(init.reference, [x, width, y, height]),
                level0Columns: s.level0Columns, level0Rows: s.level0Rows, levelCount: s.levelCount,
                tileWidth: elevation.tileSize, tileHeight: elevation.tileSize,
            },
            dataType: RasterDataType.ELEVATION,
            samplingMode: RasterSamplingMode.POINT,
        };
    }
    const tileSize = init.options.tileSize ?? 256;
    const width = maxX - minX, height = maxY - minY;
    const finest = Math.min(...init.files.map((f) => Math.min(f.grids[0].resX, f.grids[0].resY)));
    // Quadtree aligned with the north-west corner of the data; its deepest level has the finest file's pixels.
    const pixels = Math.max(width, height) / finest;
    const levelCount = Math.max(1, Math.ceil(Math.log2(pixels / tileSize) - 1e-9) + 1);
    const level0Size = tileSize * finest * Math.pow(2, levelCount - 1);
    const level0Columns = Math.max(1, Math.ceil(width / level0Size - 1e-9));
    const level0Rows = Math.max(1, Math.ceil(height / level0Size - 1e-9));
    const bw = level0Columns * level0Size, bh = level0Rows * level0Size;
    return {
        structure: {
            reference: init.reference, bounds: createBounds(init.reference, [minX, bw, maxY - bh, bh]),
            level0Columns, level0Rows, levelCount, tileWidth: tileSize, tileHeight: tileSize,
        },
        dataType: RasterDataType.IMAGE,
        samplingMode: RasterSamplingMode.AREA,
    };
}

function checkElevationNumbers(elevation: ElevationOptions | undefined): void {
    if (elevation?.noDataHeight !== undefined && !Number.isFinite(elevation.noDataHeight)) {
        throw new RangeError(`elevation.noDataHeight must be a finite number, got ${elevation.noDataHeight}`);
    }
    if (elevation?.tileSize !== undefined && !(Number.isInteger(elevation.tileSize) && elevation.tileSize >= 2)) {
        throw new RangeError(`elevation.tileSize must be an integer >= 2, got ${elevation.tileSize}`);
    }
}

/** Smallest and largest imagery tile size: smaller tiles cost a request round per few pixels, larger ones exceed GPU texture limits. */
const MIN_TILE_SIZE = 16, MAX_TILE_SIZE = 4096;

function checkTileSize(tileSize: number | undefined): void {
    if (tileSize !== undefined && !(Number.isInteger(tileSize) && tileSize >= MIN_TILE_SIZE && tileSize <= MAX_TILE_SIZE)) {
        throw new RangeError(`tileSize must be an integer from ${MIN_TILE_SIZE} to ${MAX_TILE_SIZE}, got ${tileSize}`);
    }
}

/** How heights are computed from the bands: one band, a named band, or an expression. */
function elevationMode(bands: BandSource[], options: ElevationOptions): ElevationMode {
    const names = bands.map((b) => b.info.name);
    let height = options.height?.trim();
    if (!height) {
        if (names.length !== 1) {
            throw new RangeError(`elevation.height is required with several bands: name one or combine them with an expression (bands: ${names.join(", ")})`);
        }
        height = names[0];
    }
    let evaluate: ElevationMode["evaluate"];
    let required: string[];
    if (IDENTIFIER.test(height)) {
        const name = height;
        if (!names.includes(name)) throw new StyleError(`unknown band "${name}". Available: ${names.join(", ")}`, "elevation.height");
        required = [name];
        evaluate = (b, n) => Float32Array.from(b[name].subarray(0, n));
    } else {
        let compiled: ReturnType<typeof compileExpression>;
        try {
            compiled = compileExpression(height, names);
            required = [...expressionBands(toExpressionNode(height))];
        } catch (e) {
            throw new StyleError((e as Error).message, "elevation.height");
        }
        evaluate = (b, n) => { const out = new Float32Array(n); compiled(b, n, out); return out; };
    }
    for (const name of required) {
        for (const part of bands.find((b) => b.info.name === name)!.parts) {
            const main = part.file.images[0];
            if (part.file.colourModel || !canRepresentElevation(main)) {
                const pixel = analyzePixelFormat(main);
                throw new GeoTiffModelError(`Band "${name}" cannot be used as elevation (${pixel.meaning})`, "INVALIDELEVATION",
                    {pixelFormat: pixel.format ?? pixel.meaning});
            }
        }
    }
    const tileSize = options.tileSize ?? DEFAULT_ELEVATION_TILE_SIZE;
    return {kind: "elevation", height, requiredBands: required, evaluate, tileSize, noDataHeight: options.noDataHeight ?? Number.NaN, options};
}

/** The default style: a palette file's colour table, else {@link autoStyle}. */
function defaultStyle(files: OpenFile[], bands: BandSource[]): BandStyle {
    const names = bands.map((b) => b.info.name);
    const palette = files.length === 1 && names.length === 1 ? paletteTable(files[0].images[0]) : null;
    if (palette) return {render: {type: "pseudocolor", band: names[0], colorMap: palette}};
    return autoStyle(names);
}

function paletteTable(image: GeoTIFFImage) {
    const colorMap = colorMapOf(image);
    if (!colorMap) return null;
    const entries = colorMap.length / 3;
    return {type: "table" as const, entries: Array.from({length: entries}, (_, i) => ({value: i,
        color: formatColor({r: colorMap[i] >> 8, g: colorMap[entries + i] >> 8, b: colorMap[2 * entries + i] >> 8, a: 1})}))};
}

/** The COG analysis of each opened file (see probeCog), read from the bytes geotiff.js already fetched. */
const cogOfTiff = new WeakMap<GeoTIFF, CogProbe>();

/** Runs the COG analysis on an opened GeoTIFF through its own source (cached header blocks: usually no request). */
async function probeOpened(tiff: GeoTIFF): Promise<CogProbe | undefined> {
    if (cogOfTiff.has(tiff)) return cogOfTiff.get(tiff);
    try {
        const probe = await analyzeCog(async (offset, length) => {
            const [buffer] = await tiff.source.fetch([{offset, length}]);
            return new Uint8Array(buffer as ArrayBuffer);
        });
        cogOfTiff.set(tiff, probe);
        return probe;
    } catch {
        return undefined;
    }
}

function describeImage(main: GeoTIFFImage, tiff: GeoTIFF): GeoTiffTileSetModelInfo {
    const pixel = analyzePixelFormat(main);
    return {
        tileWidth: main.getTileWidth(),
        tileHeight: main.getTileHeight(),
        width: main.getWidth(),
        height: main.getHeight(),
        bytesPerPixel: main.getBytesPerPixel(),
        bitsPerSample: main.getBitsPerSample() as number | number[],
        bands: main.getSamplesPerPixel(),
        isTiled: main.isTiled,
        pixelMeaning: pixel.meaning,
        pixelFormat: pixel.format,
        isCog: cogOfTiff.get(tiff)?.isCog ?? false,
        crsName: referenceIdentifierFromGeoKeys(geoKeysOf(main)),
        samplingMode: detectSamplingMode(main),
        canBeElevation: canRepresentElevation(main),
    };
}

/** Default memory of the fetched bytes kept per file, in MiB: 256 x 64 KiB blocks. */
const DEFAULT_BYTE_CACHE_MIB = 16;

/** Number of 64 KiB blocks of fetched bytes kept per file, from {@link CreateModelOptions.byteCacheSize}. */
function byteCacheBlocks(options: CreateModelOptions): number {
    return Math.max(1, Math.round((options.byteCacheSize ?? DEFAULT_BYTE_CACHE_MIB) * 16));
}

/**
 * The options of each request to an input: the input's own over the model's live ones, sent to a URL the
 * application gave; for discovered inputs only on their allowed origin or through their hook; or the `access` hook.
 */
function accessOf(input: BandInput, url: string | undefined, options: CreateModelOptions, http: HttpState): () => HttpRequestOptions | null {
    const rule = discoveredInputs.get(input);
    const own = (): HttpRequestOptions => ({
        credentials: input.credentials ?? http.credentials,
        requestHeaders: input.requestHeaders !== undefined ? input.requestHeaders : http.requestHeaders,
        requestParameters: input.requestParameters !== undefined ? input.requestParameters : http.requestParameters,
    });
    if (!url) return () => null;
    const target = () => new URL(url, typeof location !== "undefined" ? location.href : undefined);
    if (rule?.hook) return () => rule.hook!(target(), rule.kind);
    if (options.access) return () => options.access!(target(), rule?.kind ?? "file");
    if (rule) return () => (rule.origin !== null && originOf(url) === rule.origin ? own() : null);
    return own;
}

/** How the requests of an input are reported: kind `"stac-asset"` for STAC assets, else `"file"`. */
function observeOf(input: BandInput, options: CreateModelOptions): Observe | undefined {
    return options.onRequest ? {onRequest: options.onRequest, kind: discoveredInputs.get(input)?.kind === "stac-asset" ? "stac-asset" : "file"} : undefined;
}

async function openInput(input: BandInput, options: CreateModelOptions, blocks: DecodedBlockCache, http: HttpState): Promise<OpenFile> {
    const url = input.url !== undefined ? String(input.url) : undefined;
    const access = accessOf(input, url, options, http);
    let tiff: GeoTIFF;
    let sign = input.sign;
    if (input.file !== undefined && input.file !== null) {
        const f = input.file;
        try {
            // fromBlob reads slices with FileReader (browsers); elsewhere the Blob is read whole.
            tiff = typeof Blob !== "undefined" && f instanceof Blob
                ? (typeof FileReader !== "undefined" ? await fromBlob(f) : await fromArrayBuffer(await f.arrayBuffer()))
                : f instanceof ArrayBuffer ? await fromArrayBuffer(f) : f as GeoTIFF;
        } catch (error) {
            throw new GeoTiffModelError("Error reading the GeoTIFF file", "ERROR_LOADING_FILE", {error});
        }
    } else {
        if (!url) throw new RangeError("A band input needs a url or a file");
        if (!sign) {
            const signer = (options.signers ?? DEFAULT_SIGNERS).find((s) => s.matches(url));
            if (signer) sign = Object.assign((u: string) => signer.sign(u), {signer});
        }
        tiff = await openURL(await signedUrl(url, sign, options.rewriteUrl), access, byteCacheBlocks(options), url, observeOf(input, options));
    }
    const {images, grids, masks} = await imagesOf(tiff, options.reference);
    images.forEach((image) => blocks.attach(image));
    const main = images[0];
    const colourModel = isConvertedToRGB(photometricOf(main)) && bitsPerSampleOf(main) === 8;
    return {
        index: 0, access, input, url, tiff, images, grids, masks, blocks, sign: input.file !== undefined ? undefined : sign,
        nodata: input.nodata !== undefined ? input.nodata : main.getGDALNoData() ?? null,
        resampling: input.resampling ?? "bilinear",
        bandCount: colourModel ? 3 : main.getSamplesPerPixel(),
        colourModel,
    };
}

async function signedUrl(url: string, sign: ((url: string) => Promise<string>) | undefined, rewrite?: (url: string) => string): Promise<string> {
    const signed = sign ? await sign(url) : url;
    return rewrite ? rewrite(signed) : signed;
}

async function imagesOf(tiff: GeoTIFF, reference?: CoordinateReference): Promise<{ images: GeoTIFFImage[]; grids: RasterGrid[]; masks: (GeoTIFFImage | null)[] }> {
    const all = await readImages(tiff);
    const images = all.filter((image) => !isMaskImage(image))
        .sort((a, b) => b.getWidth() - a.getWidth() || b.getHeight() - a.getHeight());
    const maskImages = all.filter(isMaskImage);
    const main = images[0];
    if (!main) throw new GeoTiffModelError("The GeoTIFF contains no image", "ERROR_LOADING_FILE");
    const mainGrid = reference?.identifier === "CRS:1"
        ? {width: main.getWidth(), height: main.getHeight(), resX: 1, resY: 1, west: 0, north: main.getHeight()}
        : gridOfMainImage(main);
    if (!mainGrid) throw new GeoTiffModelError("The GeoTIFF has no georeferencing; pass options.reference", "BoundsMissing");
    return {
        images,
        grids: images.map((image, i) => (i === 0 ? mainGrid : gridOfOverview(mainGrid, image))),
        masks: images.map((image) => maskImages.find((m) => m.getWidth() === image.getWidth() && m.getHeight() === image.getHeight()) ?? null),
    };
}

async function reopen(file: OpenFile, options: CreateModelOptions): Promise<void> {
    const tiff = await openURL(await signedUrl(file.url!, file.sign, options.rewriteUrl), file.access, byteCacheBlocks(options), file.url,
        observeOf(file.input, options));
    const {images, grids, masks} = await imagesOf(tiff, options.reference);
    images.forEach((image) => file.blocks.attach(image));
    file.tiff = tiff;
    file.images = images;
    file.grids = grids;
    file.masks = masks;
}

async function bandNamesOf(file: OpenFile, inputCount: number): Promise<(string | null)[]> {
    const {input, bandCount: count} = file;
    const main = file.images[0];
    if (typeof input.bands === "string") return [input.bands, ...new Array<null>(count - 1).fill(null)];
    if (Array.isArray(input.bands)) return Array.from({length: count}, (_, i) => input.bands![i] ?? null);
    const fallback = Array.from({length: count}, (_, i) => (inputCount === 1 ? `b${i + 1}` : `f${file.index + 1}_b${i + 1}`));
    if (file.colourModel) return fallback;
    // Sequentially: concurrent first reads of the deferred GDAL_METADATA tag can fail in geotiff.js.
    const descriptions: (string | null)[] = [];
    for (let i = 0; i < count; i++) descriptions.push(await gdalBandDescription(main, i));
    const usable = descriptions.every((d) => d && IDENTIFIER.test(d)) && new Set(descriptions).size === count;
    return usable ? descriptions : fallback;
}

/** The file and 0-based sample of a band reference: "fN_bM" (input N, band M, 1-based), or "bM" with one input. */
function locateBand(ref: string, files: OpenFile[], name: string): { file: OpenFile; sample: number } {
    const m = /^(?:f(\d+)_)?b(\d+)$/.exec(String(ref).trim());
    if (!m) throw new RangeError(`Band "${name}": "${ref}" is not a band reference (use "f2_b1": input 2, band 1; or "b3" with one input)`);
    if (m[1] === undefined && files.length > 1) {
        throw new RangeError(`Band "${name}": "${ref}" is ambiguous with ${files.length} inputs; say which input, e.g. "f1_${ref}"`);
    }
    const fileNo = m[1] === undefined ? 1 : Number(m[1]);
    const bandNo = Number(m[2]);
    const file = files[fileNo - 1];
    if (!file) throw new RangeError(`Band "${name}": there is no input ${fileNo} (the model has ${files.length})`);
    if (bandNo < 1 || bandNo > file.bandCount) throw new RangeError(`Band "${name}": input ${fileNo} has ${file.bandCount} band(s), not ${bandNo}`);
    return {file, sample: bandNo - 1};
}

/**
 * The options and signer of each opened input of a model, for manifests.
 *
 * @internal
 *
 * @category Model
 */
export function modelInputs(model: GeoTiffTileSetModel): { input: BandInput; url?: string; sign?: (url: string) => Promise<string>; options: CreateModelOptions }[] {
    const m = model as unknown as { _files: OpenFile[]; _init: ModelInit };
    return m._files.map((f) => ({input: f.input, url: f.url, sign: f.sign, options: m._init.options}));
}
