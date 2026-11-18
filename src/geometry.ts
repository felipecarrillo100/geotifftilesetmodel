import type {GeoTIFFImage} from "geotiff";
import {geoKeysOf, tag} from "./tiff.js";

/**
 * Axis-aligned georeferencing of one image (full resolution or overview) of a GeoTIFF, expressed as the
 * outer edges of its pixels ("area" extent) and the size of one pixel. All values are in the units of the
 * GeoTIFF's coordinate reference.
 *
 * Pixel `(i, j)` (column, row; row 0 = north) covers
 * `[west + i*resX, west + (i+1)*resX] x [north - (j+1)*resY, north - j*resY]` and its centre is at
 * `(west + (i+0.5)*resX, north - (j+0.5)*resY)`, whatever the file's raster type.
 */
export interface RasterGrid {
    width: number;
    height: number;
    /** Pixel width (> 0). */
    resX: number;
    /** Pixel height (> 0). */
    resY: number;
    /** Western edge of the first column. */
    west: number;
    /** Northern edge of the first row. */
    north: number;
}

/** Whether the image declares `RasterPixelIsPoint`: raster coordinate (0,0) is then the centre of the first pixel. */
export function isPixelIsPoint(image: GeoTIFFImage): boolean {
    return geoKeysOf(image).GTRasterTypeGeoKey === 2;
}

/**
 * Georeferencing of the full-resolution image.
 *
 * Unlike geotiff.js' `getOrigin()` this honours the raster position of the tie point and the
 * `RasterPixelIsPoint` convention, so the returned grid always describes pixel edges.
 * Returns `null` when the image has no affine georeferencing.
 */
export function gridOfMainImage(image: GeoTIFFImage): RasterGrid | null {
    const fd = {
        ModelTiepoint: tag<number[]>(image, "ModelTiepoint"),
        ModelPixelScale: tag<number[]>(image, "ModelPixelScale"),
        ModelTransformation: tag<number[]>(image, "ModelTransformation"),
    };
    let resX: number, resY: number, x0: number, y0: number;
    if (fd.ModelTransformation && fd.ModelTransformation.length >= 8) {
        const t = fd.ModelTransformation;
        // Rotation terms (t[1], t[4]) are not supported: LuciadRIA tile structures are axis aligned.
        resX = Math.abs(t[0]);
        resY = Math.abs(t[5]);
        x0 = t[3];
        y0 = t[7];
    } else if (fd.ModelTiepoint && fd.ModelTiepoint.length >= 6 && fd.ModelPixelScale) {
        const [i, j, , x, y] = fd.ModelTiepoint;
        resX = Math.abs(fd.ModelPixelScale[0]);
        resY = Math.abs(fd.ModelPixelScale[1]);
        // Model coordinate of raster coordinate (0, 0).
        x0 = x - i * resX;
        y0 = y + j * resY;
    } else {
        return null;
    }
    if (!(resX > 0) || !(resY > 0)) {
        return null;
    }
    if (isPixelIsPoint(image)) {
        // Raster coordinate (0,0) is the centre of the first pixel: move to its outer corner.
        x0 -= resX / 2;
        y0 += resY / 2;
    }
    return {width: image.getWidth(), height: image.getHeight(), resX, resY, west: x0, north: y0};
}

/** Georeferencing of an overview: same extent as the main image, divided over the overview's pixels. */
export function gridOfOverview(main: RasterGrid, overview: GeoTIFFImage): RasterGrid {
    const width = overview.getWidth();
    const height = overview.getHeight();
    return {
        width,
        height,
        resX: (main.width * main.resX) / width,
        resY: (main.height * main.resY) / height,
        west: main.west,
        north: main.north,
    };
}

/** Outer pixel edges as `[minX, minY, maxX, maxY]`. */
export function areaExtent(grid: RasterGrid): [number, number, number, number] {
    return [grid.west, grid.north - grid.height * grid.resY, grid.west + grid.width * grid.resX, grid.north];
}

/** Extent through the centres of the outer pixels as `[minX, minY, maxX, maxY]`: where point samples exist. */
export function centreExtent(grid: RasterGrid): [number, number, number, number] {
    const [minX, minY, maxX, maxY] = areaExtent(grid);
    return [minX + grid.resX / 2, minY + grid.resY / 2, maxX - grid.resX / 2, maxY - grid.resY / 2];
}

/** Continuous pixel coordinate of model x: 0 = centre of column 0. */
export function columnOf(grid: RasterGrid, x: number): number {
    return (x - grid.west) / grid.resX - 0.5;
}

/** Continuous pixel coordinate of model y: 0 = centre of row 0 (the northern row). */
export function rowOf(grid: RasterGrid, y: number): number {
    return (grid.north - y) / grid.resY - 0.5;
}
