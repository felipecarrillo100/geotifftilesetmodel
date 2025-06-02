import {
  RasterTileSetModel,
  type RasterTileSetModelConstructorOptions,
  type TileMatrix
} from "@luciad/ria/model/tileset/RasterTileSetModel.js";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {GeoTIFF, ReadRasterResult, TypedArray} from "geotiff";
import {fromUrl, GeoTIFFImage, Pool} from "geotiff";
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import {createBounds} from "@luciad/ria/shape/ShapeFactory.js";
import type {TileData} from "@luciad/ria/model/tileset/TileData.js";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {CoordinateReference} from "@luciad/ria/reference/CoordinateReference.js";
import {Bounds} from "@luciad/ria/shape/Bounds.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode.js";
import type {HttpRequestHeaders, HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";
import {ModelDescriptor} from "@luciad/ria/model/ModelDescriptor";
import {RetiledGeoTIFFImage} from "./RetiledGeoTIFFImage";
import {analyzePixelFormat, detectSamplingMode, isLikelyCOG, normalizeRawTypedArray} from "./utils";
import {CogGradient, CogGradientColorMap, PixelMeaningEnum} from "./interfaces";
import {convert32FloatTo8BitRGB, convertSingleBandTo8BitRGB, downscale16to8bits} from "./bitstorgb";
import {GrayscaleGradient, GrayScaleTransformation, TransformToGradientColorMap} from "./gradients";
import {BandMapping, convertBandsTo8BitRGB} from "./bandstorgb";
import {getReferenceFromPrjFile} from "./fileutils";
import {createGradientColorMap} from "@luciad/ria/util/ColorMap";

const pool = new Pool();

/**
 * Options for retrieving GeoTIFF information from a URL.
 */
export interface GetInfoGeotiffFromUrlOptions {
  /**
   * Indicates whether credentials such as cookies or authentication headers should be included in the request.
   * Defaults to `false` if not specified.
   */
  credentials?: boolean;

  /**
   * Optional headers to include in the HTTP request.
   * Can be `undefined` if no additional headers are needed.
   */
  requestHeaders?: null | HttpRequestHeaders;

  /**
   * Optional parameters to include in the HTTP request.
   * Can be `undefined` if no additional parameters are needed.
   */
  requestParameters?: null | HttpRequestParameters;
}

/**
 * Options for creating a GeoTIFF from a URL.
 */
export interface CreateGeotiffFromUrlOptions {
  /**
   * Indicates whether credentials such as cookies or authentication headers should be included in the request.
   * Defaults to `false` if not specified.
   */
  credentials?: boolean;

  /**
   * Optional headers to include in the HTTP request.
   * Can be `undefined` if no additional headers are needed.
   */
  requestHeaders?: null | HttpRequestHeaders;

  /**
   * Optional parameters to include in the HTTP request.
   * Can be `undefined` if no additional parameters are needed.
   */
  requestParameters?: null | HttpRequestParameters;

  /**
   * The data type of the raster data to be processed.
   * This defines the format of the data as LuciadRIA enum RasterDataType.IMAGE or RasterDataType.ELEVATION.
   */
  dataType?: RasterDataType;

  /**
   * The coordinate reference system to be used for the GeoTIFF.
   * This defines how the spatial data is projected, use type LuciadRIA CoordinateReference.
   */
  reference?: CoordinateReference;

  /**
   * The value to be used to represent 'no data' in the raster.
   * This is typically a special value that indicates missing or undefined data, if not defined 0 is assumed to be nodata.
   */
  nodata?: number;

  /**
   * The mapping of bands in the raster data as defined in interface `BandMapping`
   * This defines how different bands are interpreted or used.
   */
  bandMapping?: BandMapping;

   /**
   * The gradient color map to apply to the Cloud Optimized GeoTIFF (COG).
   *
   * This property defines how data values in the COG are mapped to colors using a gradient.
   * The gradient is specified using the `CogGradient` type, which includes:
   * - `colorMap`: An array of color stops (`CogGradientColorMap`) that define the gradient. Each stop specifies:
   *    - A `level` (normalized between 0.0 and 1.0) representing the position in the gradient.
   *    - A `color` (in hex format, e.g., "#ff0000" for red) to assign at that level.
   * - `range` (optional): Specifies the minimum and maximum values of the data range to which the gradient is applied.
   *    - If `range` is omitted, the gradient will be applied across the full range of data values in the COG.
   *
   * This gradient is used to visually represent the data in the COG, such as elevation, temperature, or other measurements,
   * by mapping numerical values to colors.
   *
   * @example
   * // Example gradient for mapping elevation data
   * const gradient = {
   *   colorMap: [
   *     { level: 0.0, color: "#0000ff" }, // Blue at the lowest value
   *     { level: 0.5, color: "#00ff00" }, // Green at the midpoint
   *     { level: 1.0, color: "#ff0000" }  // Red at the highest value
   *   ],
   *   range: {
   *     min: 0,    // Minimum elevation
   *     max: 1000  // Maximum elevation
   *   }
   * };
   */
  gradient?: CogGradient;
}



interface StripResult {
  data: Uint8Array;
  pixelFormat: PixelFormat;
}


/**
 * This object is private, no need to document
 */
interface GeoTiffTileSetModelOptions extends RasterTileSetModelConstructorOptions{
  // For access
  credentials?: boolean;
  requestHeaders?: null | HttpRequestHeaders;
  requestParameters?: null | HttpRequestParameters;
  // For process
  images: GeoTIFFImage[];
  maskImages: GeoTIFFImage[];
  // Processing options
  nodata?: number;
  format?: PixelFormat;
  bands?: number[];
  bandMapping?: BandMapping;
  gradient?: CogGradient;
}

/**
 * Presents the information retrieved from a GeoTIFF tile set.
 */
export interface GeoTiffTileSetModelInfo {
  /**
   * The width of each tile in pixels.
   */
  tileWidth: number;

  /**
   * The height of each tile in pixels.
   */
  tileHeight: number;

  /**
   * The total width of the image in pixels.
   */
  width: number;

  /**
   * The total height of the image in pixels.
   */
  height: number;

  /**
   * The number of bytes per pixel.
   */
  bytesPerPixel: number;

  /**
   * The number of bits per sample. This can be a single number or an array of numbers.
   */
  bitsPerSample: number | number[];

  /**
   * The number of bands in the image.
   */
  bands: number;

  /**
   * Indicates whether the image is tiled.
   */
  isTiled: boolean;

  /**
   * The meaning of the pixel values, represented by a `PixelMeaningEnum`.
   */
  pixelMeaning: PixelMeaningEnum;

  /**
   * Autodetected LuciadRIA pixel format
   */
  pixelFormat: PixelFormat;

  /**
   * Indicates whether the image is a Cloud Optimized GeoTIFF (COG).
   */
  isCog: boolean;

  /**
   * The crsName is the projection of the image in string format (i.e. 'EPSG:3857').
   */
  crsName: string;

  /**
   * The sampling mode used for raster data RasterSamplingMode.AREA or RasterSamplingMode.POINT
   */
  samplingMode: RasterSamplingMode;
}

export class GeoTiffTileSetModel extends RasterTileSetModel {

  private _images: GeoTIFFImage[];
  private _maskImages: GeoTIFFImage[];
  private _pixelFormat: PixelFormat;
  private _nodata: number | undefined;
  private _bands: number[] | undefined;
  private _transformation: ((x: number) => [number, number, number]) | undefined;
  private _bandsNumber: number;
  private _pixelFormatMeaning: PixelMeaningEnum;
  private bandMapping: BandMapping;
  private colorMap: CogGradientColorMap;
  private nativeRange: { min: number; max: number };
  private _bitsPerSample: number;

  /**
   * The constructor is private, don't call it directly, instead, use method: GeoTiffTileSetModel.createFromURL
   */
  private constructor(options: GeoTiffTileSetModelOptions) {
    super(options);
    const {images, maskImages} = options;
    const {format, nodata, bands} = options;
    this._images = images;
    this._maskImages = maskImages;
    const pixelResult = analyzePixelFormat(images[0]);
    this._pixelFormat = format ? format : pixelResult.format;
    this._pixelFormatMeaning = pixelResult.meaning;
    this._nodata = nodata;
    this._bands = bands ;
    this.modelDescriptor = {
      name: "GeoTiffTileSetModel",
      description: "The GeoTiffTileSetModel is a specialized data structure designed to handle and represent geospatial data in the form of GeoTIFF tiles",
      source: "Open Geospatial Consortium (OGC) "
    } as ModelDescriptor;
    this._bandsNumber =  images[0].getSamplesPerPixel();
    this._bitsPerSample = images[0].getBitsPerSample();

    this.bandMapping = options.bandMapping ? options.bandMapping : {
      red: 0,
      green: 0,
      blue: 0,
      gray: 0,
      rgb: false
    };
    this.colorMap = options.gradient && options.gradient.colorMap ? options.gradient.colorMap : GrayscaleGradient;
    this.nativeRange = options.gradient && options.gradient.range ?
        options.gradient.range :
        {min: 0, max: Math.pow(2, this._bitsPerSample) - 1};
    this._transformation = TransformToGradientColorMap(createGradientColorMap(this.colorMap));
  }

  private static getInfo(tile0: GeoTIFFImage, tiff: GeoTIFF = null): GeoTiffTileSetModelInfo {
    const bytesPerPixel = tile0.getBytesPerPixel();
    const bitsPerSample = tile0.getBitsPerSample();
    const bands = tile0.getSamplesPerPixel();
    const pixelResult = analyzePixelFormat(tile0);

    const tileWidth = tile0.getTileWidth();
    const tileHeight = tile0.getTileHeight();
    const width =  tile0.getWidth();
    const height = tile0.getHeight();
    const isTiled = tile0.isTiled;

    const isCog= tiff ? isLikelyCOG(tile0, tiff) : true;
    const geoKeys = tile0.geoKeys;
    const crsName = getReferenceFromEPSGCode(geoKeys);
    const samplingMode = detectSamplingMode(tile0);
    return {
      tileWidth,
      tileHeight,
      width,
      height,
      bytesPerPixel,
      bitsPerSample,
      bands,
      isTiled,
      pixelMeaning: pixelResult.meaning,
      pixelFormat: pixelResult.format,
      isCog,
      crsName,
      samplingMode
    };
  }

  /**
   * The getModelInfo returns all the values found in the Geotiff URL
   */
  public getModelInfo() {
    return GeoTiffTileSetModel.getInfo(this._images[0]);
  }

  /**
   * Sets the gradient for the color map.
   *
   * This method updates the gradient array, which defines how data values are mapped to colors.
   * The provided gradient must include a valid `CogGradient` object with a `colorMap` array and an optional `range`.
   * If no gradient is provided, a default grayscale gradient will be used.
   *
   * @param gradient - The gradient definition to apply.
   *   - `gradient.colorMap` (required): An array of color stops that define the gradient.
   *     - `gradient.colorMap[].level` (number): A normalized value between 0.0 and 1.0.
   *       - The first level must be `0.0`, and the last level must be `1.0`.
   *       - Levels must be in ascending order.
   *     - `gradient.colorMap[].color` (string): The color associated with the level, specified as a hex string (e.g., `"#ff0000"`) or an RGB string (e.g., `"rgb(255,0,0)"`).
   *   - `gradient.range` (optional): Specifies the minimum and maximum values of the data range to which the gradient applies.
   *     - If not provided, the current `nativeRange` is preserved.
   * @param invalidate - A boolean flag indicating whether to trigger a repaint after updating the gradient.
   *   - Set to `false` to prevent triggering a repaint. Defaults to `true`.
   *
   * @example
   * // Example: Setting a custom gradient
   * const gradient = {
   *   colorMap: [
   *     { level: 0.0, color: "#0000ff" }, // Blue at the lowest value
   *     { level: 0.5, color: "#00ff00" }, // Green at the midpoint
   *     { level: 1.0, color: "#ff0000" }  // Red at the highest value
   *   ],
   *   range: {
   *     min: 0,    // Minimum value
   *     max: 1000  // Maximum value
   *   }
   * };
   * setGradient(gradient);
   *
   * @example
   * // Example: Resetting to the default grayscale gradient and skipping repaint
   * setGradient(null, false);
   */
  public setGradient(gradient: CogGradient, invalidate=true) {
    if (gradient) {
      this.colorMap = gradient.colorMap;
      const colorMap = createGradientColorMap(this.colorMap);
      this._transformation = TransformToGradientColorMap(colorMap);
      this.nativeRange = gradient.range ? gradient.range : this.nativeRange;
    } else {
      this.colorMap = GrayscaleGradient;
      this.nativeRange = {min: 0, max: Math.pow(2, this._bitsPerSample)};
      const colorMap = createGradientColorMap(this.colorMap);
      this._transformation = TransformToGradientColorMap(colorMap);
    }
    if (invalidate) this.invalidate();
  }

  /**
   * Retrieves the currently applied gradient.
   *
   * This method returns the gradient of type `CogGradient`, which includes:
   * - `colorMap`: An array of color stops defining the gradient. Each stop specifies:
   *   - `level` (number): A normalized value between 0.0 and 1.0, representing the position in the gradient.
   *   - `color` (string): The color associated with the level, represented as a hex string (e.g., `"#ff0000"`) or an RGB string (e.g., `"rgb(255,0,0)"`).
   * - `range`: The minimum and maximum values of the data range that the gradient applies to.
   *   - If no custom range was set, this reflects the default range based on the data.
   *
   * @returns {CogGradient} The currently used normalized gradient, including the `colorMap` and `range`.
   *
   * @example
   * // Example: Retrieving the current gradient
   * const gradient = getGradient();
   * console.log(gradient.colorMap); // Logs the array of color stops
   * console.log(gradient.range);    // Logs the range { min: ..., max: ... }
   */
  public getGradient(): CogGradient {
    return {
      colorMap: this.colorMap,
      range: this.nativeRange
    };
  }

  /**
   * Sets the band mapping for the raster image and optionally invalidates the current state.
   *
   * @param bandMapping - The band mapping configuration, as defined by the `BandMapping` interface.
   *   Specifies the indices for red, green, blue, and gray channels, and indicates if the mapping is for an RGB image.
   * @param invalidate - A boolean flag indicating whether to invalidate the current state after setting the band mapping.
   *   Defaults to `true`.
   *
   * @returns void
   */
  public setBandMapping(bandMapping: BandMapping, invalidate=true) {
    this.bandMapping = bandMapping ? bandMapping : {
      gray: 0,
      red: 0,
      green: 0,
      blue: 0,
      rgb: false
    };
    if (invalidate) this.invalidate();
  }

  /**
   * Gets the bandMapping
   * @returns the currently used `bandMapping`.
   */
  public getBandMapping() {
    return this.bandMapping;
  }

  /**
   * Sets the nodata value.
   * @param nodata - The value that will be set as transparent if found in the data
   * @param invalidate - Set to false if you don't want to trigger a repaint
   */
  public setNodata(nodata: number, invalidate=true) {
    this._nodata = nodata;
    if (invalidate) this.invalidate();
  }

  /**
   * Gets the nodata value.
   * The nodata value will be set as transparent if found in the data
   * @returns the currently used `nodata` value.
   */
  public getNodata() {
    return this._nodata;
  }

  getTileData(
      tile: TileCoordinate,
      onSuccess: (tile: TileCoordinate, data: TileData) => void,
      onError: (tile: TileCoordinate, error: any) => void,
      signal: AbortSignal | null
  ): void {
    const flipY = this.reference.identifier === "CRS:1";
    const image = this._images[tile.level];
    const maskImage = this._maskImages[tile.level];
    const imageWidth = image.getWidth();
    const imageHeight = image.getHeight();
    const tileWidth = image.getTileWidth();
    const tileHeight = image.getTileHeight();

    const tileY = this.getTileRowCount(tile.level)! - tile.y - 1;
    const tileOffsetX = tileWidth * tile.x;
    const tileOffsetY = flipY
        ? imageHeight - tileHeight * (tileY + 1)
        : tileHeight * tileY;

    const window = [tileOffsetX, tileOffsetY, tileOffsetX + tileWidth, tileOffsetY + tileHeight];
    const nodata = typeof this._nodata !== "undefined" ? this._nodata : image.getGDALNoData();

    if (this.dataType === RasterDataType.ELEVATION && this._bandsNumber === 1) {
      if (this._pixelFormat === PixelFormat.FLOAT_32 || this._pixelFormat === PixelFormat.UINT_32) {
        const pixelFormat = this._pixelFormat || PixelFormat.FLOAT_32;
        image.readRasters({ window, pool, signal })
            .then(rawValues => {
              const raw = (Array.isArray(rawValues) ? rawValues[0] : rawValues) as TypedArray;

              if (isNumber(nodata)) {
                for (let i = 0; i < raw.length; i++) {
                  if (equals(raw[i], nodata)) {
                    raw[i] = 0;
                  }
                }
              }
              const floats = new Float32Array(raw); // Handle cast safely
              onSuccess(tile, {
                data: floats.buffer,
                pixelFormat,
                width: tileWidth,
                height: tileHeight,
              });
            })
            .catch(error => {
              console.error("Elevation read error", error);
              onError(tile, error);
            });
      } else {
        const error = new Error("Error creating Geotiff Model") as any;
        error.cause = "INVALIDELEVATION";
        error.pixelFormat = this._pixelFormat; // Add any extra parameter you need
        throw error;
      }
    } else if (this._bandsNumber === 1) {
      const bands = [0];
      const pixelFormatBandUndefined = this._pixelFormat || ((bands.length === 4 || isNumber(nodata)) ? PixelFormat.RGBA_8888 : PixelFormat.RGB_888);

      const rasterPromise = image.readRasters({window, pool, interleave: true, signal: signal!, samples: this._bands});
      // const rasterPromise = image.readRasters({samples: [0]});
      const maskPromise = maskImage ? maskImage.readRasters({window, pool, signal: signal!}) : Promise.resolve(null);
      Promise.all([rasterPromise, maskPromise]).then(raws => {
        const rawValuesOrArray = raws[0];
        const rawMask = raws[1];
        let raw = (Array.isArray(rawValuesOrArray) ? rawValuesOrArray[0] : rawValuesOrArray) as ReadRasterResult;
       // console.assert(raw.length === (tileWidth * tileHeight * bands.length));
        if (raw.length < (tileWidth * tileHeight)) {
          raw = normalizeRawTypedArray(raw, tileWidth * tileHeight, nodata);
        }

        let pixelFormat = pixelFormatBandUndefined;
        let data: Uint8Array;
        const transformation = this._transformation;
        if (this._bitsPerSample === 32 && this._pixelFormat === PixelFormat.FLOAT_32) {
          //  Handle float 32 bits
          data = convert32FloatTo8BitRGB(raw as Float32Array, bands.length, nodata, transformation); // Takes care of bit conversion, 1 band to 3 bands conversion and the no data value.
        } else {
          //  Handle integer 8, 16 and 32 bits
          data = convertSingleBandTo8BitRGB(raw, {bits:this._bitsPerSample, nativeRange: this.nativeRange, samplesPerPixel: 1, transformation, nodata}); //  Takes care of bit conversion and 1 band to 3 bands conversion.
        }
        if (isNumber(nodata)) {
          pixelFormat =  PixelFormat.RGBA_8888
        } else {
          pixelFormat =  PixelFormat.RGB_888
        }
        // Apply Mask
        const stripResult = this.clipAndMaskTilePixels(
            data, pixelFormat, rawMask, {...tile, y: tileY},
            tileOffsetX, tileOffsetY, tileWidth, tileHeight,
            imageWidth, imageHeight, flipY
        );
        data = stripResult.data;
        pixelFormat = stripResult.pixelFormat;

        onSuccess(tile, {data: data.buffer, pixelFormat, width: tileWidth, height: tileHeight});
      }).catch(error => {
        console.log("NO", error);
        onError(tile, error)
      });

    } else if (this._bandsNumber > 1 && this._pixelFormatMeaning === PixelMeaningEnum.Multiband) {
      const rasterPromise = image.readRasters({window, pool, interleave: true, signal: signal!});
      const maskPromise = maskImage ? maskImage.readRasters({window, pool, signal: signal!}) : Promise.resolve(null);
      Promise.all([rasterPromise, maskPromise]).then(raws => {
        const rawValuesOrArray = raws[0];
        const rawMask = raws[1];

        const transformation = this._transformation ? this._transformation : GrayScaleTransformation;

        let raw  = (Array.isArray(rawValuesOrArray) ? rawValuesOrArray[0] : rawValuesOrArray) as ReadRasterResult;
        // console.assert(raw.length === (tileWidth * tileHeight * bands.length));
        if (raw.length < (tileWidth * tileHeight)) {
          raw = normalizeRawTypedArray(raw, tileWidth * tileHeight, nodata) as any;
        }
        let data: Uint8Array = convertBandsTo8BitRGB(raw, {bits: image.getBitsPerSample(), nativeRange: this.nativeRange, bands: this._bandsNumber, transformation, bandMapping: this.bandMapping, nodata}); // Takes care of bit conversion, 1 band to 3 bands conversion and the no data value.
        let pixelFormat = PixelFormat.RGBA_8888;
        // Apply Mask
        const stripResult = this.clipAndMaskTilePixels(
            data, pixelFormat, rawMask, {...tile, y: tileY},
            tileOffsetX, tileOffsetY, tileWidth, tileHeight,
            imageWidth, imageHeight, flipY
        );
        data = stripResult.data;
        pixelFormat = stripResult.pixelFormat;
        onSuccess(tile, {data: data.buffer, pixelFormat, width: tileWidth, height: tileHeight});
      });
    }  else {
      const pixelFormat_ = this._pixelFormat;
      const rgbPromise = image.readRGB({window, pool, enableAlpha: pixelFormat_ === PixelFormat.RGBA_8888, signal: signal!});
      const maskPromise = maskImage ? maskImage.readRasters({window, pool, signal: signal!}) : Promise.resolve(null);
      Promise.all([rgbPromise, maskPromise]).then(raws => {
        const raw = raws[0];
        const rawMask = raws[1];
        let pixelFormat = pixelFormat_;
        let data = (image.getBitsPerSample() === 16) ? downscale16to8bits(raw as Uint16Array) : raw as Uint8Array;

        // Apply Mask
        const stripResult = this.clipAndMaskTilePixels(
            data, pixelFormat, rawMask, {...tile, y: tileY},
            tileOffsetX, tileOffsetY, tileWidth, tileHeight,
            imageWidth, imageHeight, flipY
        );
        data = stripResult.data;
        pixelFormat = stripResult.pixelFormat;

        // Remove Nodata, this applies for RGB images
        if (isNumber(nodata)) {
          data = (pixelFormat === PixelFormat.RGB_888) ? this.convertRGBToRGBA(data) : data;
          pixelFormat = PixelFormat.RGBA_8888;
          this.stripPixelsNoData(data, nodata, isPalette(image) ? image.getFileDirectory().ColorMap : null);
        }
        onSuccess(tile, {data: data.buffer, pixelFormat, width: tileWidth, height: tileHeight});
      }).catch(error => {
        console.log("NO", error);
        onError(tile, error)
      });
    }
  }

  private convertRGBToRGBA(rgbData: Uint8Array): Uint8Array {
    const pixelCount = rgbData.length / 3; // Number of RGB pixels
    const rgbaData = new Uint8Array(pixelCount * 4); // Allocate space for RGBA pixels
    for (let index = 0; index < pixelCount; index++) {
      rgbaData[index * 4] = rgbData[index * 3];       // R
      rgbaData[index * 4 + 1] = rgbData[index * 3 + 1]; // G
      rgbaData[index * 4 + 2] = rgbData[index * 3 + 2]; // B
      rgbaData[index * 4 + 3] = 255;                 // A (fully opaque)
    }
    return rgbaData;
  }

  private stripPixelsNoData(raw: Uint8Array, nodata: number, colorMap: Uint16Array | null) {
    // Precompute nodataColor to avoid recalculating repeatedly
    const nodataColor = colorMap
        ? [colorMap[nodata] >> 8, colorMap[256 + nodata] >> 8, colorMap[512 + nodata] >> 8]
        : [nodata, nodata, nodata];

    // Define the evaluation function based on whether a colorMap is provided
    const evaluate = colorMap
        ? (r: number, g: number, b: number) => r === nodataColor[0] && g === nodataColor[1] && b === nodataColor[2]
        : (r: number, g: number, b: number) => r === nodataColor[0] || g === nodataColor[1] || b === nodataColor[2];

    // Process pixels in the raw data
    const pixelCount = raw.length / 4; // Number of RGBA pixels
    for (let index = 0; index < pixelCount; index++) {
      const r = raw[index * 4];
      const g = raw[index * 4 + 1];
      const b = raw[index * 4 + 2];
      if (evaluate(r, g, b)) {
        raw.fill(0, index * 4, index * 4 + 4); // Set RGBA to transparent
      }
    }
  }

  // @ts:ignore
  getImage(_tile: TileCoordinate, _onSuccess: (tile: TileCoordinate, image: HTMLImageElement) => void, _onError: (tile: TileCoordinate, error?: any) => void,
           _signal: AbortSignal | null): void {
    throw "Unused";
  }

  private clipAndMaskTilePixels(
      data: Uint8Array,
      pixelFormat: PixelFormat,
      rawMask: ReadRasterResult | null,
      tile: TileCoordinate,
      tileOffsetX: number,
      tileOffsetY: number,
      tileWidth: number,
      tileHeight: number,
      imageWidth: number,
      imageHeight: number,
      flipY: boolean
  ): StripResult {
    const { data: maskedData, pixelFormat: updatedPixelFormat } = this.stripPixelsByMask(data, rawMask, pixelFormat);
    return this.stripPixelsOutsideImageArea(
        maskedData,
        updatedPixelFormat,
        tile,
        tileOffsetX,
        tileOffsetY,
        tileWidth,
        tileHeight,
        imageWidth,
        imageHeight,
        flipY
    );
  }

  private stripPixelsByMask(
      data: Uint8Array,
      rawMaskResult: ReadRasterResult | null,
      pixelFormat: PixelFormat
  ): StripResult {
    if (!rawMaskResult) {
      return { data, pixelFormat };
    }

    const rawMask = (Array.isArray(rawMaskResult) ? rawMaskResult[0] : rawMaskResult) as Uint8Array;

    if (pixelFormat === PixelFormat.RGB_888) {
      data = this.convertRGBToRGBA(data);
      pixelFormat = PixelFormat.RGBA_8888;
    }

    const channels = 4; // Assumes RGBA format
    for (let index = 0; index < rawMask.length; index++) {
      if (rawMask[index] === 0) {
        data.fill(0, index * channels, index * channels + channels);
      }
    }

    return { data, pixelFormat };
  }

  private stripPixelsOutsideImageArea(
      data: Uint8Array,
      pixelFormat: PixelFormat,
      tile: TileCoordinate,
      tileOffsetX: number,
      tileOffsetY: number,
      tileWidth: number,
      tileHeight: number,
      imageWidth: number,
      imageHeight: number,
      flipY: boolean
  ): StripResult {
    const isLastTileInRow = tile.x === this.getTileColumnCount(tile.level)! - 1;
    const isLastTileInColumn = tile.y === this.getTileRowCount(tile.level)! - 1;

    if (isLastTileInRow || isLastTileInColumn) {
      if (pixelFormat === PixelFormat.RGB_888) {
        data = this.convertRGBToRGBA(data);
        pixelFormat = PixelFormat.RGBA_8888;
      }

      const channels = 4; // Assumes RGBA format
      for (let py = 0; py < tileHeight; py++) {
        for (let px = 0; px < tileWidth; px++) {
          const index = (py * tileWidth + px) * channels;
          const isOutsideImage = (tileOffsetX + px >= imageWidth) || (flipY ? (tileOffsetY + py < 0) : (tileOffsetY + py >= imageHeight));
          if (isOutsideImage) {
            data.fill(0, index, index + channels);
          }
        }
      }
    }

    return { data, pixelFormat };
  }

  /**
   * Retrieves information about a GeoTIFF tile set model from a specified URL.
   *
   * @param url - The URL from which to retrieve the GeoTIFF information.
   * @param options - Optional configuration for accessing the GeoTIFF, as defined by the `GetInfoGeotiffFromUrlOptions` interface.
   *   - `credentials`: Indicates whether credentials should be included in the request.
   *   - `requestHeaders`: Headers to include in the HTTP request.
   *   - `requestParameters`: Parameters to include in the HTTP request.
   * @returns A promise that resolves to a `GeoTiffTileSetModelInfo`, containing details about the GeoTIFF tile set model.
   *
   * @throws Will throw an error if the URL is invalid or the GeoTIFF information cannot be retrieved.
   */
  static async infoFromURL(url: string, options: GetInfoGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModelInfo> {
    let geoTiffFile;
    try {
      geoTiffFile = await fromUrl(url, {
        allowFullFile: true,
        headers: options.requestHeaders,
        credentials: options.credentials ? "same-origin" : "omit"
      });
    }  catch (e) {
      const error = new Error(`Error loading GeoTIFF file from URL: ${url}`) as any;
      error.cause = "ERROR_LOADING_FILE";
      throw error;
    }
    geoTiffFile.cache = true;
    const mostDetailedImage = await geoTiffFile.getImage(0);
    const info = GeoTiffTileSetModel.getInfo(mostDetailedImage, geoTiffFile);
    if (!info.crsName) {
      const crs = await getReferenceFromPrjFile(url, options);
      if (crs) info.crsName === crs;
    }
    return info;
  }


  /**
   * Creates a GeoTIFF tile set model from a specified URL.
   *
   * @param url - The URL from which to retrieve the GeoTIFF data.
   * @param options - Optional configuration for creating the GeoTIFF, as defined by the `CreateGeotiffFromUrlOptions` interface.
   *   - `credentials`: Indicates whether credentials should be included in the request.
   *   - `requestHeaders`: Headers to include in the HTTP request.
   *   - `requestParameters`: Parameters to include in the HTTP request.
   *   - `dataType`: The data type of the raster data to be processed `DataType`.
   *   - `reference`: The coordinate reference system to be used `CoordinateReference`.
   *   - `nodata`: The value representing 'no data' in the raster, by default 0.
   *   - `bandMapping`: The mapping of bands in the raster data as defined in `BandMapping`.
   *   - `gradient`: The gradient color map to apply as defined in `CogGradientColorMap`.
   * @returns A promise that resolves to a `GeoTiffTileSetModel`, representing the created GeoTIFF tile set model.
   *
   * @throws Will throw an error if the URL is invalid or the GeoTIFF cannot be created.
   */

  static async createFromURL(url: string, options: CreateGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModel> {
    const geoTiffFile = await fromUrl(url, {
      allowFullFile: true,
      headers: options.requestHeaders,
      credentials: options.credentials ? "same-origin" : "omit"
    });
    geoTiffFile.cache = true;
    const mostDetailedImage = await geoTiffFile.getImage(0);
    const geoKeys = mostDetailedImage.geoKeys;
    let bounds = null;
    if (!isLikelyCOG(mostDetailedImage, geoTiffFile)) {
      const error = new Error("Error creating Geotiff Model") as any;
      error.cause = "NOTCOG";
      throw error;
    }
    if (options.reference) {
      const reference = options.reference;
      if (reference.identifier === "CRS:1") {
        bounds = createPixelBound(mostDetailedImage);
      } else {
        const bbox = mostDetailedImage.getBoundingBox();
        bounds = createBounds(reference, [bbox[0], bbox[2] - bbox[0], bbox[1], bbox[3] - bbox[1]]);
      }
    } else {
      let reference;
      const epsgCode = getReferenceFromEPSGCode(geoKeys);
      try {
        reference = getReference(epsgCode);
        if (reference) {
          const bbox = mostDetailedImage.getBoundingBox();
          bounds = createBounds(reference, [bbox[0], bbox[2] - bbox[0], bbox[1], bbox[3] - bbox[1]]);
        }
      } catch (e) {
        const error = new Error("Error creating Geotiff Models") as any;
        error.cause = "UnknownIdentifier";
        error.identifier = epsgCode; // Add any extra parameter you need
        throw error;
      }
    }

    if (!bounds) {
      const error = new Error("Error creating Geotiff Models") as any;
      error.cause = "BoundsMissing";
      throw error;
    }

    const tileMatrix: TileMatrix[] = [];
    const images: GeoTIFFImage[] = [];
    const maskImages: GeoTIFFImage[] = [];
    const dataType = options.dataType ?  options.dataType : RasterDataType.IMAGE;
    const samplingMode = detectSamplingMode(mostDetailedImage);

    // Getting images and tile matrices
    const imageCount = await geoTiffFile.getImageCount();
    for (let level = imageCount - 1; level >= 0; level--) {
      let image = await geoTiffFile.getImage(level);
      const newSubfileType = image.getFileDirectory().NewSubfileType;
      const isMask = (newSubfileType & 0b100) !== 0;

      if (image.getTileWidth() === image.getWidth() && image.getTileHeight() === image.getHeight()) {
        image = new RetiledGeoTIFFImage(image);
      }

      const tileWidth = image.getTileWidth();
      const tileHeight = image.getTileHeight();
      const tileColumnCount = Math.ceil(image.getWidth() / tileWidth);
      const tileRowCount = Math.ceil(image.getHeight() / tileHeight);
      const boundsWidth = bounds.width * (tileColumnCount * tileWidth) / image.getWidth();
      const boundsHeight = bounds.height * (tileRowCount * tileHeight) / image.getHeight();
      let boundsLevel = createBounds(bounds.reference, [bounds.x, boundsWidth, bounds.y + bounds.height - boundsHeight, boundsHeight]);
      if (boundsEqual(boundsLevel, bounds, 1e-6)) {
        boundsLevel = bounds;
      }
      if (isMask) {
        maskImages.push(image);
      } else {
        tileMatrix.push({bounds: boundsLevel, tileWidth, tileHeight, tileColumnCount, tileRowCount});
        images.push(image);
      }
    }

    const modelOptions: GeoTiffTileSetModelOptions = {
      // Access Logic
      requestHeaders: options.requestHeaders,
      requestParameters: options.requestParameters,
      credentials: options.credentials,
      // Algorithm Logic
      structure: {tileMatrix, bounds, reference: bounds.reference!},
      dataType,
      samplingMode,
      images,
      maskImages,
      nodata: options.nodata,
      gradient: options.gradient,
      bandMapping: options.bandMapping,
    };
    return new GeoTiffTileSetModel(modelOptions);
  }
}


function boundsEqual(bounds1: Bounds, bounds2: Bounds, eps: number): boolean {
  return Math.abs(bounds1.x - bounds2.x) < eps &&
         Math.abs(bounds1.width - bounds2.width) < eps &&
         Math.abs(bounds1.y - bounds2.y) < eps &&
         Math.abs(bounds1.height - bounds2.height) < eps;
}

function getReferenceFromEPSGCode(geoKeys: any) {
  if (!geoKeys) {
    return null;
  }
    const projectedKey = geoKeys.ProjectedCSTypeGeoKey;
    const geographicKey = geoKeys.GeographicTypeGeoKey;

    // Choose the appropriate key, prioritizing the projected key
    const selectedGeoKey = projectedKey || geographicKey;
    return `EPSG:${selectedGeoKey}`;
}


function createPixelBound(image : GeoTIFFImage) {
  return createBounds(getReference("CRS:1"), [0, image.getWidth(), 0, image.getHeight()]);
}


/**
 * Returns whether the given value is a number
 */
function isNumber(value: any, canBeNaN: boolean = true): value is number {
  return typeof value === "number" && (canBeNaN || !isNaN(value));
}


function equals(a: number, b: number): boolean {
  return a === b || (isNaN(a) && isNaN(b));
}

function isPalette(image: GeoTIFFImage): boolean {
  return image.getFileDirectory().PhotometricInterpretation === 3;
}
