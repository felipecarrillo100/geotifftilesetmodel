/**
 * Renders decoded band values to RGBA with a {@link BandStyle}: evaluate sources (bands or expressions), mask,
 * stretch, gamma, colour map. All per-pixel work goes through typed arrays and lookup tables, so a 256x256 tile
 * renders in well under a millisecond (see the spikes in the design notes).
 *
 * @module
 */
import {
    buildRampLut, ColorMapError, cssGradient, GREY_RAMP, isColorTable, LUT_SIZE, packRGBA, resolveColorTable, resolveRamp,
    type ColorMapSpec, type RampJSON,
} from "./colormaps.js";
import {compileExpression, expressionBands, toExpressionNode, type BandArrays, type CompiledExpression, type ExpressionArray} from "./expression.js";
import {resolveStretch, stretchNeedsStatistics, type BandStatistics, type ResolvedStretch} from "./stats.js";
import {renderSources, StyleError, type BandStyle, type ChannelSource, type MaskRule} from "./style.js";

/**
 * A style validated against the available bands, ready to render tiles. Created by {@link compileStyle}.
 *
 * Statistics are passed per source, in the order of {@link CompiledStyle.sources}: compute them with
 * {@link computeStatistics} over {@link CompiledStyle.evaluate} of an overview when {@link CompiledStyle.needsStatistics}
 * is true.
 *
 * @category Styles
 */
export interface CompiledStyle {
    /** The style as given to {@link compileStyle} (not copied: do not modify it). */
    readonly style: BandStyle;
    /**
     * The value sources: three for RGB, one for pseudocolour, one per entry of `sources` for custom renders. Each
     * has a `key` (band name or expression text) suitable for caching its statistics, and its stretch and gamma.
     */
    readonly sources: ChannelSource[];
    /** Input bands the style reads (for sources and masks), each once: the bands to fetch before rendering. */
    readonly requiredBands: string[];
    /**
     * Whether some stretch depends on statistics (percentile, minmax or stddev, including the default stretch).
     * False for a pseudocolour render with a class table, which ignores its stretch.
     */
    readonly needsStatistics: boolean;
    /**
     * Evaluates the sources over `n` pixels (NaN where data is missing).
     *
     * @param bands - Band values by name, each with at least `n` values (NaN for missing data). Must contain every
     *   band of {@link CompiledStyle.requiredBands}.
     * @param n - Number of pixels.
     * @returns One new Float32Array of `n` values per source, in the order of {@link CompiledStyle.sources}.
     */
    evaluate(bands: BandArrays, n: number): Float32Array[];
    /**
     * Pixels hidden by the style's mask rules (1 = hidden), or null without rules.
     *
     * @param bands - Band values by name, each with at least `n` values.
     * @param n - Number of pixels.
     * @returns A new Uint8Array of `n` flags (1 = hidden, 0 = visible), or `null` when the style has no mask rules.
     */
    mask(bands: BandArrays, n: number): Uint8Array | null;
    /**
     * The stretch ranges in effect, given per-source statistics.
     *
     * Each source's stretch is resolved with {@link resolveStretch}; statistic-based stretches resolve to [0, 1] while
     * the source's statistics are missing.
     *
     * @param stats - Statistics per source, in the order of {@link CompiledStyle.sources}; `null`/`undefined` (or a
     *   shorter array) where not available.
     * @returns One range per source, in data units.
     */
    resolveStretches(stats: (BandStatistics | null | undefined)[]): ResolvedStretch[];
    /**
     * Renders `n` pixels into RGBA bytes (`out`, 4n bytes; allocated when omitted). Pixels that are masked, or with
     * no data in a source, become transparent. Mask rules also hide the pixels where they have no data (NaN in
     * their band, or in a band their expression reads).
     *
     * For custom renders, `paint` decides how to draw pixels with no data; only masked pixels are made transparent
     * afterwards.
     *
     * @param bands - Band values by name, each with at least `n` values (NaN for missing data). Must contain every
     *   band of {@link CompiledStyle.requiredBands}.
     * @param n - Number of pixels.
     * @param stats - Statistics per source, as for {@link CompiledStyle.resolveStretches}.
     * @param out - Where to write: at least `4 * n` bytes, at any byte offset (when it is not a multiple of 4, the
     *   pixels are rendered into a temporary array and copied). Default: a new array.
     * @returns `out`, or the new array: 4 bytes per pixel, in R, G, B, A order.
     */
    render(bands: BandArrays, n: number, stats: (BandStatistics | null | undefined)[], out?: Uint8ClampedArray): Uint8ClampedArray;
}

function sourceEvaluator(source: ChannelSource, bandNames: string[], path: string): CompiledExpression {
    if (source.band) {
        if (!bandNames.includes(source.band)) {
            throw new StyleError(`unknown band "${source.band}". Available: ${bandNames.join(", ")}`, path);
        }
        const name = source.band;
        return (bands, n, out) => out.set(bands[name].subarray(0, n));
    }
    try {
        return compileExpression(source.expression!, bandNames);
    } catch (e) {
        throw new StyleError((e as Error).message, `${path}.expression`);
    }
}

interface CompiledMask { test: (bands: BandArrays, n: number, hidden: Uint8Array) => void }

function compileMask(rule: MaskRule, bandNames: string[], path: string): CompiledMask {
    const invert = !!rule.invert;
    if (rule.expression !== undefined) {
        let expr: CompiledExpression;
        try {
            expr = compileExpression(rule.expression, bandNames);
        } catch (e) {
            throw new StyleError((e as Error).message, `${path}.expression`);
        }
        const read = [...expressionBands(toExpressionNode(rule.expression))];
        let tmp = new Float32Array(0);
        return {
            test: (bands, n, hidden) => {
                if (tmp.length < n) tmp = new Float32Array(n);
                expr(bands, n, tmp);
                // A non-zero result matches; no data (a NaN result, or a NaN in a band read) hides, inverted or not.
                for (let i = 0; i < n; i++) { const x = tmp[i]; if (x !== x || (x !== 0) !== invert) hidden[i] = 1; }
                for (const name of read) {
                    const v = bands[name];
                    for (let i = 0; i < n; i++) if (v[i] !== v[i]) hidden[i] = 1;
                }
            },
        };
    }
    const band = rule.band;
    if (!band) throw new StyleError("a mask rule needs a band or an expression", path);
    if (!bandNames.includes(band)) throw new StyleError(`unknown band "${band}". Available: ${bandNames.join(", ")}`, `${path}.band`);
    const values = rule.values ? new Set(rule.values) : null;
    const bitMask = rule.bits ? rule.bits.reduce((m, b) => m | (1 << b), 0) : 0;
    const range = rule.range;
    if (!values && !bitMask && !range) throw new StyleError("a mask rule needs values, bits, range or an expression", path);
    return {
        test: (bands, n, hidden) => {
            const v = bands[band];
            for (let i = 0; i < n; i++) {
                const x = v[i];
                if (x !== x) { hidden[i] = 1; continue; } // no data hides, inverted or not
                const match = (values !== null && values.has(x))
                    || (bitMask !== 0 && ((x | 0) & bitMask) !== 0)
                    || (range !== undefined && (x < range[0] || x > range[1]));
                if (match !== invert) hidden[i] = 1;
            }
        },
    };
}

/** Gamma LUT: normalised position (LUT_SIZE steps) to a display byte. */
function gammaLut(gamma = 1): Uint8Array {
    const lut = new Uint8Array(LUT_SIZE);
    const inv = 1 / (gamma > 0 ? gamma : 1);
    for (let i = 0; i < LUT_SIZE; i++) lut[i] = Math.round(255 * Math.pow(i / (LUT_SIZE - 1), inv));
    return lut;
}

const TRANSPARENT = 0;

/**
 * Validates a style against the band names and prepares it for rendering. Throws {@link StyleError}.
 *
 * Everything that can be checked without data is checked here: the render type, that every source and mask rule
 * names a band or an expression, that bands exist in `bandNames`, that expressions parse and only use those bands,
 * that mask rules have a test, that the colour map is valid, and that a custom render has a `paint` function.
 * Expressions and colour lookup tables are compiled once, here.
 *
 * @param style - The style.
 * @param bandNames - The names of the bands available in the data (for example `["red", "green", "blue", "nir"]`).
 * @returns The compiled style.
 * @throws {@link StyleError} with the path of the offending property, for example:
 *   `""` (no style object), `render`, `render.type`, `render.red`, `render.sources[0]` (missing source or unknown
 *   band), `render.expression`, `render.red.expression` (invalid expression or unknown band in it), `mask[0]`,
 *   `mask[0].band`, `mask[0].expression`, `render.colorMap`, `render.colorMap.stops[2].color` (invalid colour map),
 *   `render.paint`.
 *
 * @example
 * ```ts
 * const compiled = compileStyle({
 *     render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9],
 *         colorMap: rampFromColors(["#a50026", "#ffffbf", "#006837"])},
 *     mask: [{band: "scl", values: [0, 1, 3, 8, 9, 10]}],
 * }, ["red", "nir", "scl"]);
 * compiled.requiredBands; // ["nir", "red", "scl"]
 * const rgba = compiled.render({red, nir, scl}, 256 * 256, []); // Float32Arrays in, 4 bytes per pixel out
 * ```
 *
 * @category Styles
 */
export function compileStyle(style: BandStyle, bandNames: string[]): CompiledStyle {
    if (!style || typeof style !== "object") throw new StyleError("a style object is required", "");
    const render = style.render;
    const sources = renderSources(render);
    const evaluators = sources.map((s, i) => sourceEvaluator(s, bandNames, render.type === "rgb" ? `render.${["red", "green", "blue"][i]}` : render.type === "custom" ? `render.sources[${i}]` : "render"));
    const masks = (style.mask ?? []).map((rule, i) => compileMask(rule, bandNames, `mask[${i}]`));

    const required = new Set<string>();
    const addBands = (band?: string, expression?: string | ExpressionArray) => {
        if (band) required.add(band);
        else if (expression !== undefined) expressionBands(toExpressionNode(expression), required);
    };
    sources.forEach((s) => addBands(s.band, s.expression));
    (style.mask ?? []).forEach((rule) => addBands(rule.expression === undefined ? rule.band : undefined, rule.expression));

    const evaluate = (bands: BandArrays, n: number) => evaluators.map((ev) => {
        const out = new Float32Array(n);
        ev(bands, n, out);
        return out;
    });

    const resolveStretches = (stats: (BandStatistics | null | undefined)[]) =>
        sources.map((s, i) => resolveStretch(s.stretch, stats[i]));

    const applyMasks = (bands: BandArrays, n: number): Uint8Array | null => {
        if (masks.length === 0) return null;
        const hidden = new Uint8Array(n);
        for (const m of masks) m.test(bands, n, hidden);
        return hidden;
    };

    let renderPixels: (values: Float32Array[], n: number, ranges: ResolvedStretch[], px: Uint32Array, hidden: Uint8Array | null) => void;

    if (render.type === "rgb") {
        const luts = sources.map((s) => gammaLut(s.gamma ?? 1));
        const saturation = render.saturation ?? 1;
        renderPixels = (values, n, ranges, px, hidden) => {
            const [r, g, b] = values;
            const scale = ranges.map((rg) => (LUT_SIZE - 1) / (rg.max - rg.min));
            const [l0, l1, l2] = luts;
            const index = (v: number, c: number) => {
                const t = (v - ranges[c].min) * scale[c];
                return t <= 0 ? 0 : t >= LUT_SIZE - 1 ? LUT_SIZE - 1 : (t + 0.5) | 0;
            };
            for (let i = 0; i < n; i++) {
                const vr = r[i], vg = g[i], vb = b[i];
                if (vr !== vr || vg !== vg || vb !== vb || (hidden !== null && hidden[i])) { px[i] = TRANSPARENT; continue; }
                let cr = l0[index(vr, 0)], cg = l1[index(vg, 1)], cb = l2[index(vb, 2)];
                if (saturation !== 1) {
                    const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
                    cr = clampByte(lum + saturation * (cr - lum));
                    cg = clampByte(lum + saturation * (cg - lum));
                    cb = clampByte(lum + saturation * (cb - lum));
                }
                px[i] = packRGBA(cr, cg, cb, 255);
            }
        };
    } else if (render.type === "pseudocolor") {
        renderPixels = pseudocolorRenderer(render.colorMap ?? GREY_RAMP, render.gamma ?? 1);
    } else {
        // Custom: the application colours the evaluated values itself.
        const paint = render.paint;
        if (typeof paint !== "function") throw new StyleError("a custom render needs a paint function", "render.paint");
        renderPixels = (values, n, ranges, px, hidden) => {
            paint({values, n, ranges, out: new Uint8ClampedArray(px.buffer, px.byteOffset, n * 4)});
            if (hidden) for (let i = 0; i < n; i++) if (hidden[i]) px[i] = TRANSPARENT;
        };
    }

    const needsStatistics = sources.some((s, i) => stretchNeedsStatistics(s.stretch)
        && !(render.type === "pseudocolor" && i === 0 && render.colorMap && typeof render.colorMap === "object" && isColorTable(render.colorMap)));

    return {
        style, sources, requiredBands: [...required], needsStatistics, evaluate, resolveStretches, mask: applyMasks,
        render(bands, n, stats, out) {
            const target = out ?? new Uint8ClampedArray(n * 4);
            // A Uint32Array view needs a byte offset that is a multiple of 4: otherwise render aside and copy.
            const aligned = target.byteOffset % 4 === 0;
            const work = aligned ? target : new Uint8ClampedArray(n * 4);
            const px = new Uint32Array(work.buffer, work.byteOffset, n);
            const values = evaluate(bands, n);
            renderPixels(values, n, resolveStretches(stats), px, applyMasks(bands, n));
            if (!aligned) target.set(work.subarray(0, n * 4));
            return target;
        },
    };
}

function clampByte(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * A colour map given as a function: `t` is the stretched position 0..1, `value` the data value it stands for.
 *
 * The function is not called per pixel: it is sampled at 1024 positions into a lookup table, which is rebuilt when
 * the stretch range changes. `t` is the position after the render's `gamma`; `value` is the data value drawn there:
 * `min + t^gamma * (max - min)` for the current stretch range (`min + t * (max - min)` with the default gamma 1).
 * It returns `[r, g, b, a]` with channels 0..255 (rounded and clamped); `a` defaults to 255 (opaque).
 *
 * Not serialisable: use it in code only, as the `colorMap` of a {@link PseudocolorRender}.
 *
 * @param t - Position in the colour map, 0..1: the position in the stretch range after gamma.
 * @param value - The data value of the pixels drawn at `t`, in data units.
 * @returns The colour `[r, g, b]` or `[r, g, b, a]`, channels 0..255.
 *
 * @example
 * ```ts
 * const aboveZero: ColorFunction = (t, value) => value > 0 ? [0, 0, 255 * t] : [128, 128, 128, 0];
 * ```
 *
 * @category Styles
 */
export type ColorFunction = (t: number, value: number) => [number, number, number, number?];

function pseudocolorRenderer(spec: ColorMapSpec | ColorFunction, gamma: number) {
    if (typeof spec === "object" && spec !== null && isColorTable(spec)) {
        let table: ReturnType<typeof resolveColorTable>;
        try {
            table = resolveColorTable(spec);
        } catch (e) {
            throw styleErrorOf(e);
        }
        const {colors, fallback} = table;
        return (values: Float32Array[], n: number, _r: ResolvedStretch[], px: Uint32Array, hidden: Uint8Array | null) => {
            const v = values[0];
            for (let i = 0; i < n; i++) {
                const x = v[i];
                px[i] = x !== x || (hidden !== null && hidden[i]) ? TRANSPARENT : colors.get(x) ?? fallback;
            }
        };
    }

    // A ramp (or function) over the stretch range: positions 0..1 through gamma into a LUT_SIZE lookup table.
    const g = gammaLut(gamma);
    const useGamma = gamma !== 1;
    let lutFor: (min: number, max: number) => Uint32Array;
    if (typeof spec === "function") {
        // Functions may depend on the data value, so their table is rebuilt when the range changes.
        let cached: { min: number; max: number; lut: Uint32Array } | null = null;
        lutFor = (min, max) => {
            if (cached && cached.min === min && cached.max === max) return cached.lut;
            const lut = new Uint32Array(LUT_SIZE);
            for (let i = 0; i < LUT_SIZE; i++) {
                const t = i / (LUT_SIZE - 1);
                // Entry i is reached by pixels at position t^gamma before gamma (gamma maps p to p^(1/gamma)).
                const [r, g, b, a = 255] = spec(t, min + (useGamma ? Math.pow(t, gamma > 0 ? gamma : 1) : t) * (max - min));
                lut[i] = packRGBA(clampByte(r), clampByte(g), clampByte(b), clampByte(a));
            }
            cached = {min, max, lut};
            return lut;
        };
    } else {
        let lut: Uint32Array;
        try {
            lut = buildRampLut(resolveRamp(spec as RampJSON));
        } catch (e) {
            throw styleErrorOf(e);
        }
        lutFor = () => lut;
    }
    return (values: Float32Array[], n: number, ranges: ResolvedStretch[], px: Uint32Array, hidden: Uint8Array | null) => {
        const v = values[0];
        const {min, max} = ranges[0];
        const lut = lutFor(min, max);
        const scale = (LUT_SIZE - 1) / (max - min || 1);
        for (let i = 0; i < n; i++) {
            const x = v[i];
            if (x !== x || (hidden !== null && hidden[i])) { px[i] = TRANSPARENT; continue; }
            const t = (x - min) * scale;
            // Rounded to the nearest entry: truncation shifted every value down by up to one entry.
            let k = t <= 0 ? 0 : t >= LUT_SIZE - 1 ? LUT_SIZE - 1 : (t + 0.5) | 0;
            if (useGamma) k = Math.round(g[k] * (LUT_SIZE - 1) / 255);
            px[i] = lut[k];
        }
    };
}

function styleErrorOf(e: unknown): StyleError {
    if (e instanceof ColorMapError) return new StyleError(e.reason, e.path ? `render.colorMap.${e.path}` : "render.colorMap");
    return new StyleError((e as Error).message, "render.colorMap");
}

/**
 * What a legend shows for a style, as returned by {@link legendOf}; tell the kinds apart by `kind`.
 *
 * @example
 * ```json
 * { "kind": "ramp", "title": "(nir - red) / (nir + red)", "min": -0.2, "max": 0.9, "blend": "smooth",
 *   "gradient": "linear-gradient(to right, #a50026 0%, #ffffbf 50%, #006837 100%)",
 *   "stops": [{ "value": -0.2, "color": "#a50026" }, { "value": 0.35, "color": "#ffffbf" },
 *             { "value": 0.9, "color": "#006837" }] }
 * ```
 *
 * @category Styles
 */
export type Legend =
    /** A ramp over `min..max`: the CSS gradient, and its stops in data units (with labels where the ramp has them). */
    | {
        /** Discriminator: a pseudocolour render with a ramp. */
        kind: "ramp";
        /** Data value at the start of the ramp (the resolved stretch minimum). */
        min: number;
        /** Data value at the end of the ramp (the resolved stretch maximum). */
        max: number;
        /** CSS `linear-gradient(to right, …)` of the ramp, with hard edges when stepped (see {@link cssGradient}). */
        gradient: string;
        /** How the ramp blends between stops. */
        blend: "smooth" | "stepped";
        /** The ramp's stops, sorted, with their positions converted to data values. */
        stops: {
            /** Data value of the stop: `min + position * (max - min)`. */
            value: number;
            /** Colour of the stop, as normalised CSS (`#rrggbb` or `rgba(…)`). */
            color: string;
            /** The stop's label, when it has one. */
            label?: string;
        }[];
        /** The source: band name or expression text. */
        title?: string;
    }
    /** A class table: one entry per class. */
    | {
        /** Discriminator: a pseudocolour render with a class table. */
        kind: "classes";
        /** The table's entries, in table order. */
        entries: {
            /** Colour of the class, as given in the table. */
            color: string;
            /** The entry's label, or its value as text when it has none. */
            label: string;
            /** The data value of the class. */
            value: number;
        }[];
        /** The source: band name or expression text. */
        title?: string;
    }
    /** An RGB composite: what each channel shows and its range. */
    | {
        /** Discriminator: an RGB render. */
        kind: "rgb";
        /** The red, green and blue channels, in that order. */
        channels: {
            /** `"red"`, `"green"` or `"blue"`. */
            name: string;
            /** The channel's source: band name or expression text. */
            source: string;
            /** Data value drawn as 0 (the resolved stretch minimum). */
            min: number;
            /** Data value drawn as full intensity (the resolved stretch maximum). */
            max: number;
        }[];
    }
    /** Function colour maps and custom renders: only the range is known. */
    | {
        /** Discriminator: a {@link ColorFunction} colour map or a custom render. */
        kind: "custom";
        /** Resolved stretch minimum of the (first) source, in data units. */
        min: number;
        /** Resolved stretch maximum of the (first) source, in data units. */
        max: number;
        /** The (first) source: band name or expression text. */
        title?: string;
    };

/**
 * A legend for a style, using the resolved stretch ranges.
 *
 * Pass the same statistics as to {@link CompiledStyle.render}, so the legend matches what is drawn. A pseudocolour
 * render without a colour map gives the black-to-white ramp it is drawn with.
 *
 * @param compiled - A style from {@link compileStyle}.
 * @param stats - Statistics per source, in the order of {@link CompiledStyle.sources}; `null`/`undefined` where not
 *   available (statistic-based stretches then resolve to [0, 1]).
 * @returns The legend: `kind: "rgb"` for RGB renders, `"classes"` for class tables, `"ramp"` for ramps, `"custom"`
 *   for colour functions and custom renders.
 * @throws {@link ColorMapError} only when the ramp of the style was made invalid after compiling.
 *
 * @example
 * ```ts
 * const legend = legendOf(compiled, [stats]);
 * if (legend.kind === "ramp") {
 *     bar.style.background = legend.gradient;
 *     minLabel.textContent = legend.min.toFixed(2);
 *     maxLabel.textContent = legend.max.toFixed(2);
 * }
 * ```
 *
 * @category Styles
 */
export function legendOf(compiled: CompiledStyle, stats: (BandStatistics | null | undefined)[]): Legend {
    const {render} = compiled.style;
    const ranges = compiled.resolveStretches(stats);
    if (render.type === "rgb") {
        return {kind: "rgb", channels: compiled.sources.map((s, i) => ({
            name: ["red", "green", "blue"][i], source: s.key, min: ranges[i].min, max: ranges[i].max,
        }))};
    }
    const title = compiled.sources[0]?.key;
    const {min, max} = ranges[0] ?? {min: 0, max: 1};
    if (render.type === "custom" || typeof render.colorMap === "function") return {kind: "custom", min, max, title};
    const spec = render.colorMap ?? GREY_RAMP;
    if (isColorTable(spec)) {
        return {kind: "classes", title, entries: spec.entries.map((e) => ({color: e.color, value: e.value, label: e.label ?? String(e.value)}))};
    }
    const ramp = resolveRamp(spec);
    return {
        kind: "ramp", min, max, title, blend: ramp.blend, gradient: cssGradient(spec),
        stops: ramp.stops.map((s) => ({value: min + s.position * (max - min), color: s.css, ...(s.label ? {label: s.label} : {})})),
    };
}
