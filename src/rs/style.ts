/**
 * A JSON-serialisable style for multispectral, index, classification and time-series rasters.
 *
 * The vocabulary follows what users know from other tools: band combinations and min/max/gamma as in Google Earth
 * Engine visParams, `expression` and `rescale` as in TiTiler, stretch types (percent clip, standard deviation, min/max)
 * as in ArcGIS and QGIS, and colour map entries (quantity / color / opacity / label, type ramp / intervals / values) as
 * in SLD and GeoServer.
 *
 * ```json
 * { "render": { "type": "rgb", "red": "nir", "green": "red", "blue": "green",
 *               "stretch": { "type": "percentile", "low": 2, "high": 98 }, "gamma": 1.2 },
 *   "mask": [{ "band": "scl", "values": [0, 1, 3, 8, 9, 10] }] }
 *
 * { "render": { "type": "pseudocolor", "expression": "(nir - red) / (nir + red)",
 *               "stretch": [-0.2, 0.9], "colorMap": { "stops": [
 *                 { "position": 0, "color": "#a50026" }, { "position": 1, "color": "#006837" }] } } }
 * ```
 *
 * @module
 */
import {RiaGeoTiffError} from "../errors.js";
import type {ColorMapSpec} from "./colormaps.js";
import type {ColorFunction} from "./render.js";
import type {ExpressionArray} from "./expression.js";
import type {StretchSpec} from "./stats.js";

/**
 * One value per pixel: a band name (`"nir"`, `"b4"`), or an object with a band or an expression and an optional
 * stretch that overrides the render's.
 *
 * A bare string that is an identifier (`[A-Za-z_][A-Za-z0-9_]*`) is a band name; any other string is an expression
 * in the string grammar of {@link parseExpression} (or, when it starts with `[`, a JSON-array expression, see
 * {@link toExpressionNode}). In the object form, `band` wins when both `band` and `expression` are given; one of the
 * two is required.
 *
 * Band names must be among the band names given to {@link compileStyle}, otherwise compiling throws
 * {@link StyleError}.
 *
 * @example
 * ```json
 * "nir"
 * "(nir - red) / (nir + red)"
 * { "band": "swir16", "stretch": [0, 0.4], "gamma": 1.4 }
 * { "expression": ["/", ["band", "nir"], ["band", "red"]], "stretch": { "type": "minmax" } }
 * ```
 *
 * @category Styles
 */
export type ChannelSpec =
    | string
    | {
        /** Band name. Takes precedence over `expression` when both are set. */
        band?: string;
        /** Band-math expression: a string (see {@link parseExpression}) or a JSON array (see {@link ExpressionArray}). */
        expression?: string | ExpressionArray;
        /** Stretch of this channel; overrides the render's `stretch`. */
        stretch?: StretchSpec;
        /**
         * Gamma of this channel (> 1 brightens mid-tones); overrides the render's `gamma`. Used by RGB renders only:
         * pseudocolour renders use their own `gamma`, custom renders none.
         */
        gamma?: number;
    };

/**
 * Three channels mapped to red, green and blue, each stretched to 0..1, then gamma-corrected.
 *
 * Pixels where any of the three channels is NaN (missing data), or that a mask rule hides, are transparent; all
 * others are opaque.
 *
 * @example
 * ```json
 * { "type": "rgb", "red": "nir", "green": "red", "blue": "green",
 *   "stretch": { "type": "percentile", "low": 2, "high": 98 }, "gamma": 1.2, "saturation": 1.1 }
 * ```
 *
 * @category Styles
 */
export interface RgbRender {
    /** Discriminator: an RGB composite. */
    type: "rgb";
    /** Channel drawn in red. */
    red: ChannelSpec;
    /** Channel drawn in green. */
    green: ChannelSpec;
    /** Channel drawn in blue. */
    blue: ChannelSpec;
    /** Default stretch of the three channels (a channel's own `stretch` overrides it). Default: 2–98 % percentile clip. */
    stretch?: StretchSpec;
    /**
     * Gamma (> 1 brightens mid-tones), applied after the stretch as `t^(1/gamma)`; a channel's own `gamma` overrides
     * it. Default 1. Values ≤ 0 are treated as 1.
     */
    gamma?: number;
    /**
     * Saturation multiplier (1 = unchanged, 0 = greyscale, > 1 more vivid). Each colour is moved away from (or
     * towards) its luminance `0.299 R + 0.587 G + 0.114 B`, then clamped to 0..255. Default 1.
     */
    saturation?: number;
}

/**
 * A single value per pixel (a band or an expression) through a colour map: a ramp laid over the stretch range, a
 * class table matched on exact values, or (not serialisable) a function.
 *
 * Exactly one of `band` and `expression` is needed (`band` wins when both are set). Pixels whose value is NaN, or that
 * a mask rule hides, are transparent.
 *
 * With a ramp or a function, the value is stretched to 0..1, gamma-corrected, and looked up in a table of
 * 1024 colours. With a class table, the value is matched exactly (as a 32-bit float) against the table's entries.
 *
 * @example
 * ```json
 * { "type": "pseudocolor", "expression": "(nir - red) / (nir + red)", "stretch": [-0.2, 0.9],
 *   "colorMap": { "version": 1, "spacing": "equal", "blend": "smooth",
 *                 "stops": [{ "position": 0, "color": "#a50026" }, { "position": 0.5, "color": "#ffffbf" },
 *                           { "position": 1, "color": "#006837" }] } }
 *
 * { "type": "pseudocolor", "band": "scl",
 *   "colorMap": { "type": "table", "entries": [{ "value": 4, "color": "#00a000", "label": "Vegetation" },
 *                                             { "value": 6, "color": "#0000ff", "label": "Water" }] } }
 * ```
 *
 * @category Styles
 */
export interface PseudocolorRender {
    /** Discriminator: a single value through a colour map. */
    type: "pseudocolor";
    /** Band name. Takes precedence over `expression`. */
    band?: string;
    /** Band-math expression: a string (see {@link parseExpression}) or a JSON array (see {@link ExpressionArray}). */
    expression?: string | ExpressionArray;
    /** Range of data values the ramp is laid over. Default: 2–98 % percentile clip. Ignored by class tables. */
    stretch?: StretchSpec;
    /**
     * A ramp ({@link RampJSON}), a class table ({@link ColorTableJSON}) or a {@link ColorFunction} (not
     * serialisable). Default: black to white.
     */
    colorMap?: ColorMapSpec | ColorFunction;
    /**
     * Gamma applied to the stretched position before the colour lookup, as `t^(1/gamma)` (> 1 moves mid values
     * towards the high end of the ramp). Default 1. Values ≤ 0 are treated as 1. Ignored by class tables.
     */
    gamma?: number;
}

/**
 * Full control, not serialisable: the library reads, resamples, caches, masks and computes statistics for the
 * `sources` (bands or expressions, each with an optional stretch), and `paint` writes the RGBA bytes. Masked pixels
 * are made transparent after `paint`.
 *
 * @example
 * ```ts
 * const render: CustomRender = {
 *     type: "custom",
 *     sources: ["red", "nir"],
 *     stretch: [0, 0.5],
 *     paint({values: [red, nir], n, ranges, out}) {
 *         for (let i = 0; i < n; i++) {
 *             const t = (nir[i] - ranges[1].min) / (ranges[1].max - ranges[1].min);
 *             out.set([255 * t, 0, 0, red[i] === red[i] ? 255 : 0], 4 * i);
 *         }
 *     },
 * };
 * ```
 *
 * @category Styles
 */
export interface CustomRender {
    /** Discriminator: application-defined colouring. */
    type: "custom";
    /** The values `paint` receives, in this order. At least one. A channel's `gamma` is not used. */
    sources: ChannelSpec[];
    /** Default stretch of the sources (for `ranges`); default 2–98 % percentile clip. */
    stretch?: StretchSpec;
    /**
     * Writes the colours of `n` pixels. Called once per rendered tile.
     *
     * @param input - The evaluated sources and the output buffer:
     *   - `values`: one Float32Array per source, in the order of `sources`, with at least `n` values; NaN marks
     *     missing data;
     *   - `n`: the number of pixels;
     *   - `ranges`: the resolved stretch range of each source (`{min, max}` in data units);
     *   - `out`: the RGBA bytes to fill, 4 per pixel (`out[4 * i]` is red, then green, blue, alpha), 4n bytes. It
     *     may contain earlier contents, so write every pixel.
     */
    paint(input: { values: Float32Array[]; n: number; ranges: { min: number; max: number }[]; out: Uint8ClampedArray }): void;
}

/**
 * How a style turns band values into colours, selected by `type`: an RGB composite ({@link RgbRender}), a single
 * value through a colour map ({@link PseudocolorRender}), or application code ({@link CustomRender}).
 *
 * @category Styles
 */
export type RenderSpec = RgbRender | PseudocolorRender | CustomRender;

/**
 * Hides pixels: those where `band` has one of `values`, has any of `bits` set, is outside `range`, or where
 * `expression` is non-zero. Use `invert` to keep only the matching pixels instead.
 *
 * - With `expression`, `band`, `values`, `bits` and `range` are ignored. A pixel matches when the expression is
 *   non-zero and not NaN.
 * - Otherwise `band` and at least one of `values`, `bits` and `range` are required; a pixel matches when any of them
 *   matches. Pixels where `band` is NaN never match and are never hidden, not even with `invert`.
 *
 * A style hides a pixel when any of its rules hides it.
 *
 * @example
 * ```json
 * { "band": "scl", "values": [0, 1, 3, 8, 9, 10] }
 * { "band": "qa_pixel", "bits": [0, 1, 2, 3, 4] }
 * { "band": "elevation", "range": [0, 4000] }
 * { "expression": "(nir - red) / (nir + red) < 0.2" }
 * { "band": "scl", "values": [4], "invert": true }
 * ```
 *
 * @category Styles
 */
export interface MaskRule {
    /** The band tested by `values`, `bits` and `range`. Required unless `expression` is set. */
    band?: string;
    /** Pixels where `band` equals one of these values are hidden. */
    values?: number[];
    /**
     * Bit indices (0 = least significant bit): pixels where `band` (truncated to a 32-bit integer) has any of these
     * bits set are hidden. Typical for QA bands.
     */
    bits?: number[];
    /** Pixels outside [min, max] (inclusive, in data units of `band`) are hidden. */
    range?: [number, number];
    /**
     * Band-math expression (see {@link parseExpression}): pixels where it is non-zero are hidden. Comparisons give 1
     * or 0, so `"cloud_prob > 40"` hides cloudy pixels.
     */
    expression?: string | ExpressionArray;
    /**
     * Hide the pixels that do not match instead of those that do. Default false. Pixels where the rule has no data
     * are hidden in both cases: NaN in its `band`, in a band its `expression` reads, or as the expression's result
     * (a rule cannot vouch for a pixel it has no value for), so `isnan(...)` in a rule cannot keep a pixel.
     */
    invert?: boolean;
}

/**
 * A complete style: how to colour the pixels and which pixels to hide. Plain JSON unless it uses a
 * {@link CustomRender} or a {@link ColorFunction}.
 *
 * Validate and prepare it with {@link compileStyle}.
 *
 * @example
 * ```json
 * { "render": { "type": "rgb", "red": "nir", "green": "red", "blue": "green",
 *               "stretch": { "type": "percentile", "low": 2, "high": 98 }, "gamma": 1.2 },
 *   "mask": [{ "band": "scl", "values": [0, 1, 3, 8, 9, 10] }] }
 * ```
 *
 * @category Styles
 */
export interface BandStyle {
    /** How to colour the pixels. */
    render: RenderSpec;
    /** Rules that hide pixels (made transparent); a pixel is hidden when any rule hides it. Default: none. */
    mask?: MaskRule[];
}

/**
 * Error in a style, with a JSON-pointer-like path to the offending property.
 *
 * Thrown by {@link compileStyle}. The message is prefixed with the path, for example
 * `render.red: unknown band "nir". Available: b1, b2, b3`; with an empty path (the style as a whole) it is the
 * bare message.
 *
 * @category Errors
 */
export class StyleError extends RiaGeoTiffError {
    /**
     * Creates a style error.
     *
     * @param message - What is wrong.
     * @param path - Where, for example `render.red`, `render.colorMap.stops[2].color`, `mask[0].band` or `""` for the
     *   style itself.
     */
    constructor(message: string, readonly path: string) {
        super(path ? `${path}: ${message}` : message, [{path, severity: "error", message}]);
        this.name = "StyleError";
    }
}

/** A channel reduced to its source (a band or an expression) and its options.
 *
 * @category Styles */
export interface ChannelSource {
    /** Canonical key of the values (band name or expression text), used to cache statistics. */
    key: string;
    /** Band name, when the source is a band. */
    band?: string;
    /** Expression, when the source is not a band. */
    expression?: string | ExpressionArray;
    /** Stretch in effect: the channel's own or the render's (with the render default applied). */
    stretch?: StretchSpec;
    /** Gamma in effect: the channel's own or the render's; `undefined` means 1. */
    gamma?: number;
}

/**
 * Reduces a channel to its source and options, applying the fallbacks of the render.
 *
 * A string that is an identifier becomes a band, any other string an expression. The key is the band name, the
 * trimmed expression text, or the JSON text of a JSON-array expression.
 *
 * @param spec - The channel.
 * @param path - Path of the channel in the style, used in errors (for example `render.red`).
 * @param fallbackStretch - Stretch used when the channel has none.
 * @param fallbackGamma - Gamma used when the channel has none.
 * @returns The channel's source, key, stretch and gamma.
 * @throws {@link StyleError} at `path` when `spec` is missing, or is an object with neither `band` nor `expression`.
 *
 * @category Styles
 */
export function channelSource(spec: ChannelSpec | undefined, path: string, fallbackStretch?: StretchSpec, fallbackGamma?: number): ChannelSource {
    if (spec === undefined || spec === null) throw new StyleError("a band or an expression is required", path);
    if (typeof spec === "string") {
        // A bare string is a band name if it is an identifier, otherwise an expression.
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(spec)
            ? {key: spec, band: spec, stretch: fallbackStretch, gamma: fallbackGamma}
            : {key: spec.trim(), expression: spec, stretch: fallbackStretch, gamma: fallbackGamma};
    }
    if (!spec.band && spec.expression === undefined) throw new StyleError("a band or an expression is required", path);
    const key = spec.band ?? (typeof spec.expression === "string" ? spec.expression.trim() : JSON.stringify(spec.expression));
    return {key, band: spec.band, expression: spec.band ? undefined : spec.expression,
        stretch: spec.stretch ?? fallbackStretch, gamma: spec.gamma ?? fallbackGamma};
}

/**
 * The default stretch: 2–98 % percentile clip, the ArcGIS and QGIS default for imagery.
 *
 * Used by every render whose `stretch` is not set.
 *
 * @category Styles
 */
export const DEFAULT_STRETCH: StretchSpec = {type: "percentile", low: 2, high: 98};

/**
 * The value sources a render needs (three for RGB, one for pseudocolour, one per source for custom), with the
 * render's stretch (or {@link DEFAULT_STRETCH}) and gamma as fallbacks.
 *
 * @param render - The render of a style.
 * @returns The sources, in channel order (red, green, blue for RGB).
 * @throws {@link StyleError} when `render` is missing (path `render`), its type is unknown (`render.type`), a custom
 *   render has no sources (`render.sources`), or a channel has neither a band nor an expression (`render.red`,
 *   `render.sources[0]`, `render`...).
 *
 * @category Styles
 */
export function renderSources(render: RenderSpec): ChannelSource[] {
    if (!render || typeof render !== "object") throw new StyleError("render is required", "render");
    if (render.type === "rgb") {
        const stretch = render.stretch ?? DEFAULT_STRETCH;
        return (["red", "green", "blue"] as const).map((c) => channelSource(render[c], `render.${c}`, stretch, render.gamma));
    }
    if (render.type === "pseudocolor") {
        return [channelSource({band: render.band, expression: render.expression}, "render",
            render.stretch ?? DEFAULT_STRETCH, render.gamma)];
    }
    if (render.type === "custom") {
        if (!Array.isArray(render.sources) || render.sources.length === 0) throw new StyleError("a custom render needs sources", "render.sources");
        return render.sources.map((c, i) => channelSource(c, `render.sources[${i}]`, render.stretch ?? DEFAULT_STRETCH));
    }
    throw new StyleError(`unknown render type "${(render as {type: unknown}).type}" (use "rgb", "pseudocolor" or "custom")`, "render.type");
}
