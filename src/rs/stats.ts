/**
 * Statistics for contrast stretching: min/max, mean/standard deviation, histograms and percentiles.
 *
 * A model computes statistics once per value source from a coarse sample: a grid of at most `statisticsSize`
 * (default 512) points along the longer side of the data extent, read from the overview that matches the grid
 * spacing. This is how TiTiler, QGIS ("estimated" accuracy) and GDAL (`-approx_stats`) do it: percentiles from an
 * overview are within a fraction of a percent of the full-resolution values for imagery, at a tiny fraction of
 * the cost.
 *
 * All values are in the data units of the band or expression they describe.
 *
 * @module
 */

/**
 * Statistics of one band or expression. JSON-serialisable, so it can be cached or stored next to a style.
 *
 * Produced by {@link computeStatistics} and consumed by {@link percentile} and {@link resolveStretch}.
 *
 * @example
 * A value with a 4-bin histogram (the default is 256 bins):
 * ```json
 * { "count": 1000, "min": -0.12, "max": 0.88, "mean": 0.41, "std": 0.18,
 *   "histogram": { "min": -0.12, "max": 0.88, "counts": [50, 250, 500, 200] } }
 * ```
 *
 * @category Statistics
 */
export interface BandStatistics {
    /** Number of valid (non-NaN) values. */
    count: number;
    /** Smallest valid value, in data units. */
    min: number;
    /** Largest valid value, in data units. */
    max: number;
    /** Arithmetic mean of the valid values, in data units. */
    mean: number;
    /** Population standard deviation of the valid values (divides by `count`, not `count - 1`), in data units. */
    std: number;
    /**
     * Histogram with equal-width bins spanning [min, max]. Bin `i` covers `[min + i * w, min + (i + 1) * w)` with
     * `w = (max - min) / counts.length`; the maximum itself is counted in the last bin.
     */
    histogram: {
        /** Lower edge of the first bin (the same as the statistics' `min`). */
        min: number;
        /** Upper edge of the last bin (the same as the statistics' `max`). */
        max: number;
        /** Number of valid values in each bin; its length is the bin count. When min equals max, all values are in bin 0. */
        counts: number[];
    };
}

/**
 * Computes statistics over the valid (finite) values of an array.
 *
 * NaN marks missing data and is skipped; so are `+Infinity` and `-Infinity` (for example a ratio divided by zero),
 * which would make `min`, `max`, `mean`, `std` and the histogram meaningless.
 *
 * @param values - The values, for example a band or expression evaluated over an overview. NaN and infinite values
 *   are ignored.
 * @param bins - Number of histogram bins (a positive integer). Default 256. More bins make {@link percentile} more
 *   precise.
 * @returns The statistics, or `null` when there are no valid values (empty array, or all NaN or infinite).
 *
 * @example
 * ```ts
 * const stats = computeStatistics(new Float32Array([0.1, 0.2, NaN, 0.4]));
 * // stats.count === 3, stats.min ≈ 0.1, stats.max ≈ 0.4, stats.histogram.counts.length === 256
 * ```
 *
 * @category Statistics
 */
export function computeStatistics(values: ArrayLike<number>, bins = 256): BandStatistics | null {
    let count = 0, min = Infinity, max = -Infinity, sum = 0, sum2 = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        count++;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        sum2 += v * v;
    }
    if (count === 0) return null;
    const mean = sum / count;
    const std = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
    const counts = new Array<number>(bins).fill(0);
    const scale = max > min ? bins / (max - min) : 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        counts[Math.min(bins - 1, Math.floor((v - min) * scale))]++;
    }
    return {count, min, max, mean, std, histogram: {min, max, counts}};
}

/**
 * Approximate percentile (0..100) from the histogram, interpolated within the bin.
 *
 * The value is interpolated linearly inside the bin that contains the requested rank, so the error is at most one
 * bin width (`(max - min) / bins`).
 *
 * @param stats - Statistics from {@link computeStatistics}.
 * @param p - The percentile, 0..100 (values outside are clamped): 2 gives the value below which about 2 % of the
 *   valid values lie.
 * @returns The estimated value in data units, within [`stats.min`, `stats.max`]. When all values are equal
 *   (`max <= min`), returns `stats.min`.
 *
 * @example
 * ```ts
 * const stats = computeStatistics(values)!;
 * const low = percentile(stats, 2), high = percentile(stats, 98);
 * ```
 *
 * @category Statistics
 */
export function percentile(stats: BandStatistics, p: number): number {
    const {min, max, counts} = stats.histogram;
    if (max <= min) return min;
    const target = Math.min(100, Math.max(0, p)) / 100 * stats.count;
    const width = (max - min) / counts.length;
    let cumulative = 0;
    for (let i = 0; i < counts.length; i++) {
        const next = cumulative + counts[i];
        if (next >= target && counts[i] > 0) {
            return min + (i + (target - cumulative) / counts[i]) * width;
        }
        cumulative = next;
    }
    return max;
}

/**
 * How to map data values to the 0..1 display range: the range minimum is drawn as 0, the maximum as 1, values in
 * between linearly, and values outside are clamped.
 *
 * Every form except `fixed` and the `[min, max]` shorthand needs {@link BandStatistics}; until statistics are
 * available, {@link resolveStretch} uses a fallback range. Ranges are in the data units of the band or expression.
 *
 * @example
 * ```json
 * [-0.2, 0.9]
 * { "type": "fixed", "min": 0, "max": 3000 }
 * { "type": "percentile", "low": 2, "high": 98 }
 * { "type": "minmax" }
 * { "type": "stddev", "n": 2.5 }
 * ```
 *
 * @category Statistics
 */
export type StretchSpec =
    /** A fixed range in data units. */
    | {
        /** Discriminator: a fixed range. */
        type: "fixed";
        /** Data value drawn as 0. */
        min: number;
        /** Data value drawn as 1. */
        max: number;
    }
    /** Percent clip (ArcGIS default 2–98 %, QGIS cumulative cut). */
    | {
        /** Discriminator: a percent clip, computed with {@link percentile}. */
        type: "percentile";
        /** Lower percentile (0..100), drawn as 0. Default 2. */
        low?: number;
        /** Upper percentile (0..100), drawn as 1. Default 98. */
        high?: number;
    }
    /** The full range of the data: the statistics' min and max. */
    | {
        /** Discriminator: the data's own min and max. */
        type: "minmax";
    }
    /** Mean ± n standard deviations (ArcGIS default n = 2), clamped to the data's min and max. */
    | {
        /** Discriminator: mean ± n standard deviations. */
        type: "stddev";
        /** Number of standard deviations on each side of the mean. Default 2. */
        n?: number;
    }
    /** Shorthand for fixed: `[min, max]` in data units. */
    | [number, number];

/** A stretch reduced to a range, plus whether it came from statistics. Returned by {@link resolveStretch}.
 *
 * @category Statistics */
export interface ResolvedStretch {
    /** Data value drawn as 0, in data units. */
    min: number;
    /** Data value drawn as 1, in data units. */
    max: number;
    /**
     * True when the range was computed from statistics; false for fixed ranges and for the fallback used while
     * statistics are not available, so a caller can tell a provisional range from a final one.
     */
    fromStatistics: boolean;
}

/**
 * Whether a stretch needs statistics: true for `percentile`, `minmax` and `stddev`; false for `fixed`, the
 * `[min, max]` shorthand and `undefined`.
 *
 * @param spec - The stretch, or `undefined`.
 * @returns Whether {@link resolveStretch} needs statistics to resolve `spec`.
 *
 * @category Statistics
 */
export function stretchNeedsStatistics(spec: StretchSpec | undefined): boolean {
    return !!spec && !Array.isArray(spec) && spec.type !== "fixed";
}

/**
 * Resolves a stretch to a [min, max] range. Statistic-based stretches fall back to `fallback` (or [0, 1]) while
 * statistics are not available.
 *
 * - `undefined`: `fallback`.
 * - `[min, max]` and `fixed`: as given (not validated).
 * - `minmax`: `stats.min`..`stats.max`.
 * - `percentile`: the {@link percentile}s `low` (default 2) and `high` (default 98).
 * - `stddev`: `mean ± n * std` (default n = 2), clamped to `stats.min`..`stats.max`.
 *
 * A range computed from statistics is never empty: when it would be (constant data), `max` is set to
 * `min + |min| * 1e-6`, or `min + 1e-6` when `min` is 0.
 *
 * @param spec - The stretch; `undefined` resolves to `fallback`.
 * @param stats - Statistics of the values being stretched, or `null`/`undefined` when not (yet) available.
 * @param fallback - Range used when `spec` is undefined, or needs statistics and `stats` is missing. Default `[0, 1]`.
 * @returns The range in data units; `fromStatistics` is true only when it was computed from `stats`.
 *
 * @example
 * ```ts
 * resolveStretch([-0.2, 0.9], null);                     // {min: -0.2, max: 0.9, fromStatistics: false}
 * resolveStretch({type: "percentile"}, null, [0, 3000]); // {min: 0, max: 3000, fromStatistics: false}
 * resolveStretch({type: "stddev", n: 2}, computeStatistics(values)); // mean ± 2 std, fromStatistics: true
 * ```
 *
 * @category Statistics
 */
export function resolveStretch(
    spec: StretchSpec | undefined,
    stats: BandStatistics | null | undefined,
    fallback: [number, number] = [0, 1],
): ResolvedStretch {
    if (!spec) return {min: fallback[0], max: fallback[1], fromStatistics: false};
    if (Array.isArray(spec)) return {min: spec[0], max: spec[1], fromStatistics: false};
    if (spec.type === "fixed") return {min: spec.min, max: spec.max, fromStatistics: false};
    if (!stats) return {min: fallback[0], max: fallback[1], fromStatistics: false};
    let min: number, max: number;
    switch (spec.type) {
        case "minmax":
            min = stats.min; max = stats.max; break;
        case "percentile":
            min = percentile(stats, spec.low ?? 2); max = percentile(stats, spec.high ?? 98); break;
        case "stddev": {
            const n = spec.n ?? 2;
            min = Math.max(stats.min, stats.mean - n * stats.std);
            max = Math.min(stats.max, stats.mean + n * stats.std);
            break;
        }
    }
    if (!(max > min)) max = min + (Math.abs(min) * 1e-6 || 1e-6);
    return {min, max, fromStatistics: true};
}
