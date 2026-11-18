import {describe, expect, it} from "vitest";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {RasterSamplingMode} from "@luciad/ria/model/tileset/RasterSamplingMode.js";
import {GeoTiffModelError, GeoTiffTileSetModel} from "../src/index.js";
import {chooseImage, elevationTileStructure, interpolate, samplePositions, sampleWindow} from "../src/elevation.js";
import type {RasterGrid} from "../src/geometry.js";
import {decodeElevationPng, openFixture, plane, QUANTISATION, tileHeights} from "./helpers.js";
import {elevationEncoding, encodeLuciadElevationPng, readElevationEncoding} from "../src/luciadElevationPng.js";

const grid: RasterGrid = {width: 300, height: 200, resX: 30, resY: 30, west: 1000000, north: 6000000};

describe("elevation tile structure (pure)", () => {
    it("spans the outer pixel centres and keeps level-0 tiles roughly square", () => {
        const s = elevationTileStructure(grid, 64);
        expect(s.bounds).toEqual([1000015, 8970, 6000000 - 5985, 5970]);
        expect([s.level0Columns, s.level0Rows]).toEqual([2, 1]); // 8970 / 5970 = 1.5 -> 2 columns
        // level 0 spacing: 4485 / 63 = 71 m; 30 m pixels need 2 more levels (17.8 m <= 30 m).
        expect(s.levelCount).toBe(3);
    });

    it("rejects invalid tile sizes and tiny rasters", () => {
        expect(() => elevationTileStructure(grid, 1)).toThrow();
        expect(() => elevationTileStructure({...grid, width: 1}, 64)).toThrow();
    });

    it("places the first and last sample exactly on the tile edges", () => {
        const {xs, ys} = samplePositions({x: 10, y: 20, width: 63, height: 126}, 64);
        expect([xs[0], xs[1], xs[63]]).toEqual([10, 11, 73]);
        expect([ys[0], ys[1], ys[63]]).toEqual([146, 144, 20]); // north to south
    });

    it("chooses the coarsest image that is still fine enough", () => {
        const grids = [30, 60, 120, 240].map((r) => ({...grid, resX: r, resY: r}));
        expect(chooseImage(grids, 10, 10)).toBe(0);
        expect(chooseImage(grids, 100, 100)).toBe(1);
        expect(chooseImage(grids, 240, 240)).toBe(3);
    });

    it("interpolates a plane exactly and re-weights around nodata", () => {
        const g: RasterGrid = {width: 4, height: 3, resX: 1, resY: 1, west: 0, north: 3};
        const f = (x: number, y: number) => 2 * x + 3 * y;
        const values = new Float32Array(12);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) values[r * 4 + c] = f(c + 0.5, 3 - r - 0.5);
        const xs = new Float64Array([0.5, 1.25, 2.9]);
        const ys = new Float64Array([2.5, 1.7, 0.5]);
        const window = sampleWindow(g, xs, ys);
        const out = interpolate(g, window, values, xs, ys, () => false, NaN);
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) expect(out[j * 3 + i]).toBeCloseTo(f(xs[i], ys[j]), 5);

        values[1 * 4 + 1] = -1; // a nodata neighbour: the other three carry the value
        const holed = interpolate(g, window, values, new Float64Array([1.25]), new Float64Array([1.7]), (v) => v === -1, NaN);
        expect(Number.isNaN(holed[0])).toBe(false);
        values.fill(-1);
        const all = interpolate(g, window, values, xs, ys, (v) => v === -1, NaN);
        expect(Array.from(all).every(Number.isNaN)).toBe(true);
    });
});

describe("LuciadElev0 PNG encoding", () => {
    it("uses LuciadFusion's 0.4 m step when the range fits, a wider one otherwise", () => {
        const e = elevationEncoding(1000, 2000);
        expect(e.q - e.p).toBeCloseTo(26213.6, 6);
        expect(e.p).toBeCloseTo(1000 - 26213.6 / 65535, 9); // lowest height -> v = 1
        const wide = elevationEncoding(-11000, 30000);
        expect((30000 - wide.p) / (wide.q - wide.p) * 65535).toBeCloseTo(65535, 6);
    });

    it("produces a standard PNG that decodes back to the heights", () => {
        const heights = new Float32Array(64 * 64).map((_, k) => 1500 + (k % 64) * 3.3 - Math.floor(k / 64) * 1.7);
        heights[100] = NaN;
        const png = encodeLuciadElevationPng(heights, 64, 64);
        const decoded = decodeElevationPng(png);
        expect([decoded.width, decoded.height]).toEqual([64, 64]);
        expect(readElevationEncoding(png)).toEqual({p: decoded.p, q: decoded.q});
        expect(Number.isNaN(decoded.heights[100])).toBe(true);
        for (let k = 0; k < heights.length; k++) {
            if (k !== 100) expect(Math.abs(decoded.heights[k] - heights[k])).toBeLessThanOrEqual(QUANTISATION);
        }
    });

    it("handles tiles without any data and tiles larger than one deflate block", () => {
        const empty = decodeElevationPng(encodeLuciadElevationPng(new Float32Array(16).fill(NaN), 4, 4));
        expect(Array.from(empty.heights).every(Number.isNaN)).toBe(true);
        const big = decodeElevationPng(encodeLuciadElevationPng(new Float32Array(256 * 256).fill(42), 256, 256));
        expect(Math.abs(big.heights[256 * 256 - 1] - 42)).toBeLessThanOrEqual(QUANTISATION);
    });
});

describe("GeoTiffTileSetModel elevation", () => {
    it("exposes a LuciadFusion-like quadtree of 64 x 64 point samples", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        expect(model.dataType).toBe(RasterDataType.ELEVATION);
        expect(model.samplingMode).toBe(RasterSamplingMode.POINT);
        expect(model.reference.identifier).toBe("EPSG:3857");
        expect(model.levelCount).toBe(3);
        expect(model.getTileWidth(0)).toBe(64);
        expect(model.getTileColumnCount(0)).toBe(2);
        expect(model.getTileRowCount(2)).toBe(4);
    });

    it("returns LuciadElev0 PNG heights that match the source surface at every sample", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        for (const tile of [{level: 0, x: 0, y: 0}, {level: 1, x: 3, y: 1}, {level: 2, x: 2, y: 3}]) {
            const heights = await tileHeights(model, tile);
            expect(heights.length).toBe(64 * 64);
            const b = model.getTileBounds(tile);
            const {xs, ys} = samplePositions(b, 64);
            let checked = 0;
            for (let j = 0; j < 64; j++) {
                for (let i = 0; i < 64; i++) {
                    // Skip samples whose interpolation may touch the nodata hole (pixels 120..139 x 80..99):
                    // overview pixels of up to 120 m blend it into ~2 coarse pixels around it.
                    const c = (xs[i] - 1000000) / 30, r = (6000000 - ys[j]) / 30;
                    if (c > 110 && c < 150 && r > 70 && r < 110) continue;
                    expect(Math.abs(heights[j * 64 + i] - plane(xs[i], ys[j]))).toBeLessThanOrEqual(QUANTISATION);
                    checked++;
                }
            }
            expect(checked).toBeGreaterThan(3000);
        }
    });

    it("gives neighbouring tiles identical heights on their shared edge (no seams)", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        const west = await tileHeights(model, {level: 2, x: 1, y: 1});
        const east = await tileHeights(model, {level: 2, x: 2, y: 1});
        const north = await tileHeights(model, {level: 2, x: 1, y: 2});
        // Same interpolated value on both sides; each tile quantises it to its own 0.4 m grid (as LuciadFusion's do).
        for (let j = 0; j < 64; j++) expect(Math.abs(west[j * 64 + 63] - east[j * 64])).toBeLessThanOrEqual(2 * QUANTISATION);
        for (let i = 0; i < 64; i++) expect(Math.abs(west[i] - north[63 * 64 + i])).toBeLessThanOrEqual(2 * QUANTISATION);
    });

    it("delivers nodata as the LuciadElev0 nodata marker, or as elevation.noDataHeight when set", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            elevation: {noDataHeight: -500},
            pool: null,
        });
        // The middle of the hole: pixel (130, 90) -> x = 1003915, y = 5997285, in tile (3, 2) of level 2.
        const tile = {level: 2, x: 3, y: 2};
        const b = model.getTileBounds(tile);
        expect(b.x <= 1003915 && 1003915 <= b.x + b.width && b.y <= 5997285 && 5997285 <= b.y + b.height).toBe(true);
        const heights = await tileHeights(model, tile);
        const {xs, ys} = samplePositions(b, 64);
        const i = xs.findIndex((x) => x >= 1003915);
        const j = ys.findIndex((y) => y <= 5997285);
        expect(Math.abs(heights[j * 64 + i] + 500)).toBeLessThanOrEqual(QUANTISATION);
        expect(Array.from(heights).every((h) => h > -9000)).toBe(true); // the raw -9999 never leaks through

        const byDefault = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        const marked = await tileHeights(byDefault, tile);
        expect(Number.isNaN(marked[j * 64 + i])).toBe(true);           // v = 0 in the PNG
        expect(Array.from(marked).filter(Number.isFinite).every((h) => h > 0)).toBe(true);
    });

    it("rejects a NaN noDataHeight (LuciadRIA discards tiles containing NaN)", async () => {
        await expect(GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {
            dataType: RasterDataType.ELEVATION,
            elevation: {noDataHeight: NaN},
        })).rejects.toBeInstanceOf(RangeError);
    });

    it("converts Int16 with GDAL scale/offset and honours PixelIsPoint", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-4326-int16-scaled.tif"), {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        expect(model.reference.identifier).toBe("EPSG:4326");
        // PixelIsPoint: GDAL writes the first pixel centre as tie point, half a pixel in from the 5.0 / 52.0 corner.
        expect(model.bounds!.x).toBeCloseTo(5.0005, 9);
        expect(model.bounds!.y + model.bounds!.height).toBeCloseTo(51.9995, 9);
        const tile = {level: model.levelCount - 1, x: 0, y: model.getTileRowCount(model.levelCount - 1)! - 1};
        const heights = await tileHeights(model, tile);
        const {xs, ys} = samplePositions(model.getTileBounds(tile), 64);
        for (const [i, j] of [[0, 0], [10, 20], [63, 63]]) {
            const col = (xs[i] - 5.0005) / 0.001, row = (51.9995 - ys[j]) / 0.001;
            // Source stored in 0.1 m steps (Int16 + scale), then LuciadElev0 0.4 m quantisation.
            expect(Math.abs(heights[j * 64 + i] - (100 + 0.01 * col + 0.02 * row))).toBeLessThanOrEqual(QUANTISATION + 0.05);
        }
    });

    it("refuses RGB imagery as elevation with INVALIDELEVATION", async () => {
        const tiff = await openFixture("rgb-3857-uint8.tif");
        await expect(GeoTiffTileSetModel.createFromGeoTIFF(tiff, {dataType: RasterDataType.ELEVATION, elevation: {band: 5}}))
            .rejects.toMatchObject({name: "GeoTiffModelError", cause: "INVALIDELEVATION"});
        await expect(GeoTiffTileSetModel.createFromGeoTIFF(tiff, {dataType: RasterDataType.ELEVATION, elevation: {band: 5}}))
            .rejects.toBeInstanceOf(GeoTiffModelError);
    });
});
