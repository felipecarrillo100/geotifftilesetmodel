import {GeoTIFF, GeoTIFFImage, TypedArray} from "geotiff";
import {PixelMeaningEnum} from "./interfaces";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode";

/**
 * Determines the meaning of a pixel format based on TIFF metadata.
 */
export function getPixelFormatMeaning(image: GeoTIFFImage): PixelMeaningEnum {
    const samplesPerPixel = image.getSamplesPerPixel();
    const bitsPerSample = image.getBitsPerSample();
    const bytesPerPixel = image.getBytesPerPixel();
    const isRGB = image.getFileDirectory().PhotometricInterpretation === 2;
    // Normalize bitsPerSample to a number
    const bits = Array.isArray(bitsPerSample)
        ? bitsPerSample[0] // assume uniform
        : bitsPerSample;

    // Common cases
    if (samplesPerPixel === 1) {
        if (bits === 8 && bytesPerPixel === 1) return PixelMeaningEnum.Grayscale8;
        if (bits === 16 && bytesPerPixel === 2) return PixelMeaningEnum.Grayscale16;
        if (bits === 32 && bytesPerPixel === 4) return PixelMeaningEnum.Grayscale32;
    }

    if (samplesPerPixel === 3 && isRGB) {
        if (bits === 8 && bytesPerPixel === 3) return PixelMeaningEnum.RGB;   // 8x3 = 24
        if (bits === 32 && bytesPerPixel === 12) return PixelMeaningEnum.RGB96; // 32x3 =96
    }

    if (samplesPerPixel === 4 && isRGB) {
        if (bits === 8 && bytesPerPixel === 4) return PixelMeaningEnum.RGBA;
    }

    if (samplesPerPixel > 1) {
        return PixelMeaningEnum.Multiband;
    }

    return PixelMeaningEnum.Unknown;
}


export function detectPixelFormat(image: GeoTIFFImage): PixelFormat {
    const samplesPerPixel = image.getSamplesPerPixel();
    const bitsPerSample = image.getBitsPerSample();
    const bytesPerPixel = image.getBytesPerPixel();

    // Normalize bitsPerSample to a single number (assuming uniform bits)
    const bits = Array.isArray(bitsPerSample) ? bitsPerSample[0] : bitsPerSample;

    if (samplesPerPixel === 3 && bits === 8 && bytesPerPixel === 3) {
        return PixelFormat.RGB_888;
    }

    if (samplesPerPixel === 4 && bits === 8 && bytesPerPixel === 4) {
        return PixelFormat.RGBA_8888;
    }

    if (samplesPerPixel === 1) {
        if (bits === 16 && bytesPerPixel === 2) {
            return PixelFormat.USHORT;
        }
        if (bits === 32 && bytesPerPixel === 4) {
            // Unsigned int 32 or float32? Check if float or int, assuming image has a method to tell this
            if (isFloat32Data(image)) {
                return PixelFormat.FLOAT_32;
            }
            return PixelFormat.UINT_32;
        }
    }

    // If none matched, throw or fallback as needed:
    return null;
}

function isFloat32Data(image: GeoTIFFImage): boolean {
    const fileDir = image.getFileDirectory();
    const sampleFormat = fileDir.SampleFormat ?? [1]; // Default is unsigned int
    const bitsPerSample = fileDir.BitsPerSample ?? [8]; // Default is 8 bits

    const isFloat = Array.isArray(sampleFormat)
        ? sampleFormat.every(fmt => fmt === 3)
        : sampleFormat === 3;

    const is32Bit = Array.isArray(bitsPerSample)
        ? bitsPerSample.every(bits => bits === 32)
        : bitsPerSample === 32;

    return isFloat && is32Bit;
}

export function isLikelyCOG(image:  GeoTIFFImage, tiff: GeoTIFF): boolean {
    const fileDirectory = image.fileDirectory;
    const isTiled = fileDirectory.TileWidth !== undefined && fileDirectory.TileLength !== undefined;
    // Check that the main IFD is near the start of the file (COG constraint)
    // @ts-ignore
    const mainIFDOffset = tiff.firstIFDOffset; // private property in geotiff.js
    const isIFDNearStart = typeof mainIFDOffset === 'number' && mainIFDOffset < 512;

    return isTiled && isIFDNearStart;
}

export function detectSamplingMode(image: GeoTIFFImage): RasterSamplingMode {
    try {
        if (typeof image.geoKeys.GTRasterTypeGeoKey === "undefined") {
            // Assume area.
            return RasterSamplingMode.AREA;
        }
        // pixelIsArea can fail for some datasets.
        return image.pixelIsArea() ? RasterSamplingMode.AREA : RasterSamplingMode.POINT;
    } catch (_) {
        return RasterSamplingMode.AREA;
    }
}

export function normalizeRawTypedArray(
    raw: any,
    expectedLength: number,
    nodata: number = 0
): any {
    if (raw.length >= expectedLength) return raw;

    // Dynamically create a new TypedArray of the same type
    const TypedArrayConstructor = Object.getPrototypeOf(raw).constructor as {
        new(length: number);
    };

    const normalized = new TypedArrayConstructor(expectedLength);
    normalized.set(raw);
    normalized.fill(nodata, raw.length); // Fill the rest with nodata

    return normalized;
}
