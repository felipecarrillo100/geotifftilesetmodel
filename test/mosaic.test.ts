import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffReadError, GeoTiffTileSetModel} from "../src/index.js";
import {samplePositions} from "../src/elevation.js";
import {plane, QUANTISATION, startRangeServer, tileHeights} from "./helpers.js";

describe("create: one elevation model over several COGs (mosaic)", () => {
    let server: Awaited<ReturnType<typeof startRangeServer>>;
    beforeAll(async () => { server = await startRangeServer(); });
    afterAll(async () => { await server.close(); });

    const halves = () => [`${server.url}/elevation-3857-float32-west.tif`, `${server.url}/elevation-3857-float32-east.tif`];
    const mosaicOf = (urls: string[], options: { onReadError?: (e: GeoTiffReadError) => void } = {}) => GeoTiffTileSetModel.create({
        inputs: urls.map((url) => ({url})), dataType: RasterDataType.ELEVATION, pool: null, ...options,
    });

    it("covers the union of the files with the single-file structure", async () => {
        const mosaic = await mosaicOf(halves());
        const single = await GeoTiffTileSetModel.create({
            url: `${server.url}/elevation-3857-float32.tif`,
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        const [m, s] = [mosaic.bounds!, single.bounds!];
        expect([m.x, m.width, m.y, m.height]).toEqual([s.x, s.width, s.y, s.height]);
        expect(mosaic.levelCount).toBe(single.levelCount);
    });

    it("makes unnamed single-band files one mosaic band, and keeps explicit names", async () => {
        expect((await mosaicOf(halves())).getBandNames()).toEqual(["elevation"]);
        const named = await GeoTiffTileSetModel.create({
            inputs: halves().map((url) => ({url, bands: "height"})), dataType: RasterDataType.ELEVATION, pool: null,
        });
        expect(named.getBandNames()).toEqual(["height"]);
        // Imagery keeps one band per file: f1_b1, f2_b1 (no implicit mosaic).
        const imagery = await GeoTiffTileSetModel.create({inputs: halves().map((url) => ({url})), pool: null,
            style: {render: {type: "pseudocolor", band: "f1_b1", stretch: [0, 1000]}}});
        expect(imagery.getBandNames()).toEqual(["f1_b1", "f2_b1"]);
    });

    it("reads every sample from the file that covers it, seamlessly across the files' border", async () => {
        const mosaic = await mosaicOf(halves());
        // Tiles at every level, including ones that straddle the border at x = 1000000 + 150 * 30.
        for (const tile of [{level: 0, x: 0, y: 0}, {level: 0, x: 1, y: 0}, {level: 1, x: 1, y: 0}, {level: 2, x: 3, y: 1}, {level: 2, x: 4, y: 2}]) {
            const heights = await tileHeights(mosaic, tile);
            const {xs, ys} = samplePositions(mosaic.getTileBounds(tile), 64);
            let checked = 0;
            for (let j = 0; j < 64; j++) {
                for (let i = 0; i < 64; i++) {
                    const c = (xs[i] - 1000000) / 30, r = (6000000 - ys[j]) / 30;
                    if (c > 110 && c < 150 && r > 70 && r < 110) continue;
                    expect(Math.abs(heights[j * 64 + i] - plane(xs[i], ys[j]))).toBeLessThanOrEqual(QUANTISATION);
                    checked++;
                }
            }
            expect(checked).toBeGreaterThan(3000);
        }
    });

    /** Makes images of the west file throw like a damaged block ("Offset is outside the bounds of the DataView"). */
    function breakWestImages(model: GeoTiffTileSetModel, which: (index: number) => boolean) {
        const files = (model as unknown as { _files: { grids: { west: number }[]; images: { readRasters: unknown }[] }[] })._files;
        const west = files.find((f) => f.grids[0].west === 1000000)!;
        west.images.forEach((image, index) => {
            if (which(index)) {
                image.readRasters = () => Promise.reject(new RangeError("Offset is outside the bounds of the DataView"));
            }
        });
    }

    it("falls back to a more detailed image when an overview of a file is damaged", async () => {
        const mosaic = await mosaicOf(halves());
        breakWestImages(mosaic, (index) => index > 0); // only the full-resolution image of the west file still reads
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const tile = {level: 0, x: 0, y: 0};
        const heights = await tileHeights(mosaic, tile);
        const {xs, ys} = samplePositions(mosaic.getTileBounds(tile), 64);
        for (const [i, j] of [[0, 0], [20, 30], [63, 63]]) {
            expect(Math.abs(heights[j * 64 + i] - plane(xs[i], ys[j]))).toBeLessThanOrEqual(QUANTISATION);
        }
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toMatch(/using a more detailed image/);
        warn.mockRestore();
    });

    it("keeps the other files when a file cannot be read at all", async () => {
        const mosaic = await mosaicOf(halves());
        breakWestImages(mosaic, () => true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        // Level 0 has two tiles: x = 0 lies in the (unreadable) west file, x = 1 in the east file. Both succeed.
        const westHeights = await tileHeights(mosaic, {level: 0, x: 0, y: 0});
        // Every sample is nodata except the last column, which lies on the border and is also covered by the east file.
        for (let j = 0; j < 64; j++) {
            for (let i = 0; i < 63; i++) expect(Number.isNaN(westHeights[j * 64 + i])).toBe(true);
            expect(Number.isNaN(westHeights[j * 64 + 63])).toBe(false);
        }
        const eastTile = {level: 0, x: 1, y: 0};
        const eastHeights = await tileHeights(mosaic, eastTile);
        const {xs, ys} = samplePositions(mosaic.getTileBounds(eastTile), 64);
        for (const [i, j] of [[0, 0], [10, 30], [63, 63]]) {
            expect(Math.abs(eastHeights[j * 64 + i] - plane(xs[i], ys[j]))).toBeLessThanOrEqual(QUANTISATION);
        }
        expect(warn.mock.calls.some((c) => /shown as no data/.test(String(c[0])))).toBe(true);
        warn.mockRestore();
    });

    it("reports read problems to listeners as GeoTiffReadError (and not on the console)", async () => {
        const received: GeoTiffReadError[] = [];
        const mosaic = await mosaicOf(halves(), {onReadError: (e) => received.push(e)});
        const viaMethod: GeoTiffReadError[] = [];
        const handle = mosaic.addReadErrorListener((e) => viaMethod.push(e));
        breakWestImages(mosaic, () => true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await tileHeights(mosaic, {level: 0, x: 0, y: 0});
        await tileHeights(mosaic, {level: 0, x: 0, y: 0}); // reported once per file and image
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();

        expect(received.length).toBeGreaterThan(0);
        expect(viaMethod.length).toBe(received.length);
        const last = received[received.length - 1];
        expect(last).toBeInstanceOf(GeoTiffReadError);
        expect(last).toMatchObject({cause: "READ_FAILED", fileIndex: 0, image: 0, recovery: "nodata"});
        expect(last.url).toMatch(/elevation-3857-float32-west\.tif$/);
        expect(received[0].recovery).toBe("finerImage");
        expect(String((last.originalError as Error).message)).toMatch(/DataView/);
        expect(new Set(received.map((e) => `${e.fileIndex}/${e.image}`)).size).toBe(received.length);
        handle.remove();
    });

    it("rejects files in different references", async () => {
        await expect(mosaicOf([`${server.url}/elevation-3857-float32-west.tif`, `${server.url}/elevation-4326-int16-scaled.tif`]))
            .rejects.toMatchObject({cause: "REFERENCE_MISMATCH"});
    });
});
