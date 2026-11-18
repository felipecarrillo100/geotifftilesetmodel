import {type ColorMap, createGradientColorMap} from "@luciad/ria/util/ColorMap.js";
import type {CogGradientColorMap} from "./interfaces.js";

/** Black to white in 16 steps: the default gradient for single-band data. */
export const GrayscaleGradient: CogGradientColorMap = [
    {level: 0, color: "#000000"},
    {level: 0.0667, color: "#111111"},
    {level: 0.1333, color: "#222222"},
    {level: 0.2, color: "#333333"},
    {level: 0.2667, color: "#444444"},
    {level: 0.3333, color: "#555555"},
    {level: 0.4, color: "#666666"},
    {level: 0.4667, color: "#777777"},
    {level: 0.5333, color: "#888888"},
    {level: 0.6, color: "#999999"},
    {level: 0.6667, color: "#AAAAAA"},
    {level: 0.7333, color: "#BBBBBB"},
    {level: 0.8, color: "#CCCCCC"},
    {level: 0.8667, color: "#DDDDDD"},
    {level: 0.9333, color: "#EEEEEE"},
    {level: 1, color: "#FFFFFF"},
];

/** Maps a value (normalized to 0..1 unless `range` is given) to an RGB triplet. */
export type RGBTransformation = (x: number) => [number, number, number];

/**
 * Creates a function that maps values to the colors of a LuciadRIA color map.
 * @param colorMap a LuciadRIA gradient color map
 * @param range when given, input values are first normalized from this range to 0..1 (and clamped)
 */
export function TransformToGradientColorMap(colorMap: ColorMap, range?: { min: number; max: number }): RGBTransformation {
    const adaptRange = range
        ? (x: number) => {
            const normalizedValue = (x - range.min) / (range.max - range.min);
            return normalizedValue < 0 ? 0 : (normalizedValue > 1 ? 0.999 : normalizedValue);
        }
        : (x: number) => x;
    return (n: number): [number, number, number] => {
        const colorString = colorMap.retrieveColor(adaptRange(n));
        const rgba = colorString.replace(/[^\d,.]/g, "").split(",").map(Number);
        return [rgba[0], rgba[1], rgba[2]];
    };
}

let grayScaleTransformation: RGBTransformation | undefined;

/** Grayscale transformation for values in 0..1 (created on first use). */
export const GrayScaleTransformation: RGBTransformation = (x: number) => {
    grayScaleTransformation ??= TransformToGradientColorMap(createGradientColorMap(GrayscaleGradient));
    return grayScaleTransformation(x);
};
