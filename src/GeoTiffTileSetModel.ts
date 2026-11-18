import {
    RasterTileSetModel,
    type QuadTreeRasterTileSetStructure,
    type TileMatrix,
    type TileMatrixSet2DRasterTileSetStructure,
} from "@luciad/ria/model/tileset/RasterTileSetModel.js";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {TileData} from "@luciad/ria/model/tileset/TileData.js";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode.js";
import type {CoordinateReference} from "@luciad/ria/reference/CoordinateReference.js";
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import type {Bounds} from "@luciad/ria/shape/Bounds.js";
import {createBounds} from "@luciad/ria/shape/ShapeFactory.js";
import type {ModelDescriptor} from "@luciad/ria/model/ModelDescriptor.js";
import {createGradientColorMap} from "@luciad/ria/util/ColorMap.js";
import {fromUrl, Pool, type GeoTIFF, type GeoTIFFImage} from "geotiff";

import {convertBandsTo8BitRGB, resolveBandMapping} from "./bandstorgb.js";
import {convert32FloatTo8BitRGB, convertSingleBandTo8BitRGB, downscale16to8bits} from "./bitstorgb.js";
import {
    chooseImage,
    DEFAULT_ELEVATION_TILE_SIZE,
    elevationTileStructure,
    interpolate,
    samplePositions,
    sampleWindow,
} from "./elevation.js";
import {encodeLuciadElevationPng} from "./luciadElevationPng.js";
import {GeoTiffModelError, GeoTiffReadError, type GeoTiffReadErrorListener} from "./errors.js";
import {fetchCredentials, getReferenceFromPrjFile, type HttpAccessOptions, withRequestParameters} from "./fileutils.js";
import {areaExtent, gridOfMainImage, gridOfOverview, type RasterGrid} from "./geometry.js";
import {GrayscaleGradient, type RGBTransformation, TransformToGradientColorMap} from "./gradients.js";
import type {BandMapping, CogGradient, CogGradientColorMap, ResolvedBandMapping} from "./interfaces.js";
import {PixelMeaningEnum} from "./interfaces.js";
import {colorMapOf, gdalScaleOffset, gdalStatisticsRange, isMaskImage, photometricOf} from "./tiff.js";
import {
    analyzePixelFormat,
    bitsPerSampleOf,
    canRepresentElevation,
    detectSamplingMode,
    equalsOrBothNaN,
    isLikelyCOG,
    isNumber,
    normalizeRawTypedArray,
    type NumericArray,
    referenceIdentifierFromGeoKeys,
    sampleFormatOf,
} from "./utils.js";
import {geoKeysOf} from "./tiff.js";

/**
 * Options for retrieving GeoTIFF information from a URL.
 */
export interface GetInfoGeotiffFromUrlOptions extends HttpAccessOptions {
}

/**
 * Elevation-specific options, used when `dataType` is {@link RasterDataType.ELEVATION}.
 */
export interface GeoTiffElevationOptions {
    /**
     * Number of samples along each side of an elevation tile. Default 64, as in LuciadFusion.
     */
    tileSize?: number;
    /**
     * Zero-based band that holds the heights. Default 0.
     */
    band?: number;
    /**
     * Height given to LuciadRIA where the GeoTIFF has no data.
     *
     * By default missing data is delivered as LuciadFusion's own nodata marker, and LuciadRIA decides how to show it.
     * Set a finite number to deliver that height instead.
     */
    noDataHeight?: number;
}

/**
 * Options for creating a {@link GeoTiffTileSetModel}.
 */
export interface CreateGeotiffFromUrlOptions extends HttpAccessOptions {
    /**
     * {@link RasterDataType.IMAGE} (default) to show the data as an image, or {@link RasterDataType.ELEVATION} to use
     * a single band as terrain. Elevation tiles are delivered as LuciadFusion delivers them: a quadtree of 64 x 64
     * point samples (heights as 32-bit floats) spanning each tile edge to edge.
     */
    dataType?: RasterDataType;

    /**
     * Coordinate reference to use instead of the one declared in the GeoTIFF. Use `getReference("CRS:1")` to show
     * a file without georeferencing in pixel coordinates.
     */
    reference?: CoordinateReference;

    /**
     * Value that marks missing data. Defaults to the file's GDAL_NODATA tag; without one, no value is treated as
     * missing (NaN always is for floating point data).
     */
    nodata?: number;

    /** How the bands of a multiband raster are shown, see {@link BandMapping}. */
    bandMapping?: BandMapping;

    /**
     * Gradient used to color single-band data (or the `gray` band of multiband data).
     *
     * @example
     * const gradient = {
     *   colorMap: [
     *     {level: 0.0, color: "#0000ff"},
     *     {level: 0.5, color: "#00ff00"},
     *     {level: 1.0, color: "#ff0000"},
     *   ],
     *   range: {min: 0, max: 1000},
     * };
     */
    gradient?: CogGradient;

    /** Elevation options, see {@link GeoTiffElevationOptions}. */
    elevation?: GeoTiffElevationOptions;

    /**
     * geotiff.js decoder pool. By default a shared pool of web workers is created on first use in browsers.
     * Pass `null` to decode on the main thread.
     */
    pool?: Pool | null;

    /**
     * Called with a {@link GeoTiffReadError} when data of a file cannot be read while serving tiles (a failed
     * request, a damaged block). The model recovers where it can (see `error.recovery`). Same as calling
     * `model.addReadErrorListener` right after creation. Without listeners the errors are logged with `console.warn`.
     */
    onReadError?: GeoTiffReadErrorListener;
}

/**
 * Information read from a GeoTIFF.
 */
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
    /** Whether the file is laid out as a Cloud Optimized GeoTIFF. */
    isCog: boolean;
    /** Coordinate reference identifier, such as `"EPSG:3857"`, or null when unknown. */
    crsName: string | null;
    /** Sampling mode declared by the file. */
    samplingMode: RasterSamplingMode;
    /** Whether the bands hold plain numbers usable as elevation. */
    canBeElevation: boolean;
    /** Images of the file (full resolution first), as LuciadRIA tile matrices. */
    tileMatrix?: {
        zoom: number;
        tileColumnCount: number;
        tileRowCount: number;
        tileWidth: number;
        tileHeight: number;
    }[];
}

/** One image of the pyramid, as served to LuciadRIA (imagery path). */
interface ImageLevel {
    image: GeoTIFFImage;
    mask: GeoTIFFImage | null;
    /** Tile size used for LuciadRIA: the file's block size, or a virtual size for images stored as one block. */
    tileWidth: number;
    tileHeight: number;
    columns: number;
    rows: number;
}

/** Images ordered from finest to coarsest with their grids (elevation path). */
/** One GeoTIFF of an elevation model: its images (finest first) and how to read heights from them. */
interface ElevationFile {
    /** Where the file was opened from (for error reports), when known. */
    url?: string;
    images: GeoTIFFImage[];
    grids: RasterGrid[];
    band: number;
    scale: number;
    offset: number;
    /** The file's own nodata value (option or GDAL_NODATA), or null. */
    nodata: number | null;
    /** Outer pixel edges `[minX, minY, maxX, maxY]` of the full-resolution image. */
    area: [number, number, number, number];
}

/** Elevation model: one or more GeoTIFFs in the same reference (a mosaic of tiles, for example). */
interface ElevationSource {
    files: ElevationFile[];
    tileSize: number;
    noDataHeight: number;
}

interface GeoTiffTileSetModelOptions {
    structure: QuadTreeRasterTileSetStructure | TileMatrixSet2DRasterTileSetStructure;
    dataType: RasterDataType;
    samplingMode: RasterSamplingMode;
    main: GeoTIFFImage;
    levels: ImageLevel[];
    elevation: ElevationSource | null;
    nodata: number | null;
    defaultRange: { min: number; max: number };
    bandMapping?: BandMapping;
    gradient?: CogGradient;
    pool: Pool | null | undefined;
    tiff: GeoTIFF;
    onReadError?: GeoTiffReadErrorListener;
}

let sharedPool: Pool | null | undefined;

/** A shared decoder pool in browsers (web workers), none elsewhere. */
function defaultPool(): Pool | null {
    if (sharedPool === undefined) {
        sharedPool = typeof window !== "undefined" && typeof Worker !== "undefined" ? new Pool() : null;
    }
    return sharedPool;
}

/**
 * A LuciadRIA {@link RasterTileSetModel} that streams a Cloud Optimized GeoTIFF with HTTP range requests.
 *
 * - Imagery: RGB(A), palette, 8/16/32-bit and float single-band data (colored with a gradient) and multiband data
 *   (band mapping). Each image of the COG (full resolution and overviews) is one level of the tile set.
 * - Elevation (`dataType: RasterDataType.ELEVATION`): one band of any integer or float type is served as terrain,
 *   in the tile layout LuciadFusion uses (see {@link GeoTiffElevationOptions}).
 *
 * Create instances with {@link GeoTiffTileSetModel.createFromURL} (or {@link GeoTiffTileSetModel.createFromGeoTIFF})
 * and show them with a `RasterTileSetLayer`.
 */
export class GeoTiffTileSetModel extends RasterTileSetModel {
    private readonly _main: GeoTIFFImage;
    private readonly _tiff: GeoTIFF;
    private readonly _levels: ImageLevel[];
    private readonly _elevation: ElevationSource | null;
    private readonly _pixelFormat: PixelFormat | null;
    private readonly _pixelMeaning: PixelMeaningEnum;
    private readonly _bandsNumber: number;
    private readonly _bitsPerSample: number;
    private readonly _isFloat: boolean;
    private readonly _defaultRange: { min: number; max: number };
    private readonly _pool: Pool | null | undefined;
    private _nodata: number | null;
    /** True once setNodata() was called: the value then applies to every file of an elevation mosaic. */
    private _nodataOverride = false;
    private _bandMapping: ResolvedBandMapping;
    private _colorMap: CogGradientColorMap = GrayscaleGradient;
    private _nativeRange: { min: number; max: number };
    private _transformation: RGBTransformation;

    /**
     * Use {@link GeoTiffTileSetModel.createFromURL} or {@link GeoTiffTileSetModel.createFromGeoTIFF}.
     */
    private constructor(options: GeoTiffTileSetModelOptions) {
        super({structure: options.structure, dataType: options.dataType, samplingMode: options.samplingMode});
        this._main = options.main;
        this._tiff = options.tiff;
        this._levels = options.levels;
        this._elevation = options.elevation;
        const pixel = analyzePixelFormat(options.main);
        this._pixelFormat = pixel.format;
        this._pixelMeaning = pixel.meaning;
        this._bandsNumber = options.main.getSamplesPerPixel();
        this._bitsPerSample = bitsPerSampleOf(options.main);
        this._isFloat = sampleFormatOf(options.main) === 3;
        this._defaultRange = options.defaultRange;
        this._nativeRange = options.defaultRange;
        this._nodata = options.nodata;
        this._pool = options.pool;
        if (options.onReadError) this._readErrorListeners.add(options.onReadError);
        this.modelDescriptor = {
            name: "GeoTiffTileSetModel",
            description: "Cloud Optimized GeoTIFF streamed with HTTP range requests",
            source: "Cloud Optimized GeoTIFF",
        } as ModelDescriptor;
        this._bandMapping = resolveBandMapping(options.bandMapping);
        this._transformation = TransformToGradientColorMap(createGradientColorMap(GrayscaleGradient));
        this.setGradient(options.gradient, false);
    }

    // ------------------------------------------------------------------------------------------------- public API

    /** Information about the GeoTIFF this model reads. */
    public getModelInfo(): GeoTiffTileSetModelInfo {
        return GeoTiffTileSetModel.describe(this._main, this._tiff);
    }

    /**
     * Sets the gradient used for single-band data (and the `gray` band of multiband data).
     *
     * @param gradient color stops from level 0.0 to 1.0, and optionally the data `range` they span. Without a range
     *   the full range of the data type is used (for float data: GDAL statistics in the file, or 0..1).
     *   `null`/`undefined` restores the default grayscale gradient.
     * @param invalidate set to false to avoid an immediate repaint
     */
    public setGradient(gradient?: CogGradient | null, invalidate = true): void {
        this._colorMap = gradient?.colorMap ?? GrayscaleGradient;
        this._nativeRange = gradient?.range ?? this._defaultRange;
        this._transformation = TransformToGradientColorMap(createGradientColorMap(this._colorMap));
        if (invalidate) this.invalidate();
    }

    /** The gradient in use, with the data range it spans. */
    public getGradient(): CogGradient {
        return {colorMap: this._colorMap, range: this._nativeRange};
    }

    /**
     * Sets which bands are shown and how, see {@link BandMapping}. Missing properties take their defaults.
     * @param invalidate set to false to avoid an immediate repaint
     */
    public setBandMapping(bandMapping?: BandMapping | null, invalidate = true): void {
        this._bandMapping = resolveBandMapping(bandMapping);
        if (invalidate) this.invalidate();
    }

    /** The band mapping in use (with defaults applied). */
    public getBandMapping(): ResolvedBandMapping {
        return this._bandMapping;
    }

    /**
     * Sets the value that marks missing data (transparent for imagery, `elevation.noDataHeight` for elevation).
     * `null` disables nodata handling (NaN is still treated as missing for float data).
     * @param invalidate set to false to avoid an immediate repaint
     */
    public setNodata(nodata: number | null, invalidate = true): void {
        this._nodata = nodata;
        this._nodataOverride = true;
        if (invalidate) this.invalidate();
    }

    /** The value that marks missing data, or null. */
    public getNodata(): number | null {
        return this._nodata;
    }

    override getImage(
        tile: TileCoordinate,
        _onSuccess: (tile: TileCoordinate, image: HTMLImageElement) => void,
        onError: (tile: TileCoordinate, error?: unknown) => void,
    ): void {
        onError(tile, new Error("GeoTiffTileSetModel delivers tiles through getTileData"));
    }

    override getTileData(
        tile: TileCoordinate,
        onSuccess: (tile: TileCoordinate, data: TileData) => void,
        onError: (tile: TileCoordinate, error: unknown) => void,
        signal: AbortSignal | null,
    ): void {
        const run = this._elevation
            ? this.elevationTile(tile, this._elevation, signal)
            : this.imageryTile(tile, signal);
        run.then((data) => onSuccess(tile, data), (error) => onError(tile, error));
    }

    // ------------------------------------------------------------------------------------------------- elevation

    private async elevationTile(tile: TileCoordinate, source: ElevationSource, signal: AbortSignal | null): Promise<TileData> {
        const n = source.tileSize;
        const tileBounds = this.getTileBounds(tile);
        const {xs, ys} = samplePositions(tileBounds, n);
        const spacingX = tileBounds.width / (n - 1);
        const spacingY = tileBounds.height / (n - 1);
        const heights = new Float32Array(n * n).fill(Number.NaN);

        // Each sample takes its height from the first file that covers it and has data there.
        await Promise.all(source.files.map(async (file) => {
            const [minX, minY, maxX, maxY] = file.area;
            let i0 = 0, i1 = n - 1, j0 = 0, j1 = n - 1;
            while (i0 < n && xs[i0] < minX) i0++;
            while (i1 >= 0 && xs[i1] > maxX) i1--;
            while (j0 < n && ys[j0] > maxY) j0++;   // ys run north to south
            while (j1 >= 0 && ys[j1] < minY) j1--;
            if (i0 > i1 || j0 > j1) return;          // the file does not cover this tile
            const fx = xs.subarray(i0, i1 + 1);
            const fy = ys.subarray(j0, j1 + 1);
            const block = await this.readFileHeights(file, chooseImage(file.grids, spacingX, spacingY), fx, fy, signal);
            if (!block) return;                      // unreadable: these samples stay nodata
            for (let j = 0; j < fy.length; j++) {
                for (let i = 0; i < fx.length; i++) {
                    const o = (j0 + j) * n + i0 + i;
                    const h = block[j * fx.length + i];
                    if (Number.isNaN(heights[o]) && !Number.isNaN(h)) heights[o] = h * file.scale + file.offset;
                }
            }
        }));

        if (!Number.isNaN(source.noDataHeight)) {
            // NaN stays NaN (encoded as the LuciadElev0 nodata marker) unless a noDataHeight is configured.
            for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) heights[i] = source.noDataHeight;
        }
        // LuciadRIA's terrain decodes compressed elevation images (LuciadFusion's LuciadElev0 PNG); raw FLOAT_32
        // tile data is only accepted by some of its terrain painters.
        return {data: encodeLuciadElevationPng(heights, n, n), mimeType: "image/png"};
    }

    /**
     * Interpolated heights of one file at the given sample positions, read from image `k` (an overview).
     *
     * A file that cannot be read (a damaged block, a failed request) must not fail the whole terrain tile: the read
     * falls back to the next finer image of the file, and when none can be read the file's samples stay nodata, so
     * the other files of a mosaic (and LuciadRIA's fallback for nodata) still show. Each failure is reported once.
     * Cancellation by LuciadRIA (an aborted signal) is passed on.
     */
    private async readFileHeights(
        file: ElevationFile, k: number, fx: Float64Array, fy: Float64Array, signal: AbortSignal | null,
    ): Promise<Float32Array | null> {
        const nodata = this._nodataOverride ? this._nodata : file.nodata;
        const isNoData = isNumber(nodata) ? (v: number) => equalsOrBothNaN(v, nodata) : () => false;
        for (let level = k; level >= 0; level--) {
            const grid = file.grids[level];
            const window = sampleWindow(grid, fx, fy);
            try {
                const raster = await file.images[level].readRasters({
                    window,
                    samples: [file.band],
                    pool: this.pool() ?? undefined,
                    signal: signal ?? undefined,
                });
                const values = (Array.isArray(raster) ? raster[0] : raster) as NumericArray;
                return interpolate(grid, window, values, fx, fy, isNoData, Number.NaN);
            } catch (error) {
                if (signal?.aborted || (error as Error)?.name === "AbortError") throw error;
                this.reportReadFailure(file, level, error, level > 0);
            }
        }
        return null;
    }

    private readonly _reportedFailures = new Set<string>();
    private readonly _readErrorListeners = new Set<GeoTiffReadErrorListener>();

    /**
     * Registers a listener for {@link GeoTiffReadError}s: data of a file that cannot be read while serving tiles.
     * Each combination of file and image is reported once. While at least one listener is registered the model does
     * not log these errors itself, so the application decides how to report them (log, notify, show on screen).
     *
     * @returns a handle whose `remove()` unregisters the listener
     */
    public addReadErrorListener(listener: GeoTiffReadErrorListener): { remove(): void } {
        this._readErrorListeners.add(listener);
        return {remove: () => { this._readErrorListeners.delete(listener); }};
    }

    private reportReadFailure(file: ElevationFile, level: number, error: unknown, willRetry: boolean): void {
        const fileIndex = this._elevation?.files.indexOf(file) ?? -1;
        const key = `${fileIndex}/${level}`;
        if (this._reportedFailures.has(key)) return;
        this._reportedFailures.add(key);
        const url = file.url ?? `file ${fileIndex}`;
        const readError = new GeoTiffReadError({url, fileIndex, image: level, recovery: willRetry ? "finerImage" : "nodata", error});
        if (this._readErrorListeners.size === 0) {
            console.warn(`ria-geotiff: ${readError.message}`);
            return;
        }
        for (const listener of this._readErrorListeners) {
            try {
                listener(readError);
            } catch (listenerError) {
                console.error("ria-geotiff: read error listener failed", listenerError);
            }
        }
    }

    // ------------------------------------------------------------------------------------------------- imagery

    private async imageryTile(tile: TileCoordinate, signal: AbortSignal | null): Promise<TileData> {
        const level = this._levels[tile.level];
        if (!level) throw new Error(`No image for level ${tile.level}`);
        const {image, mask, tileWidth, tileHeight} = level;
        const flipY = this.reference.identifier === "CRS:1";
        const imageWidth = image.getWidth();
        const imageHeight = image.getHeight();
        const row = level.rows - tile.y - 1; // LuciadRIA counts rows from the bottom, images from the top
        const left = tileWidth * tile.x;
        const top = flipY ? imageHeight - tileHeight * (row + 1) : tileHeight * row;
        const window = [left, top, left + tileWidth, top + tileHeight];
        const pool = this.pool() ?? undefined;
        const abort = signal ?? undefined;
        const nodata = this._nodata;
        const pixelCount = tileWidth * tileHeight;
        const maskPromise = mask ? mask.readRasters({window, pool, signal: abort}) : Promise.resolve(null);

        let data: Uint8Array;
        let pixelFormat: PixelFormat;
        if (this._bandsNumber === 1 && photometricOf(image) !== 3) {
            const [rasters, rawMask] = await Promise.all([image.readRasters({window, pool, signal: abort}), maskPromise]);
            let raw = (Array.isArray(rasters) ? rasters[0] : rasters) as NumericArray;
            raw = normalizeRawTypedArray(raw, pixelCount, nodata ?? 0);
            if (this._isFloat) {
                data = convert32FloatTo8BitRGB(raw as Float32Array, 1, nodata, this._transformation, this._nativeRange);
            } else {
                data = convertSingleBandTo8BitRGB(raw, {
                    bits: this._bitsPerSample,
                    nativeRange: this._nativeRange,
                    transformation: this._transformation,
                    nodata,
                });
            }
            pixelFormat = isNumber(nodata) ? PixelFormat.RGBA_8888 : PixelFormat.RGB_888;
            ({data, pixelFormat} = this.applyMask(data, pixelFormat, rawMask));
        } else if (this._bandsNumber > 1 && this._pixelMeaning === PixelMeaningEnum.Multiband) {
            const [raster, rawMask] = await Promise.all([
                image.readRasters({window, pool, interleave: true, signal: abort}),
                maskPromise,
            ]);
            const raw = normalizeRawTypedArray(raster as unknown as NumericArray, pixelCount * this._bandsNumber, nodata ?? 0);
            data = convertBandsTo8BitRGB(raw, {
                bits: this._bitsPerSample,
                nativeRange: this._nativeRange,
                bands: this._bandsNumber,
                transformation: this._transformation,
                bandMapping: this._bandMapping,
                nodata,
            });
            pixelFormat = PixelFormat.RGBA_8888;
            ({data, pixelFormat} = this.applyMask(data, pixelFormat, rawMask));
        } else {
            // RGB(A), YCbCr, palette, ...: geotiff.js converts to RGB(A).
            const withAlpha = this._pixelFormat === PixelFormat.RGBA_8888;
            const [rgb, rawMask] = await Promise.all([
                image.readRGB({window, pool, enableAlpha: withAlpha, interleave: true, signal: abort}),
                maskPromise,
            ]);
            const raw = rgb as unknown as Uint8Array | Uint16Array;
            data = bitsPerSampleOf(image) === 16 && !colorMapOf(image) ? downscale16to8bits(raw as Uint16Array) : raw as Uint8Array;
            pixelFormat = withAlpha ? PixelFormat.RGBA_8888 : PixelFormat.RGB_888;
            ({data, pixelFormat} = this.applyMask(data, pixelFormat, rawMask));
            if (isNumber(nodata)) {
                if (pixelFormat === PixelFormat.RGB_888) {
                    data = rgbToRgba(data);
                    pixelFormat = PixelFormat.RGBA_8888;
                }
                stripNoDataColor(data, nodata, colorMapOf(image));
            }
        }
        ({data, pixelFormat} = this.clearOutsideImage(data, pixelFormat, left, top, tileWidth, tileHeight, imageWidth, imageHeight, flipY));
        return {data: data.buffer as ArrayBuffer, pixelFormat, width: tileWidth, height: tileHeight};
    }

    private pool(): Pool | null {
        return this._pool === undefined ? defaultPool() : this._pool;
    }

    /** Makes masked-out pixels (mask value 0) transparent. */
    private applyMask(data: Uint8Array, pixelFormat: PixelFormat, rawMask: unknown): { data: Uint8Array; pixelFormat: PixelFormat } {
        if (!rawMask) return {data, pixelFormat};
        const mask = (Array.isArray(rawMask) ? rawMask[0] : rawMask) as Uint8Array;
        if (pixelFormat === PixelFormat.RGB_888) {
            data = rgbToRgba(data);
            pixelFormat = PixelFormat.RGBA_8888;
        }
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] === 0) data.fill(0, i * 4, i * 4 + 4);
        }
        return {data, pixelFormat};
    }

    /** Makes the part of a tile that lies beyond the image transparent (partial tiles at the right/bottom edges). */
    private clearOutsideImage(
        data: Uint8Array, pixelFormat: PixelFormat, left: number, top: number, tileWidth: number, tileHeight: number,
        imageWidth: number, imageHeight: number, flipY: boolean,
    ): { data: Uint8Array; pixelFormat: PixelFormat } {
        const overflows = left + tileWidth > imageWidth || top + tileHeight > imageHeight || top < 0;
        if (!overflows) return {data, pixelFormat};
        if (pixelFormat === PixelFormat.RGB_888) {
            data = rgbToRgba(data);
            pixelFormat = PixelFormat.RGBA_8888;
        }
        for (let py = 0; py < tileHeight; py++) {
            const y = top + py;
            const rowOutside = flipY ? y < 0 : y >= imageHeight;
            for (let px = 0; px < tileWidth; px++) {
                if (rowOutside || left + px >= imageWidth) {
                    const i = (py * tileWidth + px) * 4;
                    data.fill(0, i, i + 4);
                }
            }
        }
        return {data, pixelFormat};
    }

    // ------------------------------------------------------------------------------------------------- factories

    /**
     * Reads the header of a GeoTIFF and returns what is known about it, without creating a model.
     *
     * @throws {GeoTiffModelError} with cause `ERROR_LOADING_FILE` when the file cannot be read
     */
    static async infoFromURL(url: string, options: GetInfoGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModelInfo> {
        const tiff = await openURL(url, options);
        const images = await readImages(tiff);
        const main = images[0];
        const info = GeoTiffTileSetModel.describe(main, tiff);
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
        if (!info.crsName) {
            info.crsName = await getReferenceFromPrjFile(url, options);
        }
        return info;
    }

    /**
     * Creates a model for the Cloud Optimized GeoTIFF at `url`, reading only its header.
     *
     * @throws {GeoTiffModelError} `ERROR_LOADING_FILE`, `NOTCOG`, `UnknownIdentifier` (see `error.identifier`),
     *   `BoundsMissing` or `INVALIDELEVATION`
     */
    static async createFromURL(url: string, options: CreateGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModel> {
        const tiff = await openURL(url, options);
        const images = await readImages(tiff);
        if (!isLikelyCOG(images[0], tiff)) {
            throw new GeoTiffModelError(`Not a Cloud Optimized GeoTIFF: ${url}`, "NOTCOG");
        }
        let reference = options.reference;
        if (!reference && !referenceIdentifierFromGeoKeys(geoKeysOf(images[0]))) {
            // No EPSG code in the file: look for a .prj next to it.
            const fromPrj = await getReferenceFromPrjFile(url, options);
            if (fromPrj) reference = resolveReference(fromPrj);
        }
        return GeoTiffTileSetModel.create(tiff, images, {...options, reference}, url);
    }

    /**
     * Creates a model for a GeoTIFF that is already open with geotiff.js, for example from `fromBlob(file)` for a
     * dropped file or `fromArrayBuffer(buffer)`. The file does not need to be a COG.
     *
     * @throws {GeoTiffModelError} `UnknownIdentifier`, `BoundsMissing` or `INVALIDELEVATION`
     */
    static async createFromGeoTIFF(tiff: GeoTIFF, options: CreateGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModel> {
        return GeoTiffTileSetModel.create(tiff, await readImages(tiff), options);
    }

    /**
     * **Experimental.** Creates one **elevation** model from several Cloud Optimized GeoTIFFs, typically the tiles of a
     * dataset that is published in pieces (such as swisstopo's 1 km swissALTI3D tiles). The API may change in a minor
     * release.
     *
     * LuciadRIA shows only one elevation layer at a time, so a tiled dataset has to be one model: each terrain tile
     * takes its heights from whichever files cover it (the first file in `urls` that has data wins where files
     * overlap). All files must use the same coordinate reference. Only their headers are read here.
     *
     * Imagery has no such limit: show image files as one layer each (for example in a `LayerGroup`).
     *
     * @throws {GeoTiffModelError} as {@link createFromURL}, for the first file that fails; `BoundsMissing` when the
     *   files use different references
     */
    static async createFromURLs(urls: string[], options: CreateGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModel> {
        if (urls.length === 0) throw new RangeError("createFromURLs needs at least one URL");
        if ((options.dataType ?? RasterDataType.IMAGE) !== RasterDataType.ELEVATION) {
            throw new RangeError("createFromURLs creates elevation models (dataType: RasterDataType.ELEVATION); "
                + "show imagery files as one layer each, for example in a LayerGroup");
        }
        const opened = await mapLimited(urls, 8, async (url) => {
            const tiff = await openURL(url, options);
            const images = await readImages(tiff);
            if (!isLikelyCOG(images[0], tiff)) throw new GeoTiffModelError(`Not a Cloud Optimized GeoTIFF: ${url}`, "NOTCOG");
            return {url, tiff, prepared: await GeoTiffTileSetModel.prepare(images, options)};
        });
        const reference = opened[0].prepared.reference;
        const different = opened.find((o) => o.prepared.reference.identifier !== reference.identifier);
        if (different) {
            throw new GeoTiffModelError(
                `All files must use the same reference: ${reference.identifier} and ${different.prepared.reference.identifier}`,
                "BoundsMissing",
            );
        }
        const files = await Promise.all(opened.map((o) => GeoTiffTileSetModel.elevationFile(o.prepared, options, o.url)));
        const first = opened[0];
        return GeoTiffTileSetModel.elevationModel(files, reference, options, first.prepared, first.tiff);
    }

    /** Everything create() needs from a GeoTIFF's directories. */
    private static async prepare(allImages: GeoTIFFImage[], options: CreateGeotiffFromUrlOptions) {
        const dataImages = allImages
            .filter((image) => !isMaskImage(image))
            .sort((a, b) => b.getWidth() - a.getWidth() || b.getHeight() - a.getHeight());
        const masks = allImages.filter(isMaskImage);
        const main = dataImages[0];
        if (!main) throw new GeoTiffModelError("The GeoTIFF contains no image", "ERROR_LOADING_FILE");

        const reference = options.reference ?? resolveReference(referenceIdentifierFromGeoKeys(geoKeysOf(main)));
        const isPixelReference = reference.identifier === "CRS:1";
        const mainGrid: RasterGrid | null = isPixelReference
            ? {width: main.getWidth(), height: main.getHeight(), resX: 1, resY: 1, west: 0, north: main.getHeight()}
            : gridOfMainImage(main);
        if (!mainGrid) {
            throw new GeoTiffModelError("The GeoTIFF has no georeferencing; pass options.reference", "BoundsMissing");
        }
        const grids = dataImages.map((image, i) => (i === 0 ? mainGrid : gridOfOverview(mainGrid, image)));
        const nodata = options.nodata ?? main.getGDALNoData() ?? null;
        const isFloat = sampleFormatOf(main) === 3;
        const defaultRange = isFloat
            ? (await gdalStatisticsRange(main)) ?? {min: 0, max: 1}
            : {min: 0, max: Math.pow(2, bitsPerSampleOf(main)) - 1};
        return {dataImages, masks, main, reference, mainGrid, grids, nodata, defaultRange};
    }

    /** Checks that a GeoTIFF can serve heights and describes how to read them. */
    private static async elevationFile(
        prepared: Awaited<ReturnType<typeof GeoTiffTileSetModel.prepare>>,
        options: CreateGeotiffFromUrlOptions,
        url?: string,
    ): Promise<ElevationFile> {
        const {main, dataImages, grids, mainGrid, nodata} = prepared;
        const band = options.elevation?.band ?? 0;
        if (!canRepresentElevation(main) || band < 0 || band >= main.getSamplesPerPixel()) {
            const pixel = analyzePixelFormat(main);
            throw new GeoTiffModelError(
                `This GeoTIFF cannot be used as elevation (${pixel.meaning}, band ${band})`,
                "INVALIDELEVATION",
                {pixelFormat: pixel.format ?? pixel.meaning},
            );
        }
        const {scale, offset} = await gdalScaleOffset(main, band);
        return {url, images: dataImages, grids, band, scale, offset, nodata, area: areaExtent(mainGrid)};
    }

    /** An elevation model over one or more files: a LuciadFusion-like quadtree spanning all of them. */
    private static elevationModel(
        files: ElevationFile[],
        reference: CoordinateReference,
        options: CreateGeotiffFromUrlOptions,
        first: Awaited<ReturnType<typeof GeoTiffTileSetModel.prepare>>,
        tiff: GeoTIFF,
    ): GeoTiffTileSetModel {
        const noDataHeight = options.elevation?.noDataHeight ?? Number.NaN;
        if (options.elevation?.noDataHeight !== undefined && !Number.isFinite(noDataHeight)) {
            throw new RangeError(`elevation.noDataHeight must be a finite number, got ${noDataHeight}`);
        }
        const tileSize = options.elevation?.tileSize ?? DEFAULT_ELEVATION_TILE_SIZE;
        // The union of all files, as one grid with the finest pixel size: the deepest level matches the finest data.
        const minX = Math.min(...files.map((f) => f.area[0])), minY = Math.min(...files.map((f) => f.area[1]));
        const maxX = Math.max(...files.map((f) => f.area[2])), maxY = Math.max(...files.map((f) => f.area[3]));
        const resX = Math.min(...files.map((f) => f.grids[0].resX)), resY = Math.min(...files.map((f) => f.grids[0].resY));
        const union: RasterGrid = {
            west: minX, north: maxY, resX, resY,
            width: Math.max(2, Math.round((maxX - minX) / resX)),
            height: Math.max(2, Math.round((maxY - minY) / resY)),
        };
        const structure = elevationTileStructure(union, tileSize);
        const [x, width, y, height] = structure.bounds;
        return new GeoTiffTileSetModel({
            structure: {
                reference,
                bounds: createBounds(reference, [x, width, y, height]),
                level0Columns: structure.level0Columns,
                level0Rows: structure.level0Rows,
                levelCount: structure.levelCount,
                tileWidth: tileSize,
                tileHeight: tileSize,
            },
            dataType: RasterDataType.ELEVATION,
            samplingMode: RasterSamplingMode.POINT,
            main: first.main,
            levels: [],
            elevation: {files, tileSize, noDataHeight},
            nodata: first.nodata,
            defaultRange: first.defaultRange,
            bandMapping: options.bandMapping,
            gradient: options.gradient,
            pool: options.pool,
            onReadError: options.onReadError,
            tiff,
        });
    }

    private static async create(
        tiff: GeoTIFF, allImages: GeoTIFFImage[], options: CreateGeotiffFromUrlOptions, url?: string,
    ): Promise<GeoTiffTileSetModel> {
        const prepared = await GeoTiffTileSetModel.prepare(allImages, options);
        const {dataImages, masks, main, reference, mainGrid, nodata, defaultRange} = prepared;
        const dataType = options.dataType ?? RasterDataType.IMAGE;

        if (dataType === RasterDataType.ELEVATION) {
            const file = await GeoTiffTileSetModel.elevationFile(prepared, options, url);
            return GeoTiffTileSetModel.elevationModel([file], reference, options, prepared, tiff);
        }

        const [minX, minY, maxX, maxY] = areaExtent(mainGrid);
        const bounds = createBounds(reference, [minX, maxX - minX, minY, maxY - minY]);
        const levels: ImageLevel[] = [];
        const tileMatrix: TileMatrix[] = [];
        // LuciadRIA level 0 is the coarsest: walk from the smallest overview to the full-resolution image.
        for (let i = dataImages.length - 1; i >= 0; i--) {
            const image = dataImages[i];
            const {tileWidth, tileHeight} = servedTileSize(image);
            const columns = Math.ceil(image.getWidth() / tileWidth);
            const rows = Math.ceil(image.getHeight() / tileHeight);
            const levelWidth = (bounds.width * columns * tileWidth) / image.getWidth();
            const levelHeight = (bounds.height * rows * tileHeight) / image.getHeight();
            let levelBounds = createBounds(reference, [bounds.x, levelWidth, bounds.y + bounds.height - levelHeight, levelHeight]);
            if (boundsEqual(levelBounds, bounds, 1e-6)) levelBounds = bounds;
            const mask = masks.find((m) => m.getWidth() === image.getWidth() && m.getHeight() === image.getHeight()) ?? null;
            levels.push({image, mask, tileWidth, tileHeight, columns, rows});
            tileMatrix.push({bounds: levelBounds, tileWidth, tileHeight, tileColumnCount: columns, tileRowCount: rows});
        }
        return new GeoTiffTileSetModel({
            structure: {tileMatrix, bounds, reference},
            dataType,
            samplingMode: detectSamplingMode(main),
            main,
            levels,
            elevation: null,
            nodata,
            defaultRange,
            bandMapping: options.bandMapping,
            gradient: options.gradient,
            pool: options.pool,
            onReadError: options.onReadError,
            tiff,
        });
    }

    private static describe(main: GeoTIFFImage, tiff: GeoTIFF): GeoTiffTileSetModelInfo {
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
            isCog: isLikelyCOG(main, tiff),
            crsName: referenceIdentifierFromGeoKeys(geoKeysOf(main)),
            samplingMode: detectSamplingMode(main),
            canBeElevation: canRepresentElevation(main),
        };
    }
}

// ----------------------------------------------------------------------------------------------------- helpers

async function openURL(url: string, options: HttpAccessOptions): Promise<GeoTIFF> {
    try {
        // `credentials` is forwarded to fetch() by geotiff.js (makeFetchSource) but missing from its option typings.
        const sourceOptions = {
            allowFullFile: true,
            headers: (options.requestHeaders ?? undefined) as Record<string, string> | undefined,
            credentials: fetchCredentials(options),
            // Explicit on purpose: reads are then grouped into cached 64 KiB blocks. geotiff.js 3.0.4/3.0.5 dropped
            // this default for fromUrl() (geotiff.js #516, fixed by #530 in 3.1), which floods the server with small
            // range requests.
            blockSize: 65536,
        } as Parameters<typeof fromUrl>[1];
        // geotiff.js' decoded-tile cache (`tiff.cache = true`) is not enabled: fetched bytes are already cached by its
        // block source, so re-reading a block costs a decode, not a request. Keep the explicit blockSize when moving
        // to geotiff.js 3.1 (which restores the default itself): it costs nothing and guards against such changes.
        return await fromUrl(withRequestParameters(url, options), sourceOptions);
    } catch (error) {
        throw new GeoTiffModelError(`Error loading GeoTIFF file from URL: ${url}`, "ERROR_LOADING_FILE", {error});
    }
}

/** Maps `items` with at most `limit` calls of `fn` in flight; rejects with the first error. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return results;
}

async function readImages(tiff: GeoTIFF): Promise<GeoTIFFImage[]> {
    try {
        const count = await tiff.getImageCount();
        const images: GeoTIFFImage[] = [];
        for (let i = 0; i < count; i++) images.push(await tiff.getImage(i));
        return images;
    } catch (error) {
        throw new GeoTiffModelError("Error reading the GeoTIFF image directories", "ERROR_LOADING_FILE", {error});
    }
}

function resolveReference(identifier: string | null): CoordinateReference {
    if (!identifier) {
        throw new GeoTiffModelError(
            "The GeoTIFF declares no EPSG coordinate reference; pass options.reference",
            "BoundsMissing",
        );
    }
    try {
        return getReference(identifier);
    } catch (error) {
        throw new GeoTiffModelError(`Unknown coordinate reference ${identifier}`, "UnknownIdentifier", {identifier, error});
    }
}

/**
 * Tile size used for LuciadRIA. Tiled images use their own blocks, also when the image is smaller than one block
 * (small COG overviews): LuciadRIA's draping rejects tile matrix sets whose levels use different tile sizes.
 * Strip images are served in virtual tiles of the largest power of 2 that fits, up to 512.
 */
function servedTileSize(image: GeoTIFFImage): { tileWidth: number; tileHeight: number } {
    const width = image.getWidth();
    const height = image.getHeight();
    const tileWidth = image.getTileWidth();
    const tileHeight = image.getTileHeight();
    if (image.isTiled) {
        return {tileWidth, tileHeight};
    }
    const fit = (size: number) => Math.min(512, Math.pow(2, Math.floor(Math.log2(Math.max(1, size)))));
    const size = Math.min(fit(width), fit(height));
    return {tileWidth: size, tileHeight: size};
}

function boundsEqual(a: Bounds, b: Bounds, eps: number): boolean {
    return Math.abs(a.x - b.x) < eps && Math.abs(a.width - b.width) < eps
        && Math.abs(a.y - b.y) < eps && Math.abs(a.height - b.height) < eps;
}

function rgbToRgba(rgb: Uint8Array): Uint8Array {
    const pixels = rgb.length / 3;
    const rgba = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
        rgba[i * 4] = rgb[i * 3];
        rgba[i * 4 + 1] = rgb[i * 3 + 1];
        rgba[i * 4 + 2] = rgb[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

/**
 * Makes pixels with the nodata color transparent (RGBA data). As in GDAL, a pixel is nodata when all its color
 * bands equal the nodata value (for palette images: when its color is the palette color of the nodata index).
 */
function stripNoDataColor(rgba: Uint8Array, nodata: number, colorMap: ArrayLike<number> | null): void {
    const entries = colorMap ? colorMap.length / 3 : 0;
    const [r0, g0, b0] = colorMap
        ? [colorMap[nodata] >> 8, colorMap[entries + nodata] >> 8, colorMap[2 * entries + nodata] >> 8]
        : [nodata, nodata, nodata];
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] === r0 && rgba[i + 1] === g0 && rgba[i + 2] === b0) rgba.fill(0, i, i + 4);
    }
}
