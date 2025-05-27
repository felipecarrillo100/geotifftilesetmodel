import {
  RasterTileSetModel,
  type RasterTileSetModelConstructorOptions,
  type TileMatrix
} from "@luciad/ria/model/tileset/RasterTileSetModel.js";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {GeoTIFF, ReadRasterResult, TypedArray} from "geotiff";
import {fromUrl, GeoTIFFImage, Pool} from "geotiff";
import {getReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
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
import {
  detectPixelFormat,
  detectSamplingMode,
  getPixelFormatMeaning,
  isLikelyCOG,
  normalizeRawTypedArray
} from "./utils";
import {PixelMeaningEnum} from "./interfaces";
import {convert16To8BitRGB, convert32FloatTo8BitRGB, convert8To8BitRGB } from "./bitstorgb";

const pool = new Pool();

export interface CreateGeotiffFromUrlOptions {
  // For access
  credentials?: boolean;
  requestHeaders?: null | HttpRequestHeaders;
  requestParameters?: null | HttpRequestParameters;
  // For processing
  dataType?: RasterDataType;
  reference?: CoordinateReference;
  nodata?: number;
  format?: PixelFormat;
  bounds?: Bounds;
  bands?: number[];
  transformation?: (x: number) => [number, number, number];
}


function convertRGBToRGBA(raw: Uint8Array): Uint8Array {
  const newRaw = new Uint8Array(raw.length * 4 / 3);
  for (let index = 0; index < raw.length / 3; index++) {
    newRaw[index * 4] = raw[index * 3];
    newRaw[index * 4 + 1] = raw[index * 3 + 1];
    newRaw[index * 4 + 2] = raw[index * 3 + 2];
    newRaw[index * 4 + 3] = 255;
  }
  return newRaw;
}



function stripPixelsNoData(raw: Uint8Array, nodata: number, colorMap: Uint16Array | null) {
  // If palette image, first convert index to color.
  const nodataColor = colorMap ? [colorMap[nodata] >> 8, colorMap[256 + nodata] >> 8, colorMap[512 + nodata] >> 8] : [nodata, nodata, nodata];
  const equalsNodata = (r: number, g: number, b: number) => [equals(r, nodataColor[0]), equals(g, nodataColor[1]), equals(b, nodataColor[2])];
  // If palette image, the color should match exactly.  Otherwise, any band match results in transparent.
  const evaluate = colorMap ? (r: number, g: number, b: number) => equalsNodata(r, g, b).reduce((a, b) => a && b, true) :
                              (r: number, g: number, b: number) => equalsNodata(r, g, b).reduce((a, b) => a || b, false);

  for (let index = 0; index < raw.length / 4; index++) {
    const invalid = evaluate(raw[index * 4], raw[index * 4 + 1], raw[index * 4 + 2]);
    if (invalid) {
      raw.fill(0, index * 4, index * 4 + 4);
    }
  }
}

interface StripResult {
  data: Uint8Array;
  pixelFormat: PixelFormat;
}

function stripPixelsByMask(data: Uint8Array, rawMaskResult: ReadRasterResult | null, pixelFormat: PixelFormat): StripResult {
  if (!rawMaskResult) {
    return {data, pixelFormat};
  }
  const rawMask = (Array.isArray(rawMaskResult) ? rawMaskResult[0] : rawMaskResult) as Uint8Array;

  if (pixelFormat === PixelFormat.RGB_888) {
    data = convertRGBToRGBA(data);
    pixelFormat = PixelFormat.RGBA_8888;
  }
  const channels = 4;
  for (let index = 0; index < rawMask.length; index++) {
    if (rawMask[index] === 0) {
      data.fill(0, index * channels, index * channels + channels);
    }
  }
  return {data, pixelFormat};
}

function isPalette(image: GeoTIFFImage) {
  return hasPhotometricInterpretation(image, 3);
}
function isRGB(image: GeoTIFFImage) {
  return hasPhotometricInterpretation(image, 2);
}

function hasPhotometricInterpretation(image: GeoTIFFImage, photometricInterpretation: number) {
  return image.getFileDirectory().PhotometricInterpretation === photometricInterpretation;
}


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
  transformation?: (x: number) => [number, number, number];
}

export interface GeoTiffTileSetModelInfo {
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
  bytesPerPixel: number;
  bitsPerSample: number | number[];
  bands: number;
  isTiled: boolean;
  pixelMeaning: PixelMeaningEnum;
  pixelFormat: PixelFormat;
  isCog: boolean;
  projection: string;
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


  constructor(options: GeoTiffTileSetModelOptions) {
    super(options);
    const {images, maskImages} = options;
    const {format, nodata, bands, transformation} = options;
    this._images = images;
    this._maskImages = maskImages;
    this._pixelFormat = format ? format : detectPixelFormat(images[0]);
    this._pixelFormatMeaning = getPixelFormatMeaning(images[0]);
    this._nodata = nodata;
    this._bands = bands ;
    this._transformation = transformation;
    this.modelDescriptor = {
      name: "GeoTiffTileSetModel",
      description: "The GeoTiffTileSetModel is a specialized data structure designed to handle and represent geospatial data in the form of GeoTIFF tiles",
      source: "Open Geospatial Consortium (OGC) "
    } as ModelDescriptor;
    this._bandsNumber =  images[0].getSamplesPerPixel();
  }

  public static getInfo(tile0: GeoTIFFImage, tiff: GeoTIFF): GeoTiffTileSetModelInfo {

    const bytesPerPixel = tile0.getBytesPerPixel();
    const bitsPerSample = tile0.getBitsPerSample();
    const bands = tile0.getSamplesPerPixel();
    const pixelMeaning = getPixelFormatMeaning(tile0);
    const pixelFormat = detectPixelFormat(tile0);

    const tileWidth = tile0.getTileWidth();
    const tileHeight = tile0.getTileHeight();
    const width =  tile0.getWidth();
    const height = tile0.getHeight();
    const isTiled = tile0.isTiled;

    const isCog= isLikelyCOG(tile0, tiff);
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
      pixelMeaning,
      pixelFormat,
      isCog,
      projection: crsName,
      samplingMode
    };
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
    const nodata = this._nodata ?? image.getGDALNoData();
    const hasBands = Array.isArray(this._bands) && this._bands.length > 0;

    if (this._bandsNumber === 1) {
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
        if (this._pixelFormatMeaning === PixelMeaningEnum.Grayscale8) {
          data = convert8To8BitRGB(raw as Uint8Array, bands.length, this._transformation); //  Takes care of bit conversion and 1 band to 3 bands conversion.
        } else
        if (image.getBitsPerSample() == 32) {
          data = convert32FloatTo8BitRGB(raw as Float32Array, bands.length, nodata, this._transformation); // Takes care of bit conversion, 1 band to 3 bands conversion and the no data value.
        } else {
          if (image.getBitsPerSample() == 16) {
            data = convert16To8BitRGB(raw as Uint16Array, bands.length, this._transformation); //  Takes care of bit conversion and 1 band to 3 bands conversion.
          } else {
            data = convert8To8BitRGB(raw as Uint8Array, bands.length, this._transformation); // Takes care of the 1 band to 3 bands conversion.
          }
          if ((bands.length === 1 || bands.length === 3) && isNumber(nodata)) {
            data = convertRGBToRGBA(data);
          }
          // if (isNumber(nodata)) {
          //   stripPixelsNoData(data, nodata, null);
          // }
        }

        const stripResult = this.stripPixels(data, pixelFormat, rawMask, {...tile, y: tileY},
            tileOffsetX, tileOffsetY, tileWidth, tileHeight,
            imageWidth, imageHeight, flipY);
        data = stripResult.data;
        pixelFormat = stripResult.pixelFormat;

        onSuccess(tile, {data: data.buffer, pixelFormat, width: tileWidth, height: tileHeight});
      }).catch(error => {
        console.log("NO", error);
        onError(tile, error)
      });

    } else if (this.dataType === RasterDataType.ELEVATION ) {
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
    } else {
      const pixelFormat_ = this._pixelFormat;
      const rgbPromise = image.readRGB({window, pool, enableAlpha: pixelFormat_ === PixelFormat.RGBA_8888, signal: signal!});
      const maskPromise = maskImage ? maskImage.readRasters({window, pool, signal: signal!}) : Promise.resolve(null);
      Promise.all([rgbPromise, maskPromise]).then(raws => {
        const raw = raws[0];
        const rawMask = raws[1];
        let pixelFormat = pixelFormat_;
        let data = (image.getBitsPerSample() == 16) ? convert16To8BitRGB(raw as Uint16Array) : raw as Uint8Array;

        const stripResult = this.stripPixels(data, pixelFormat, rawMask, {...tile, y: tileY},
            tileOffsetX, tileOffsetY, tileWidth, tileHeight,
            imageWidth, imageHeight, flipY);
        data = stripResult.data;
        pixelFormat = stripResult.pixelFormat;

        if (isNumber(nodata)) {
          data = (pixelFormat === PixelFormat.RGB_888) ? convertRGBToRGBA(data) : data;
          pixelFormat = PixelFormat.RGBA_8888;
          stripPixelsNoData(data, nodata, isPalette(image) ? image.getFileDirectory().ColorMap : null);
        }
        onSuccess(tile, {data: data.buffer, pixelFormat, width: tileWidth, height: tileHeight});
      }).catch(error => {
        console.log("NO", error);
        onError(tile, error)
      });
    }
  }
  // @ts:ignore
  getImage(_tile: TileCoordinate, _onSuccess: (tile: TileCoordinate, image: HTMLImageElement) => void, _onError: (tile: TileCoordinate, error?: any) => void,
           _signal: AbortSignal | null): void {
    throw "Unused";
  }

  private stripPixels(data: Uint8Array, pixelFormat: PixelFormat, rawMask: ReadRasterResult | null,
                      tile: TileCoordinate, tileOffsetX: number, tileOffsetY: number,
                      tileWidth: number, tileHeight: number, imageWidth: number, imageHeight: number,
                      flipY: boolean): StripResult {
    const maskStripResult = stripPixelsByMask(data, rawMask, pixelFormat);
    data = maskStripResult.data;
    pixelFormat = maskStripResult.pixelFormat;

    return this.stripPixelsOutsideImageArea(
        data, pixelFormat, tile,
        tileOffsetX, tileOffsetY, tileWidth, tileHeight,
        imageWidth, imageHeight, flipY);
  }

  private stripPixelsOutsideImageArea(data: Uint8Array, pixelFormat: PixelFormat,
                                      tile: TileCoordinate, tileOffsetX: number, tileOffsetY: number,
                                      tileWidth: number, tileHeight: number, imageWidth: number, imageHeight: number,
                                      flipY: boolean): StripResult {
    if (tile.x === (this.getTileColumnCount(tile.level)! - 1) || (tile.y === (this.getTileRowCount(tile.level)! - 1))) {
      if (pixelFormat === PixelFormat.RGB_888) {
        data = convertRGBToRGBA(data);
        pixelFormat = PixelFormat.RGBA_8888;
      }

      for (let py = 0; py < tileHeight; py++) {
        for (let px = 0; px < tileWidth; px++) {
          const index = (py * tileWidth) + px;
          const invalid = ((tileOffsetX + px) >= imageWidth) || (flipY ? ((tileOffsetY + py) < 0) : ((tileOffsetY + py) >= imageHeight));
          if (invalid) {
            data.fill(0, index * 4, index * 4 + 4);
          }
        }
      }
    }
    return {data, pixelFormat};
  }

  static async infoFromURL(url: string, options: CreateGeotiffFromUrlOptions = {}): Promise<GeoTiffTileSetModelInfo> {
    const geoTiffFile = await fromUrl(url, {
      allowFullFile: true,
      headers: options.requestHeaders,
      credentials: options.credentials ? "same-origin" : "omit"
    });
    geoTiffFile.cache = true;
    const mostDetailedImage = await geoTiffFile.getImage(0);
    return GeoTiffTileSetModel.getInfo(mostDetailedImage, geoTiffFile)
  }


  /**
   * Creates a RasterTileSetModel for the given URL.
   *
   * <b>Geo-reference & bounds</b>
   *
   * In order, this happens:
   * <ul>
   *   <li>options.bounds is used</li>
   *   <li>options.reference is used, bounds from the image bbox or pixel resolution in case of CRS:1 reference</li>
   *   <li>EPSG code from image geoKeys is used, bounds from image bbox</li>
   *   <li>Reference from a .prj file, located next to the geotiff, is used, bounds from image bbox</li>
   *   <li>CRS:1 is assumed, bounds are just pixel resolution</li>
   * </ul>
   *
   * <b>Pixel formats and "no data"</b>
   *
   * 32-bit and 16-bit imagery values are converted to 8-bit.
   * Palette images are converted to RGB.
   *
   * No-data values are converted to fully transparent pixels.
   *
   * <b>Bands</b>
   *
   * If you provide the band(s) to select, the data will be treated as imagery.
   * You can use this for example to select the bands in a multispectral image to be treated as RGB(A) or
   * visualize a single band as a grayscale image.  You can specify a color transformation function to apply when selecting a single band.
   *
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
      error.bands = options.bands; // Add any extra parameter you need
      throw error;
    }
    if (options.bounds) {
      bounds = options.bounds;
    } else if (options.reference) {
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
         reference = getReference(epsgCode)
      } catch (e) {
        const error = new Error("Error creating Geotiff Models") as any;
        error.cause = "UnknownIdentifier";
        error.identifier = epsgCode; // Add any extra parameter you need
        throw error;
      }
      if (reference) {
        const bbox = mostDetailedImage.getBoundingBox();
        bounds = createBounds(reference, [bbox[0], bbox[2] - bbox[0], bbox[1], bbox[3] - bbox[1]]);
      } else {
        reference = await getReferenceFromPrjFile(url, {requestHeaders: options.requestHeaders, credentials: options.credentials});
        if (reference) {
          const bbox = mostDetailedImage.getBoundingBox();
          bounds = createBounds(reference, [bbox[0], bbox[2] - bbox[0], bbox[1], bbox[3] - bbox[1]]);
        } else {
          console.warn("Could not deduce the coordinate reference of " + url + ". Will use a pixel reference.");
          bounds = createPixelBound(mostDetailedImage);
        }
      }
    }

    const tileMatrix: TileMatrix[] = [];
    const images: GeoTIFFImage[] = [];
    const maskImages: GeoTIFFImage[] = [];
    const dataType = options.dataType ?  options.dataType : RasterDataType.IMAGE;
    const samplingMode = detectSamplingMode(mostDetailedImage);

    // Float conversion to 8 bit RGB via readRGB tends to not work out as expected.  So do a band selection instead.
    const bitsPerSample = mostDetailedImage.getBitsPerSample();
    if (dataType === RasterDataType.IMAGE && bitsPerSample === 32 && isUndefined(options.bands)) {
      const samplesPerPixel = mostDetailedImage.getSamplesPerPixel();
      options.bands = samplesPerPixel >= 3 ? [0, 1, 2] : [0];
    }

    const imageCount = await geoTiffFile.getImageCount();
    for (let level = imageCount - 1; level >= 0; level--) {
      let image = await geoTiffFile.getImage(level);
      const newSubfileType = image.getFileDirectory().NewSubfileType;
      const maskImage = isDefined(newSubfileType) && (newSubfileType & (1 << 2)) !== 0; // Bit 2 indicates mask.
      if (image.getTileWidth() === image.getWidth()) {
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
      if (maskImage) {
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
      format: options.format,
      nodata: options.nodata,
      bands: options.bands,
      transformation: options.transformation
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

async function getReferenceFromPrjFile(url: string, options: {
  requestHeaders: HttpRequestHeaders | null | undefined;
  credentials: boolean | undefined
}) {
  try {
    const prjPath = url.slice(0, url.lastIndexOf(".") + 1) + "prj";
    const prj = await getFileContent(prjPath, options);
    return parseWellKnownText(prj);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    return null;
  }
}

async function getFileContent(url: string, options:{ headers?: HttpRequestHeaders, credentials?: boolean}): Promise<string> {
  const x = await fetch(url, {
    headers: options.headers,
    credentials: options.credentials ? "same-origin" : "omit",
  });
  return await x.text();
}

function createPixelBound(image : GeoTIFFImage) {
  return createBounds(getReference("CRS:1"), [0, image.getWidth(), 0, image.getHeight()]);
}



//// Remove external dependencies

/**
 * Returns whether the given value is undefined
 */
function isUndefined(value: any): value is undefined {
  return typeof value === "undefined";
}

/**
 * Returns whether the given value is defined, or null if specified
 */
function isDefined(value: any, canBeNull: boolean = false) {
  return !isUndefined(value) && (canBeNull || value !== null);
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
