import {GeoTIFF, GeoTIFFImage} from "geotiff";
import {PixelMeaningEnum} from "./interfaces";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode";

/**
 * Determines the meaning of a pixel format based on TIFF metadata.
 */
export function analyzePixelFormat(image: GeoTIFFImage) {
    const samplesPerPixel = image.getSamplesPerPixel();
    const bitsPerSample = image.getBitsPerSample();
    const bytesPerPixel = image.getBytesPerPixel();
    const fileDirectory = image.getFileDirectory();
    const isRGB = fileDirectory.PhotometricInterpretation === 2;

    // Normalize bitsPerSample to a single number (assuming uniform bits)
    const bits = Array.isArray(bitsPerSample) ? bitsPerSample[0] : bitsPerSample;

    let meaning: PixelMeaningEnum = PixelMeaningEnum.Unknown;
    let format: PixelFormat | null = null;

    // Determine pixel meaning
    if (samplesPerPixel === 1) {
        if (bits === 8 && bytesPerPixel === 1) meaning = PixelMeaningEnum.Grayscale8;
        else if (bits === 16 && bytesPerPixel === 2) meaning = PixelMeaningEnum.Grayscale16;
        else if (bits === 32 && bytesPerPixel === 4) meaning = PixelMeaningEnum.Grayscale32;
    }

    if (samplesPerPixel === 3 && isRGB) {
        if (bits === 8 && bytesPerPixel === 3) meaning = PixelMeaningEnum.RGB;
        else if (bits === 32 && bytesPerPixel === 12) meaning = PixelMeaningEnum.RGB96;
    }

    if (samplesPerPixel === 4 && isRGB) {
        if (bits === 8 && bytesPerPixel === 4) meaning = PixelMeaningEnum.RGBA;
    }

    if (samplesPerPixel > 1 && meaning === PixelMeaningEnum.Unknown) {
        meaning = PixelMeaningEnum.Multiband;
    }

    // Determine pixel format
    if (samplesPerPixel === 3 && bits === 8 && bytesPerPixel === 3) {
        format = PixelFormat.RGB_888;
    } else if (samplesPerPixel === 4 && bits === 8 && bytesPerPixel === 4) {
        format = PixelFormat.RGBA_8888;
    } else if (samplesPerPixel === 1) {
        if (bits === 16 && bytesPerPixel === 2) {
            format = PixelFormat.USHORT;
        } else if (bits === 32 && bytesPerPixel === 4) {
            // Unsigned int 32 or float32? Check if float or int, assuming image has a method to tell this
            if (isFloat32Data(fileDirectory)) {
                format = PixelFormat.FLOAT_32;
            } else {
                format = PixelFormat.UINT_32;
            }
        }
    }

    return { meaning, format };
}

function isFloat32Data(fileDir: any): boolean {
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
