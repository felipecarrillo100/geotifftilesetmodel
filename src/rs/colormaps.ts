/**
 * Colour maps as plain data that travels inside a style: the library draws whatever it is given and knows no colour
 * names. Ready-made ramps are an optional import (`ria-geotiff/ramps`), never something a style refers to by name.
 *
 * Two kinds:
 * - a **ramp** ({@link RampJSON}): stops at positions 0..1, laid over the stretch range when drawn, so the same ramp
 *   works on any data (NDVI, temperature, elevation). Smooth or stepped, opacity per stop. The format is the one
 *   MapEvolution's ramp editor reads and writes, so ramps move between the two unchanged.
 * - a **table** ({@link ColorTableJSON}): exact value → colour, with labels, for class rasters (land cover, scene
 *   classification).
 *
 * @module
 */
import {RiaGeoTiffError} from "../errors.js";

/**
 * A ramp stop.
 *
 * @example
 * ```json
 * { "position": 0.5, "color": "#ffffbf", "label": "0.35" }
 * ```
 *
 * @category Colour maps
 */
export interface RampStop {
    /**
     * 0..1, ascending. 0 is drawn at the stretch minimum, 1 at its maximum. Ignored when the ramp's `spacing` is
     * `"equal"`.
     */
    position: number;
    /**
     * `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` or `rgba(…)`: opacity lives in the colour. Colour names are refused.
     * See {@link parseColor}.
     */
    color: string;
    /** Legend text. */
    label?: string;
}

/**
 * A colour ramp (MapEvolution's ramp JSON, version 1).
 * - `blend: "smooth"`: colours blend between stops. `"stepped"`: each stop starts an interval, drawn in one colour,
 *   running to the next stop (the last to 1); the first interval starts at 0.
 * - `spacing: "equal"`: positions follow from the stop count (`i / (n - 1)` smooth, `i / n` stepped) and the stored
 *   ones are ignored. `"custom"`: as given.
 * - `preset` and `reversed` are provenance for user interfaces ("Viridis, reversed"); drawing ignores them.
 *
 * Validated by {@link resolveRamp}: at least two stops, valid colours, positions in 0..1 (stops are sorted by
 * position when spacing is custom).
 *
 * @example
 * ```json
 * { "version": 1, "spacing": "custom", "blend": "smooth",
 *   "stops": [{ "position": 0, "color": "#d7191c" }, { "position": 0.4, "color": "#ffffbf" },
 *             { "position": 1, "color": "rgba(26,150,65,0.8)" }] }
 *
 * { "version": 1, "spacing": "equal", "blend": "stepped",
 *   "stops": [{ "position": 0, "color": "#fee08b", "label": "Low" }, { "position": 0.33, "color": "#fc8d59", "label": "Medium" },
 *             { "position": 0.67, "color": "#7f0000", "label": "High" }] }
 * ```
 *
 * @category Colour maps
 */
export interface RampJSON {
    /** Format version; only 1 is supported. Optional. */
    version?: 1;
    /** The stops, at least two. */
    stops: RampStop[];
    /** `"equal"`: positions follow from the stop count; `"custom"`: the stops' positions are used. Default `"custom"`. */
    spacing?: "equal" | "custom";
    /** `"smooth"`: colours blend between stops; `"stepped"`: one colour per interval. Default `"smooth"`. */
    blend?: "smooth" | "stepped";
    /** Name of the preset the ramp came from, for user interfaces. Not used for drawing. */
    preset?: string;
    /** Whether the ramp is a reversed preset, for user interfaces. Not used for drawing. */
    reversed?: boolean;
}

/**
 * A class table: exact values to colours. Values without an entry get `default` (transparent when absent).
 *
 * Values are matched as 32-bit floats, the precision of the decoded band values: an entry `0.1` matches a pixel
 * stored as float32 0.1. Integer class rasters match exactly. When two entries have the same value (also after
 * rounding to float32), the first wins.
 *
 * @example
 * ```json
 * { "type": "table", "default": "rgba(0,0,0,0)",
 *   "entries": [{ "value": 10, "color": "#006400", "label": "Tree cover" },
 *               { "value": 80, "color": "#0064c8", "label": "Permanent water" }] }
 * ```
 *
 * @category Colour maps
 */
export interface ColorTableJSON {
    /** Discriminator: a class table (what tells it apart from a {@link RampJSON}). */
    type: "table";
    /** The classes, at least one. */
    entries: {
        /** The data value of the class (a finite number, matched in float32 precision). */
        value: number;
        /** Colour of the class (see {@link RampStop.color}). */
        color: string;
        /** Legend text. Default: the value. */
        label?: string;
    }[];
    /** Colour of values without an entry. Default: transparent. */
    default?: string;
}

/** A colour map: a ramp ({@link RampJSON}) or a class table ({@link ColorTableJSON}). Tell them apart with {@link isColorTable}.
 *
 * @category Colour maps */
export type ColorMapSpec = RampJSON | ColorTableJSON;

/**
 * Whether a colour map is a class table (its `type` is `"table"`) rather than a ramp.
 *
 * @param spec - The colour map.
 * @returns `true` for a {@link ColorTableJSON}, `false` for a {@link RampJSON}.
 *
 * @category Colour maps
 */
export function isColorTable(spec: ColorMapSpec): spec is ColorTableJSON {
    return (spec as ColorTableJSON).type === "table";
}

// ------------------------------------------------------------------------------------------------ colours

/** RGBA, channels 0..255, alpha 0..1.
 *
 * @category Colour maps */
export interface Rgba {
    /** Red, 0..255 (may be fractional when interpolated). */
    r: number;
    /** Green, 0..255 (may be fractional when interpolated). */
    g: number;
    /** Blue, 0..255 (may be fractional when interpolated). */
    b: number;
    /** Opacity, 0 (transparent) to 1 (opaque). */
    a: number;
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const unit = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Parses a colour (see {@link RampStop.color}); undefined when it is not one.
 *
 * Accepted, case-insensitive, with surrounding white space ignored:
 * - `#rgb`, `#rrggbb` and `#rrggbbaa` (alpha 00..ff);
 * - `rgb(r, g, b)` and `rgba(r, g, b, a)`, with comma- or space-separated channels 0..255 (rounded and clamped) and
 *   an optional alpha after `,` or `/`, either 0..1 or a percentage (`50%`), clamped to 0..1.
 *
 * Colour names (`"red"`), `#rgba`, `hsl()` and percentage RGB channels are not accepted.
 *
 * @param value - The value to parse; anything that is not a string gives `undefined`.
 * @returns The colour, or `undefined` when `value` is not a colour in one of the accepted forms.
 *
 * @example
 * ```ts
 * parseColor("#ff8000");             // {r: 255, g: 128, b: 0, a: 1}
 * parseColor("rgba(0, 0, 255, 0.5)"); // {r: 0, g: 0, b: 255, a: 0.5}
 * parseColor("rgb(0 0 255 / 50%)");   // {r: 0, g: 0, b: 255, a: 0.5}
 * parseColor("red");                  // undefined
 * ```
 *
 * @category Colour maps
 */
export function parseColor(value: unknown): Rgba | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
    if (hex) {
        const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
        return {r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
            a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1};
    }
    const fn = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(text);
    if (fn) {
        const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
        const a = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1);
        if (![r, g, b, a].every(Number.isFinite)) return undefined;
        return {r: byte(r), g: byte(g), b: byte(b), a: unit(a)};
    }
    return undefined;
}

/**
 * `#rrggbb` when opaque, else `rgba(r,g,b,a)`.
 *
 * Channels are rounded and clamped to 0..255, alpha clamped to 0..1 and rounded to three decimals.
 *
 * @param color - The colour.
 * @returns A CSS colour string that {@link parseColor} reads back.
 *
 * @category Colour maps
 */
export function formatColor({r, g, b, a}: Rgba): string {
    const alpha = Math.round(unit(a) * 1000) / 1000;
    if (alpha >= 1) return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
    return `rgba(${byte(r)},${byte(g)},${byte(b)},${alpha})`;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Packs RGBA bytes into the platform's byte order for a Uint32 view over RGBA bytes.
 *
 * Writing the result into a `Uint32Array` that shares its buffer with a `Uint8ClampedArray` puts r, g, b and a in
 * consecutive bytes, whatever the endianness.
 *
 * @param r - Red, an integer 0..255.
 * @param g - Green, an integer 0..255.
 * @param b - Blue, an integer 0..255.
 * @param a - Alpha, an integer 0..255 (not 0..1).
 * @returns The packed colour, an unsigned 32-bit integer.
 *
 * @category Colour maps
 */
export function packRGBA(r: number, g: number, b: number, a: number): number {
    return LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function packColor(c: Rgba): number {
    // Interpolated channels are fractional: round them (the bit operations of packRGBA would truncate).
    return packRGBA(byte(c.r), byte(c.g), byte(c.b), byte(c.a * 255));
}

// ------------------------------------------------------------------------------------------------ ramps

/**
 * Error in a colour map; `path` points into it (`stops[2].color`).
 *
 * The message is `path: reason`, or just the reason when there is no path. {@link compileStyle} reports these as a
 * {@link StyleError} at `render.colorMap.<path>`.
 *
 * @category Errors
 */
export class ColorMapError extends RiaGeoTiffError {
    /**
     * Creates a colour map error.
     *
     * @param reason - What is wrong.
     * @param path - Where in the colour map, for example `stops[2].color`; `""` (the default) for the colour map as a
     *   whole.
     */
    constructor(readonly reason: string, readonly path = "") {
        super(path ? `${path}: ${reason}` : reason, [{path, severity: "error", message: reason}]);
        this.name = "ColorMapError";
    }
}

/** A ramp with its invariants applied: sorted stops in 0..1 with parsed colours and resolved spacing.
 *
 * @category Colour maps */
export interface ResolvedRamp {
    /** How colours are drawn between stops (`"smooth"` when the ramp did not say). */
    blend: "smooth" | "stepped";
    /** The stops, sorted by position; for stepped ramps the first is at 0. */
    stops: {
        /** Position 0..1, after spacing is applied. */
        position: number;
        /** The parsed colour. */
        color: Rgba;
        /** The colour as normalised CSS ({@link formatColor}). */
        css: string;
        /** Legend text from the stop. */
        label?: string;
    }[];
}

/**
 * Validates a ramp and applies its spacing and blend rules. Throws {@link ColorMapError} for anything that is not a
 * ramp: fewer than two stops, an unparsable colour, a position outside 0..1.
 *
 * With `spacing: "equal"` the stored positions are replaced by `i / (n - 1)` (smooth) or `i / n` (stepped); otherwise
 * the stops are sorted by position. For stepped ramps the first stop is moved to 0. The input is not modified.
 *
 * @param ramp - The ramp.
 * @returns The ramp with parsed colours and final positions, ready for {@link sampleRamp} and {@link buildRampLut}.
 * @throws {@link ColorMapError} when `ramp` has no `stops` array (path `""`), `version` is not 1 (`version`), there
 *   are fewer than two stops (`stops`), a colour is invalid (`stops[i].color`) or a custom position is not a number in
 *   0..1 (`stops[i].position`).
 *
 * @example
 * ```ts
 * const resolved = resolveRamp({stops: [{position: 1, color: "#fff"}, {position: 0, color: "#000"}]});
 * // resolved.blend === "smooth"; resolved.stops[0].css === "#000000"; resolved.stops[1].css === "#ffffff"
 * ```
 *
 * @category Colour maps
 */
export function resolveRamp(ramp: RampJSON): ResolvedRamp {
    if (!ramp || !Array.isArray(ramp.stops)) throw new ColorMapError("a ramp needs a stops array");
    if (ramp.version !== undefined && ramp.version !== 1) throw new ColorMapError(`unsupported ramp version ${ramp.version}`, "version");
    if (ramp.stops.length < 2) throw new ColorMapError("a ramp needs at least two stops", "stops");
    const blend = ramp.blend === "stepped" ? "stepped" : "smooth";
    const equal = ramp.spacing === "equal";
    const n = ramp.stops.length;
    const stops = ramp.stops.map((s, i) => {
        const color = parseColor(s?.color);
        if (!color) throw new ColorMapError(`invalid colour ${JSON.stringify(s?.color)} (use #rrggbb, #rrggbbaa or rgba())`, `stops[${i}].color`);
        let position = equal ? (blend === "stepped" ? i / n : i / (n - 1)) : s.position;
        if (typeof position !== "number" || !(position >= 0 && position <= 1)) {
            throw new ColorMapError(`position must be a number in 0..1, got ${JSON.stringify(s.position)}`, `stops[${i}].position`);
        }
        position = Number(position);
        return {position, color, css: formatColor(color), label: s.label};
    });
    if (!equal) stops.sort((a, b) => a.position - b.position);
    if (blend === "stepped") stops[0].position = 0;
    return {blend, stops};
}

/**
 * The colour of a resolved ramp at `t` (0..1, clamped).
 *
 * Smooth ramps interpolate linearly (all four channels) between the two stops around `t`, and use the first or last
 * colour outside them. Stepped ramps give the colour of the last stop at or before `t`.
 *
 * @param ramp - A ramp from {@link resolveRamp}.
 * @param t - Position 0..1; values outside are clamped, `+Infinity` is treated as 1, and NaN and `-Infinity` as 0.
 * @returns A new colour object (never the ramp's own stop colour, so it may be modified). Interpolated channels are
 *   not rounded.
 *
 * @example
 * ```ts
 * const grey = resolveRamp({stops: [{position: 0, color: "#000"}, {position: 1, color: "#fff"}]});
 * sampleRamp(grey, 0.5); // {r: 127.5, g: 127.5, b: 127.5, a: 1}
 * ```
 *
 * @category Colour maps
 */
export function sampleRamp(ramp: ResolvedRamp, t: number): Rgba {
    // +Infinity is past the end of the ramp, -Infinity and NaN before its start.
    const at = unit(t === Number.POSITIVE_INFINITY ? 1 : Number.isFinite(t) ? t : 0);
    const {stops} = ramp;
    if (ramp.blend === "stepped") {
        let chosen = stops[0];
        for (const s of stops) if (s.position <= at) chosen = s;
        return {...chosen.color};
    }
    if (at <= stops[0].position) return {...stops[0].color};
    for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1], b = stops[i];
        if (at <= b.position) {
            const span = b.position - a.position;
            const f = span === 0 ? 1 : (at - a.position) / span;
            return {r: a.color.r + (b.color.r - a.color.r) * f, g: a.color.g + (b.color.g - a.color.g) * f,
                b: a.color.b + (b.color.b - a.color.b) * f, a: a.color.a + (b.color.a - a.color.a) * f};
        }
    }
    return {...stops[stops.length - 1].color};
}

/** Entries of continuous lookup tables: finer than 8-bit display steps. Value: 1024.
 *
 * @category Colour maps */
export const LUT_SIZE = 1024;

/**
 * A lookup table of `LUT_SIZE` packed RGBA colours for positions 0..1.
 *
 * Entry `i` is the ramp sampled at `i / (LUT_SIZE - 1)`, with each channel rounded to the nearest byte (alpha
 * 0..1 scaled to 0..255), packed as RGBA bytes in platform byte order, so it can be written straight into a
 * `Uint32Array` view over RGBA bytes.
 *
 * @param ramp - A ramp from {@link resolveRamp}.
 * @returns A new `Uint32Array` of {@link LUT_SIZE} (1024) packed colours.
 *
 * @example
 * ```ts
 * const lut = buildRampLut(resolveRamp(myRamp));
 * const colour = lut[Math.round(t * (LUT_SIZE - 1))]; // t in 0..1
 * ```
 *
 * @category Colour maps
 */
export function buildRampLut(ramp: ResolvedRamp): Uint32Array {
    const lut = new Uint32Array(LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i++) lut[i] = packColor(sampleRamp(ramp, i / (LUT_SIZE - 1)));
    return lut;
}

/**
 * CSS `linear-gradient(…)` of a ramp, with hard edges for stepped ramps (legends, pickers).
 *
 * Colour stops are written as normalised CSS colours with positions in percent (two decimals).
 *
 * @param ramp - The ramp.
 * @param direction - The gradient direction, inserted verbatim: `"to right"` (the default), `"to top"`, `"90deg"`...
 * @returns The CSS image, for example `linear-gradient(to right, #000000 0%, #ffffff 100%)`.
 * @throws {@link ColorMapError} when the ramp is invalid (see {@link resolveRamp}).
 *
 * @example
 * ```ts
 * legend.style.background = cssGradient({spacing: "equal", stops: [
 *     {position: 0, color: "#440154"}, {position: 0, color: "#21918c"}, {position: 0, color: "#fde725"}]});
 * // "linear-gradient(to right, #440154 0%, #21918c 50%, #fde725 100%)"
 * ```
 *
 * @category Colour maps
 */
export function cssGradient(ramp: RampJSON, direction = "to right"): string {
    const r = resolveRamp(ramp);
    const pct = (p: number) => `${Math.round(p * 10000) / 100}%`;
    const parts = r.blend === "stepped"
        ? r.stops.flatMap((s, i) => [`${s.css} ${pct(s.position)}`, `${s.css} ${pct(i + 1 < r.stops.length ? r.stops[i + 1].position : 1)}`])
        : r.stops.map((s) => `${s.css} ${pct(s.position)}`);
    return `linear-gradient(${direction}, ${parts.join(", ")})`;
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * A ramp from colours, lowest first, equally spaced.
 *
 * The result has `version: 1`, `spacing: "equal"` and positions written out (`i / (n - 1)` smooth, `i / n` stepped,
 * rounded to six decimals) so the JSON reads as it draws. The colours are not validated here, and fewer than two
 * colours give a ramp that {@link resolveRamp} rejects.
 *
 * @param colors - The colours (see {@link RampStop.color}), at least two, from the low end to the high end.
 * @param options - `blend`: `"smooth"` (default) or `"stepped"`; `preset`: a name stored in the ramp's `preset`
 *   (omitted when empty).
 * @returns A new ramp.
 *
 * @example
 * ```ts
 * rampFromColors(["#2c7bb6", "#ffffbf", "#d7191c"]);
 * // {version: 1, spacing: "equal", blend: "smooth", stops: [
 * //   {position: 0, color: "#2c7bb6"}, {position: 0.5, color: "#ffffbf"}, {position: 1, color: "#d7191c"}]}
 * ```
 *
 * @category Colour maps
 */
export function rampFromColors(colors: string[], options: { blend?: "smooth" | "stepped"; preset?: string } = {}): RampJSON {
    const blend = options.blend ?? "smooth";
    const n = colors.length;
    // Positions are written out (they follow from the count with equal spacing) so the JSON reads as it draws.
    const at = (i: number) => Math.round((blend === "stepped" ? i / n : i / Math.max(1, n - 1)) * 1e6) / 1e6;
    return {version: 1, stops: colors.map((color, i) => ({position: at(i), color})), spacing: "equal",
        blend, ...(options.preset ? {preset: options.preset} : {})};
}

/**
 * A ramp from stops at data values, and the fixed stretch they span: `{ramp, stretch}`. For legends defined in data
 * units, such as NDVI colours at fixed values or class breaks (`blend: "stepped"`: each value starts an interval).
 *
 * Each stop's position is `(value - min) / (max - min)`, clamped to 0..1, so stops outside `range` are drawn at its
 * ends. Use the returned `stretch` as the render's stretch so the colours land on their values. Colours are not
 * validated here (see {@link resolveRamp}).
 *
 * @param stops - Data values with their colours and optional legend labels, at least two, in any order.
 * @param options - `blend`: `"smooth"` (default) or `"stepped"`; `range`: the `[min, max]` the ramp spans, in data
 *   units (default: the smallest and largest stop value).
 * @returns The ramp (`version: 1`, `spacing: "custom"`) and the stretch `[min, max]` to draw it with.
 * @throws {@link ColorMapError} when there are fewer than two stops, or the range is not increasing.
 *
 * @example
 * ```ts
 * const {ramp, stretch} = rampFromValues([
 *     {value: 0, color: "#ffffcc"}, {value: 0.3, color: "#78c679"}, {value: 0.8, color: "#006837"}]);
 * const style: BandStyle = {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", colorMap: ramp, stretch}};
 * // stretch: [0, 0.8]; positions 0, 0.375, 1
 * ```
 *
 * @category Colour maps
 */
export function rampFromValues(
    stops: { value: number; color: string; label?: string }[],
    options: { blend?: "smooth" | "stepped"; range?: [number, number] } = {},
): {
    /** The ramp, with stop positions computed from the values. */
    ramp: RampJSON;
    /** The fixed stretch `[min, max]`, in data units, that puts each colour at its value. */
    stretch: [number, number];
} {
    if (stops.length < 2) throw new ColorMapError("at least two stops are needed");
    const values = stops.map((s) => s.value);
    const [min, max] = options.range ?? [Math.min(...values), Math.max(...values)];
    if (!(max > min)) throw new ColorMapError("the range must be increasing");
    return {
        stretch: [min, max],
        ramp: {version: 1, spacing: "custom", blend: options.blend ?? "smooth",
            stops: stops.map((s) => ({position: unit((s.value - min) / (max - min)), color: s.color, ...(s.label ? {label: s.label} : {})}))},
    };
}

/**
 * The same ramp in the opposite direction (positions mirrored; for stepped ramps the intervals are mirrored).
 *
 * The other properties are kept, `version` is set to 1, `spacing` stays `"equal"` or becomes `"custom"`, and
 * `reversed` is toggled. Stop colours are written in normalised form ({@link formatColor}). Reversing twice gives the
 * original ramp (up to that normalisation).
 *
 * @param ramp - The ramp.
 * @returns A new ramp.
 * @throws {@link ColorMapError} when the ramp is invalid (see {@link resolveRamp}).
 *
 * @example
 * ```ts
 * reverseRamp({stops: [{position: 0, color: "#000"}, {position: 0.25, color: "#fff"}]});
 * // {version: 1, spacing: "custom", reversed: true,
 * //  stops: [{position: 0.75, color: "#ffffff"}, {position: 1, color: "#000000"}]}
 * ```
 *
 * @category Colour maps
 */
export function reverseRamp(ramp: RampJSON): RampJSON {
    const r = resolveRamp(ramp);
    const n = r.stops.length;
    const ends = r.stops.map((_, i) => (i + 1 < n ? r.stops[i + 1].position : 1));
    const stops = (r.blend === "stepped"
        ? r.stops.map((s, i) => ({position: 1 - ends[i], color: s.css, label: s.label}))
        : r.stops.map((s) => ({position: 1 - s.position, color: s.css, label: s.label}))).reverse()
        .map((s) => (s.label ? s : {position: s.position, color: s.color}));
    return {...ramp, version: 1, spacing: ramp.spacing === "equal" ? "equal" : "custom", stops, reversed: !ramp.reversed};
}

/**
 * Validates a class table and resolves its colours. Throws {@link ColorMapError}.
 *
 * @param table - The class table.
 * @returns The colours by value, packed as RGBA bytes in platform byte order for a `Uint32Array` view, and the
 *   packed colour for values without an entry. The keys are the values rounded to float32 (`Math.fround`), as
 *   pixel values are: look a pixel value of a `Float32Array` up directly, or `Math.fround(value)` for a double.
 *   The first entry wins for duplicate keys.
 * @throws {@link ColorMapError} when the table has no entries (path `entries`), an entry's colour is invalid
 *   (`entries[i].color`) or its value is not a finite number (`entries[i].value`), or `default` is not a colour
 *   (`default`).
 *
 * @example
 * ```ts
 * const {colors, fallback} = resolveColorTable({type: "table", entries: [{value: 6, color: "#0000ff", label: "Water"}]});
 * colors.has(6); // true: opaque blue, packed
 * colors.has(7); // false: drawn with `fallback`
 * fallback === 0; // true: transparent
 * ```
 *
 * @category Colour maps
 */
export function resolveColorTable(table: ColorTableJSON): {
    /** Packed RGBA colour by data value, keyed by the value rounded to float32. */
    colors: Map<number, number>;
    /** Packed RGBA colour of values without an entry: `default`, or 0 (transparent). */
    fallback: number;
} {
    if (!Array.isArray(table.entries) || table.entries.length === 0) throw new ColorMapError("a table needs entries", "entries");
    const colors = new Map<number, number>();
    table.entries.forEach((e, i) => {
        const c = parseColor(e?.color);
        if (!c) throw new ColorMapError(`invalid colour ${JSON.stringify(e?.color)}`, `entries[${i}].color`);
        if (typeof e.value !== "number" || !Number.isFinite(e.value)) throw new ColorMapError("value must be a number", `entries[${i}].value`);
        // Pixel values are Float32: key by the value in float32 precision, so 0.1 matches a stored 0.1.
        const key = Math.fround(e.value);
        if (!colors.has(key)) colors.set(key, packColor(c));
    });
    let fallback = 0;
    if (table.default !== undefined) {
        const c = parseColor(table.default);
        if (!c) throw new ColorMapError(`invalid colour ${JSON.stringify(table.default)}`, "default");
        fallback = packColor(c);
    }
    return {colors, fallback};
}

/** The default when a style gives no colour map: black to white, smooth, equally spaced.
 *
 * @category Colour maps */
export const GREY_RAMP: RampJSON = {version: 1, stops: [{position: 0, color: "#000000"}, {position: 1, color: "#ffffff"}], spacing: "equal", blend: "smooth"};
