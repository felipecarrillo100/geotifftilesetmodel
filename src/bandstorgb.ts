import {GrayScaleTransformation, type RGBTransformation} from "./gradients.js";
import type {BandMapping, ResolvedBandMapping} from "./interfaces.js";
import {equalsOrBothNaN, type NumericArray} from "./utils.js";

export type {BandMapping} from "./interfaces.js";

/** Applies the defaults of {@link BandMapping} (accepts the deprecated `isRGB` alias of `rgb`). */
export function resolveBandMapping(bandMapping?: BandMapping | null): ResolvedBandMapping {
    return {
        gray: bandMapping?.gray ?? 0,
        red: bandMapping?.red ?? 0,
        green: bandMapping?.green ?? 0,
        blue: bandMapping?.blue ?? 0,
        rgb: bandMapping?.rgb ?? bandMapping?.isRGB ?? false,
    };
}

/** Options of {@link convertBandsTo8BitRGB}. */
export interface ConvertBandsTo8BitRGBOptions {
    bits: number;
    /** Number of interleaved bands in `raw`. */
    bands: number;
    bandMapping: BandMapping | ResolvedBandMapping;
    /** Raw value rendered transparent (`null`/`undefined`: none). */
    nodata?: number | null;
    /** Colors the gray band (values normalized to 0..1). Default grayscale. */
    transformation?: RGBTransformation;
    /** Range normalized to 0..1 for the gray band. Default: full range of `bits`. */
    nativeRange?: { min: number; max: number };
}

/**
 * Converts interleaved multiband data to RGBA (4 bytes per pixel; nodata is transparent).
 *
 * - `bandMapping.rgb === true`: the `red`, `green` and `blue` bands are scaled from `bits` to 8 bits.
 * - otherwise: the `gray` band is normalized over `nativeRange` and colored with `transformation`.
 */
export function convertBandsTo8BitRGB(raw: NumericArray, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    const mapping = resolveBandMapping(options.bandMapping);
    const nodata = options.nodata;
    const hasNodata = typeof nodata === "number";
    const isNoData = (v: number) => hasNodata && equalsOrBothNaN(v, nodata as number);
    const divider = options.bits === 16 ? 256 : options.bits === 32 ? 16777216 : 1;
    const range = options.nativeRange ?? {min: 0, max: Math.pow(2, options.bits) - 1};
    const span = range.max - range.min || 1;
    const transformation = options.transformation ?? GrayScaleTransformation;
    const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v / divider)));

    const pixels = Math.floor(raw.length / options.bands);
    const out = new Uint8Array(pixels * 4);
    for (let index = 0; index < pixels; index++) {
        const base = index * options.bands;
        const o = index * 4;
        if (mapping.rgb) {
            const r = raw[base + mapping.red], g = raw[base + mapping.green], b = raw[base + mapping.blue];
            out[o] = r === undefined ? 0 : toByte(r);
            out[o + 1] = g === undefined ? 0 : toByte(g);
            out[o + 2] = b === undefined ? 0 : toByte(b);
            // Transparent only when all three bands are nodata.
            out[o + 3] = isNoData(r) && isNoData(g) && isNoData(b) ? 0 : 255;
        } else {
            const gray = raw[base + mapping.gray];
            const [r, g, b] = transformation(gray === undefined ? 0 : (gray - range.min) / span);
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = isNoData(gray) ? 0 : 255;
        }
    }
    return out;
}
