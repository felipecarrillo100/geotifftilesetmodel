import {centreExtent, columnOf, RasterGrid, rowOf} from "./geometry.js";

/**
 * Elevation tiles are delivered to LuciadRIA the way LuciadFusion's LTS elevation coverages are:
 *
 * - a quadtree (each level doubles the tile count per axis) with `tileSize x tileSize` samples per tile
 *   (64 by default, like LuciadFusion);
 * - point sampling ({@link RasterSamplingMode.POINT}): the samples of a tile span its bounds edge to edge,
 *   sample `j` of a tile with bounds `[x0, x0 + w]` lies at `x0 + j * w / (tileSize - 1)`. Neighbouring
 *   tiles therefore share the samples on their common edge, which keeps the terrain free of seams;
 * - heights as 32-bit floats, row 0 = northern edge of the tile.
 *
 * The values are interpolated (bilinear) from the most suitable image of the COG (full resolution or
 * overview), so the COG itself can use any tile size and any overview layout.
 */

/** Default number of samples along each side of an elevation tile (LuciadFusion uses 64).
 *
 * @category Model */
export const DEFAULT_ELEVATION_TILE_SIZE = 64;

/** Layout of an elevation quadtree, as computed by {@link elevationTileStructure}.
 *
 * @category Model */
export interface ElevationTileStructure {
    /** Bounds `[x, width, y, height]` of the tile set: through the centres of the outer pixels. */
    bounds: [number, number, number, number];
    /** Number of tile columns at level 0. */
    level0Columns: number;
    /** Number of tile rows at level 0. */
    level0Rows: number;
    /** Number of levels; each level doubles the tile count per axis. */
    levelCount: number;
    /** Number of samples along each side of a tile. */
    tileSize: number;
}

/**
 * Quadtree that covers the elevation data with point samples.
 *
 * The bounds go through the centres of the outer pixels, so every sample of every tile falls inside the
 * data (no extrapolation at the borders). Level 0 has 1 tile along the shorter axis and as many as needed to
 * keep tiles roughly square along the longer one. The deepest level is the first whose sample spacing is at
 * least as fine as the full-resolution pixels.
 *
 * @param main grid of the full-resolution image
 * @param tileSize number of samples along each side of a tile, an integer >= 2. Default
 *   {@link DEFAULT_ELEVATION_TILE_SIZE}.
 * @returns the bounds, level 0 tile counts and number of levels of the quadtree
 * @throws `RangeError` when `tileSize` is not an integer >= 2
 * @throws `Error` when the image has fewer than 2 x 2 pixels
 *
 * @category Model
 */
export function elevationTileStructure(main: RasterGrid, tileSize = DEFAULT_ELEVATION_TILE_SIZE): ElevationTileStructure {
    if (!Number.isInteger(tileSize) || tileSize < 2) {
        throw new RangeError(`elevation.tileSize must be an integer >= 2, got ${tileSize}`);
    }
    if (main.width < 2 || main.height < 2) {
        throw new Error(`Elevation needs at least 2 x 2 pixels, got ${main.width} x ${main.height}`);
    }
    const [minX, minY, maxX, maxY] = centreExtent(main);
    const width = maxX - minX;
    const height = maxY - minY;
    const aspect = width / height;
    const level0Columns = aspect >= 1 ? Math.max(1, Math.round(aspect)) : 1;
    const level0Rows = aspect >= 1 ? 1 : Math.max(1, Math.round(1 / aspect));
    const spacingX0 = width / level0Columns / (tileSize - 1);
    const spacingY0 = height / level0Rows / (tileSize - 1);
    const deepest = Math.max(
        0,
        Math.ceil(Math.log2(spacingX0 / main.resX) - 1e-9),
        Math.ceil(Math.log2(spacingY0 / main.resY) - 1e-9),
    );
    return {bounds: [minX, width, minY, height], level0Columns, level0Rows, levelCount: deepest + 1, tileSize};
}

/**
 * Index of the image to sample for a given sample spacing: the coarsest image whose pixels are still at least as
 * fine as the spacing (falls back to the finest image). `grids` must be ordered from finest to coarsest.
 *
 * @param grids grids of the images, finest (full resolution) first
 * @param spacingX distance between samples along x, in reference units
 * @param spacingY distance between samples along y, in reference units
 * @returns the index in `grids` of the image to read
 *
 * @category Model
 */
export function chooseImage(grids: RasterGrid[], spacingX: number, spacingY: number): number {
    let chosen = 0;
    for (let k = 1; k < grids.length; k++) {
        if (grids[k].resX <= spacingX * (1 + 1e-9) && grids[k].resY <= spacingY * (1 + 1e-9)) {
            chosen = k;
        }
    }
    return chosen;
}

/**
 * Sample positions of a tile: x from west to east, y from north to south, spanning the tile edge to edge.
 *
 * @param tileBounds bounds of the tile, in reference units
 * @param tileSize number of samples along each side
 * @returns `xs` and `ys`, `tileSize` coordinates each; the last sample lies exactly on the east / south edge
 *
 * @category Model
 */
export function samplePositions(tileBounds: { x: number; y: number; width: number; height: number }, tileSize: number) {
    const xs = new Float64Array(tileSize);
    const ys = new Float64Array(tileSize);
    const n = tileSize - 1;
    for (let k = 0; k < tileSize; k++) {
        xs[k] = tileBounds.x + (k * tileBounds.width) / n;
        ys[k] = tileBounds.y + tileBounds.height - (k * tileBounds.height) / n;
    }
    // Pin the last sample exactly on the edge, so neighbouring tiles agree to the last bit.
    xs[n] = tileBounds.x + tileBounds.width;
    ys[n] = tileBounds.y;
    return {xs, ys};
}

/**
 * Pixel window holding every pixel that {@link interpolate} needs for the given samples.
 *
 * @param grid grid of the image that is read
 * @param xs sample x coordinates, in reference units
 * @param ys sample y coordinates, in reference units
 * @returns `[left, top, right, bottom]` in pixels of the image (right/bottom exclusive), clamped to the image
 *
 * @category Model
 */
export function sampleWindow(grid: RasterGrid, xs: Float64Array, ys: Float64Array): [number, number, number, number] {
    const clampC = (c: number) => Math.min(Math.max(c, 0), grid.width - 1);
    const clampR = (r: number) => Math.min(Math.max(r, 0), grid.height - 1);
    const c0 = clampC(columnOf(grid, Math.min(xs[0], xs[xs.length - 1])));
    const c1 = clampC(columnOf(grid, Math.max(xs[0], xs[xs.length - 1])));
    const r0 = clampR(rowOf(grid, Math.max(ys[0], ys[ys.length - 1])));
    const r1 = clampR(rowOf(grid, Math.min(ys[0], ys[ys.length - 1])));
    // interpolate() blends pixel pairs (p0, p0 + 1) with p0 <= size - 2, also when extrapolating past the last
    // pixel centre: the window must start early enough to hold the pair even if all samples are in the last column.
    const left = Math.max(0, Math.min(Math.floor(c0), grid.width - 2));
    const top = Math.max(0, Math.min(Math.floor(r0), grid.height - 2));
    const right = Math.min(Math.floor(c1) + 1, grid.width - 1) + 1;
    const bottom = Math.min(Math.floor(r1) + 1, grid.height - 1) + 1;
    return [left, top, right, bottom];
}

/**
 * Interpolation coordinates along one axis: the two pixels to blend and the weight of the second.
 *
 * Inside the outer pixel centres this is plain linear interpolation. Up to half a pixel beyond them (the border of
 * the data, reached when sampling a coarser overview) it extrapolates the slope of the two outer pixels instead of
 * flattening it, so every level of the tile set agrees at the data border. Further out it clamps.
 */
function axisCoordinate(p: number, size: number): { p0: number; p1: number; f: number } {
    if (size === 1) return {p0: 0, p1: 0, f: 0};
    const clamped = Math.min(Math.max(p, -0.5), size - 0.5);
    const p0 = Math.min(Math.max(Math.floor(clamped), 0), size - 2);
    return {p0, p1: p0 + 1, f: clamped - p0};
}

/**
 * Bilinear interpolation of point samples, skipping nodata.
 *
 * Positions up to half a pixel beyond the outer pixel centres are extrapolated linearly (see `axisCoordinate`),
 * positions further out are clamped. Where some of the 4 neighbours are nodata, the remaining ones are re-weighted
 * (extrapolation then falls back to the nearest valid pixel); where all 4 are nodata the output is `nodataOut`.
 *
 * @param grid grid of the image the values were read from
 * @param window the pixel window the values cover, as returned by {@link sampleWindow}
 * @param values raster values of `window`, row-major, row 0 = north
 * @param xs sample x coordinates, west to east
 * @param ys sample y coordinates, north to south
 * @param isNoData returns true for values that must be ignored (NaN is always ignored)
 * @param nodataOut value written where no valid pixel is available
 * @returns the interpolated values, `xs.length * ys.length` of them, row-major with row 0 = north
 *
 * @category Model
 */
export function interpolate(
    grid: RasterGrid,
    window: [number, number, number, number],
    values: ArrayLike<number>,
    xs: Float64Array,
    ys: Float64Array,
    isNoData: (v: number) => boolean,
    nodataOut: number,
): Float32Array {
    const [left, top, right, bottom] = window;
    const winW = right - left;
    const winH = bottom - top;
    const out = new Float32Array(xs.length * ys.length);
    const cols = new Int32Array(xs.length * 2);
    const fx = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
        const {p0, p1, f} = axisCoordinate(columnOf(grid, xs[i]), grid.width);
        cols[2 * i] = Math.min(Math.max(p0 - left, 0), winW - 1);
        cols[2 * i + 1] = Math.min(Math.max(p1 - left, 0), winW - 1);
        fx[i] = f;
    }
    const valid = (v: number) => !(v !== v || isNoData(v)); // v !== v: NaN
    let o = 0;
    for (let j = 0; j < ys.length; j++) {
        const {p0: r0, p1: r1, f: fy} = axisCoordinate(rowOf(grid, ys[j]), grid.height);
        const row0 = Math.min(Math.max(r0 - top, 0), winH - 1) * winW;
        const row1 = Math.min(Math.max(r1 - top, 0), winH - 1) * winW;
        for (let i = 0; i < xs.length; i++) {
            const a = cols[2 * i], b = cols[2 * i + 1], u = fx[i];
            const v00 = values[row0 + a], v10 = values[row0 + b], v01 = values[row1 + a], v11 = values[row1 + b];
            const ok00 = valid(v00), ok10 = valid(v10), ok01 = valid(v01), ok11 = valid(v11);
            const extrapolating = u < 0 || u > 1 || fy < 0 || fy > 1;
            if (ok00 && ok10 && ok01 && ok11) {
                out[o++] = v00 * (1 - u) * (1 - fy) + v10 * u * (1 - fy) + v01 * (1 - u) * fy + v11 * u * fy;
                continue;
            }
            // Some neighbours are nodata: re-weight the valid ones (inside the data only, weights are then >= 0).
            const uu = Math.min(Math.max(u, 0), 1), vv = Math.min(Math.max(fy, 0), 1);
            const w00 = (1 - uu) * (1 - vv), w10 = uu * (1 - vv), w01 = (1 - uu) * vv, w11 = uu * vv;
            let sum = 0, weight = 0;
            if (ok00) { sum += v00 * w00; weight += w00; }
            if (ok10) { sum += v10 * w10; weight += w10; }
            if (ok01) { sum += v01 * w01; weight += w01; }
            if (ok11) { sum += v11 * w11; weight += w11; }
            if (weight > 1e-12 && !extrapolating) {
                out[o++] = sum / weight;
            } else {
                // On a pixel whose neighbours are nodata, at the data border, or all four nodata: nearest valid.
                const nearest = uu < 0.5 ? (vv < 0.5 ? v00 : v01) : (vv < 0.5 ? v10 : v11);
                out[o++] = valid(nearest) ? nearest : weight > 1e-12 ? sum / weight : nodataOut;
            }
        }
    }
    return out;
}
