import type {GeoTIFFImage} from "geotiff";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode.js";
import {PixelMeaningEnum} from "./interfaces.js";
import {geoKeysOf, photometricOf, tag} from "./tiff.js";

/** TIFF SampleFormat values. */
const SAMPLE_FORMAT_UINT = 1;
const SAMPLE_FORMAT_INT = 2;
const SAMPLE_FORMAT_FLOAT = 3;

/** TIFF PhotometricInterpretation values. */
const PHOTOMETRIC_RGB = 2;
const PHOTOMETRIC_CMYK = 5;
const PHOTOMETRIC_YCBCR = 6;
const PHOTOMETRIC_CIELAB = 8;

/** Color models that are not stored as RGB but that geotiff.js' readRGB converts to RGB. */
export function isConvertedToRGB(photometric: number | undefined): boolean {
    return photometric === PHOTOMETRIC_YCBCR || photometric === PHOTOMETRIC_CIELAB || photometric === PHOTOMETRIC_CMYK;
}

/** Numeric typed arrays as returned by geotiff.js' readRasters. */
export type NumericArray =
    | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array
    | Int32Array | Uint32Array | Float32Array | Float64Array;

function firstValue(value: unknown, fallback: number): number {
    if (typeof value === "number") return value;
    // Arrays, or typed arrays (geotiff.js 3.x returns tag arrays as typed arrays).
    const list = value as ArrayLike<unknown> | null | undefined;
    if (list && typeof list.length === "number" && list.length > 0) return Number(list[0]);
    return fallback;
}

/** Bits per sample of the first band. */
export function bitsPerSampleOf(image: GeoTIFFImage): number {
    return firstValue(image.getBitsPerSample(0), 8);
}

/** TIFF SampleFormat of the first band (1 = unsigned int, 2 = signed int, 3 = float). */
export function sampleFormatOf(image: GeoTIFFImage): number {
    try {
        return firstValue(image.getSampleFormat(0), SAMPLE_FORMAT_UINT);
    } catch {
        return firstValue(tag(image, "SampleFormat"), SAMPLE_FORMAT_UINT);
    }
}

/** Whether the bands hold plain numbers that can represent elevation (any integer or float type). */
export function canRepresentElevation(image: GeoTIFFImage): boolean {
    const format = sampleFormatOf(image);
    const bits = bitsPerSampleOf(image);
    const photometric = photometricOf(image);
    if (photometric === 3 || isConvertedToRGB(photometric)) return false; // colour indices / colour models
    return (format === SAMPLE_FORMAT_FLOAT && (bits === 32 || bits === 64))
        || ((format === SAMPLE_FORMAT_INT || format === SAMPLE_FORMAT_UINT) && (bits === 8 || bits === 16 || bits === 32));
}

/**
 * Determines what the pixels of an image mean and which LuciadRIA pixel format matches them natively.
 */
export function analyzePixelFormat(image: GeoTIFFImage): { meaning: PixelMeaningEnum; format: PixelFormat | null } {
    const samplesPerPixel = image.getSamplesPerPixel();
    const bytesPerPixel = image.getBytesPerPixel();
    const photometric = photometricOf(image);
    const isRGB = photometric === PHOTOMETRIC_RGB;
    const bits = bitsPerSampleOf(image);

    let meaning: PixelMeaningEnum = PixelMeaningEnum.Unknown;
    if (bits === 8 && isConvertedToRGB(photometric)) {
        // YCbCr (typical for JPEG compressed orthophotos), CIELab, CMYK: geotiff.js' readRGB converts them.
        return {meaning: PixelMeaningEnum.RGB, format: PixelFormat.RGB_888};
    }
    if (samplesPerPixel === 1) {
        if (bits === 8 && bytesPerPixel === 1) meaning = PixelMeaningEnum.Grayscale8;
        else if (bits === 16 && bytesPerPixel === 2) meaning = PixelMeaningEnum.Grayscale16;
        else if (bits === 32 && bytesPerPixel === 4) meaning = PixelMeaningEnum.Grayscale32;
    } else if (samplesPerPixel === 3 && isRGB) {
        if (bits === 8 && bytesPerPixel === 3) meaning = PixelMeaningEnum.RGB;
        else if (bits === 32 && bytesPerPixel === 12) meaning = PixelMeaningEnum.RGB96;
    } else if (samplesPerPixel === 4 && isRGB) {
        if (bits === 8 && bytesPerPixel === 4) meaning = PixelMeaningEnum.RGBA;
    }
    if (samplesPerPixel > 1 && meaning === PixelMeaningEnum.Unknown) {
        meaning = PixelMeaningEnum.Multiband;
    }

    let format: PixelFormat | null = null;
    if (samplesPerPixel === 3 && bits === 8 && bytesPerPixel === 3) {
        format = PixelFormat.RGB_888;
    } else if (samplesPerPixel === 4 && bits === 8 && bytesPerPixel === 4) {
        format = PixelFormat.RGBA_8888;
    } else if (samplesPerPixel === 1) {
        if (bits === 16 && bytesPerPixel === 2) {
            format = PixelFormat.USHORT;
        } else if (bits === 32 && bytesPerPixel === 4) {
            format = sampleFormatOf(image) === SAMPLE_FORMAT_FLOAT ? PixelFormat.FLOAT_32 : PixelFormat.UINT_32;
        }
    }
    return {meaning, format};
}

/** Sampling mode declared by the file (`GTRasterTypeGeoKey`); AREA when absent or unreadable. */
export function detectSamplingMode(image: GeoTIFFImage): RasterSamplingMode {
    try {
        if (geoKeysOf(image).GTRasterTypeGeoKey === undefined) {
            return RasterSamplingMode.AREA;
        }
        return image.pixelIsArea() ? RasterSamplingMode.AREA : RasterSamplingMode.POINT;
    } catch {
        return RasterSamplingMode.AREA;
    }
}

/**
 * Coordinate reference identifier from the GeoTIFF keys (`"EPSG:<code>"`), or null when the file has no EPSG code
 * (no keys, or a user-defined CRS: code 32767).
 */
export function referenceIdentifierFromGeoKeys(geoKeys: Record<string, unknown> | null | undefined): string | null {
    if (!geoKeys) return null;
    const code = (geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey) as unknown;
    if (typeof code !== "number" || code <= 0 || code === 32767) return null;
    return `EPSG:${code}`;
}

/** Pads a raster that is shorter than expected (partial strips) with the nodata value. */
export function normalizeRawTypedArray<T extends NumericArray>(raw: T, expectedLength: number, nodata = 0): T {
    if (raw.length >= expectedLength) return raw;
    const Ctor = raw.constructor as new (length: number) => T;
    const normalized = new Ctor(expectedLength);
    (normalized as unknown as Float64Array).set(raw as unknown as Float64Array);
    (normalized as unknown as Float64Array).fill(nodata, raw.length);
    return normalized;
}

/** Equality that treats NaN as equal to NaN (nodata is often NaN in float rasters). */
export function equalsOrBothNaN(a: number, b: number): boolean {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

export function isNumber(value: unknown): value is number {
    return typeof value === "number";
}
