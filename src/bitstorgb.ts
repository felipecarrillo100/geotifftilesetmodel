import {GrayScaleTransformation, type RGBTransformation} from "./gradients.js";
import {equalsOrBothNaN, type NumericArray} from "./utils.js";

/**
 * Downscales 16-bit samples to 8-bit samples (keeps the high byte).
 */
export function downscale16to8bits(input: Uint16Array): Uint8Array {
    const output = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] >> 8;
    }
    return output;
}

/** Options of {@link convertSingleBandTo8BitRGB}. */
export interface ConvertTo8BitRGBOptions {
    bits: number;
    /** Normalizes a raw value to 0..1. Defaults to the `nativeRange` mapping. */
    convert?: (x: number) => number;
    samplesPerPixel?: number;
    transformation?: RGBTransformation;
    /** Raw value rendered transparent. When `null`/`undefined` the output has no alpha channel (RGB). */
    nodata?: number | null;
    nativeRange?: { min: number; max: number };
}

function hasNodata(nodata: number | null | undefined): nodata is number {
    return typeof nodata === "number";
}

/**
 * Converts single-band data (8, 16 or 32-bit integers) to colors: values are normalized over `nativeRange`
 * (default: the full range of `bits`) and colored with `transformation` (default: grayscale).
 *
 * @returns RGB pixels (3 bytes each), or RGBA (4 bytes, nodata transparent) when `nodata` is a number
 *
 * @example
 * convertSingleBandTo8BitRGB(new Uint16Array([0, 32768, 65535]), {bits: 16, nativeRange: {min: 0, max: 65535}});
 * // Uint8Array [0, 0, 0, 128, 128, 128, 255, 255, 255] (approximately)
 */
export function convertSingleBandTo8BitRGB(raw: NumericArray, options: ConvertTo8BitRGBOptions): Uint8Array {
    const range = options.nativeRange ?? {min: 0, max: Math.pow(2, options.bits) - 1};
    const convert = (x: number) => (x - range.min) / (range.max - range.min);
    return convertTo8BitRGB(raw, {...options, convert});
}

/**
 * Colors single-band data with `options.convert` (to 0..1) and `options.transformation`.
 * Returns RGBA (nodata transparent) when `options.nodata` is a number, RGB otherwise.
 */
export function convertTo8BitRGB(oldRaw: NumericArray, options: ConvertTo8BitRGBOptions): Uint8Array {
    const withAlpha = hasNodata(options.nodata);
    const bands = withAlpha ? 4 : 3;
    const convert = options.convert ?? ((x: number) => x);
    const transformation = options.transformation ?? GrayScaleTransformation;
    const newRaw = new Uint8Array(oldRaw.length * bands);
    for (let index = 0; index < oldRaw.length; index++) {
        const value = oldRaw[index];
        const rgb = transformation(convert(value));
        const o = bands * index;
        newRaw[o] = rgb[0];
        newRaw[o + 1] = rgb[1];
        newRaw[o + 2] = rgb[2];
        if (withAlpha) {
            newRaw[o + 3] = equalsOrBothNaN(value, options.nodata as number) ? 0 : 255;
        }
    }
    return newRaw;
}

/**
 * Converts 32-bit float samples to 8-bit colors, handling 1, 3 or 4 samples per pixel and nodata (NaN aware).
 *
 * - 1 sample: the value is normalized over `nativeRange` (default 0..1) and colored with `transformation`
 *   (default grayscale). Output is RGBA when `nodata` is a number, RGB otherwise.
 * - 3 or 4 samples: values are taken as 0..1 color components.
 */
export function convert32FloatTo8BitRGB(
    raw: Float32Array | Float64Array,
    samplesPerPixel: number,
    nodata: number | null | undefined,
    transformation?: RGBTransformation,
    nativeRange: { min: number; max: number } = {min: 0, max: 1},
): Uint8Array {
    const nodataPresent = hasNodata(nodata);
    const isNoData = (v: number) => nodataPresent && equalsOrBothNaN(v, nodata as number);
    const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

    if (samplesPerPixel === 1) {
        const channels = nodataPresent ? 4 : 3;
        const out = new Uint8Array(channels * raw.length);
        const span = nativeRange.max - nativeRange.min || 1;
        const color = transformation ?? GrayScaleTransformation;
        for (let index = 0; index < raw.length; index++) {
            const v = raw[index];
            const o = index * channels;
            if (isNoData(v) || Number.isNaN(v)) {
                // Transparent when there is an alpha channel, black otherwise.
                out[o] = out[o + 1] = out[o + 2] = 0;
                if (nodataPresent) out[o + 3] = 0;
                continue;
            }
            const [r, g, b] = color((v - nativeRange.min) / span);
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            if (nodataPresent) out[o + 3] = 255;
        }
        return out;
    }

    const channels = samplesPerPixel === 3 && nodataPresent ? 4 : samplesPerPixel;
    const pixels = raw.length / samplesPerPixel;
    const out = new Uint8Array(pixels * channels);
    for (let index = 0; index < pixels; index++) {
        const i = index * samplesPerPixel;
        const anyNoData = isNoData(raw[i]) || isNoData(raw[i + 1]) || isNoData(raw[i + 2]);
        const o = index * channels;
        out[o] = anyNoData ? 0 : toByte(raw[i]);
        out[o + 1] = anyNoData ? 0 : toByte(raw[i + 1]);
        out[o + 2] = anyNoData ? 0 : toByte(raw[i + 2]);
        if (samplesPerPixel === 3 && nodataPresent) {
            out[o + 3] = anyNoData ? 0 : 255;
        } else if (samplesPerPixel === 4) {
            out[o + 3] = anyNoData || isNoData(raw[i + 3]) ? 0 : toByte(raw[i + 3]);
        }
    }
    return out;
}
