import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffTileSetModel, PixelMeaningEnum} from "../src/index.js";
import {resolveBandMapping} from "../src/bandstorgb.js";
import {referenceIdentifierFromGeoKeys} from "../src/utils.js";
import {withRequestParameters} from "../src/fileutils.js";
import {openFixture, startRangeServer, tileData} from "./helpers.js";

describe("imagery", () => {
    it("serves an RGB COG level by level, full resolution last", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("rgb-3857-uint8.tif"), {pool: null});
        expect(model.dataType).toBe(RasterDataType.IMAGE);
        expect(model.levelCount).toBe(2); // 64x48 overview + 128x96 image
        expect(model.getTileColumnCount(1)).toBe(2);
        const data = await tileData(model, {level: 1, x: 1, y: 1});
        expect(data.pixelFormat).toBe(PixelFormat.RGB_888);
        const px = new Uint8Array(data.data as ArrayBuffer);
        expect(px.length).toBe(64 * 64 * 3);
        // Top-left pixel of the top-right tile: column 64 -> red 128, row 0 -> green 0, blue 77.
        expect([px[0], px[1], px[2]]).toEqual([128, 0, 77]);
    });

    it("makes the part of partial edge tiles beyond the image transparent", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("rgb-3857-uint8.tif"), {pool: null});
        // The image is 96 rows high: the bottom tile row (y = 0) only has 32 rows of data.
        const data = await tileData(model, {level: 1, x: 0, y: 0});
        expect(data.pixelFormat).toBe(PixelFormat.RGBA_8888);
        const px = new Uint8Array(data.data as ArrayBuffer);
        expect(px[(10 * 64) * 4 + 3]).toBe(255); // row 10 is inside the image
        expect(px[(40 * 64) * 4 + 3]).toBe(0);   // row 40 is beyond it
    });

    it("renders single-band data without nodata as RGB_888 with 3 bytes per pixel", async () => {
        // Regression: a missing GDAL nodata (null) produced 4-byte pixels declared as RGB_888.
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("gray-3857-uint16.tif"), {pool: null});
        expect(model.getNodata()).toBeNull();
        const data = await tileData(model, {level: 1, x: 0, y: 1});
        expect(data.pixelFormat).toBe(PixelFormat.RGB_888);
        expect((data.data as ArrayBuffer).byteLength).toBe(64 * 64 * 3);
    });

    it("reports file information", async () => {
        const model = await GeoTiffTileSetModel.createFromGeoTIFF(await openFixture("elevation-3857-float32.tif"), {pool: null});
        const info = model.getModelInfo();
        expect(info).toMatchObject({
            width: 300, height: 200, tileWidth: 64, tileHeight: 64, bands: 1, isCog: true,
            crsName: "EPSG:3857", pixelMeaning: PixelMeaningEnum.Grayscale32, pixelFormat: PixelFormat.FLOAT_32,
            canBeElevation: true,
        });
    });
});

describe("colour models", () => {
    it("treats YCbCr (JPEG orthophotos) as RGB so readRGB converts it", async () => {
        const {analyzePixelFormat, canRepresentElevation} = await import("../src/utils.js");
        const fake = {
            getSamplesPerPixel: () => 3, getBytesPerPixel: () => 3, getBitsPerSample: () => 8, getSampleFormat: () => 1,
            fileDirectory: {getValue: (name: string) => (name === "PhotometricInterpretation" ? 6 : undefined)},
        } as never;
        expect(analyzePixelFormat(fake)).toEqual({meaning: PixelMeaningEnum.RGB, format: PixelFormat.RGB_888});
        expect(canRepresentElevation(fake)).toBe(false);
    });
});

describe("helpers", () => {
    it("accepts the deprecated isRGB alias in band mappings", () => {
        expect(resolveBandMapping({isRGB: true, red: 2}).rgb).toBe(true);
        expect(resolveBandMapping(undefined)).toEqual({gray: 0, red: 0, green: 0, blue: 0, rgb: false});
    });

    it("does not invent EPSG codes", () => {
        expect(referenceIdentifierFromGeoKeys(null)).toBeNull();
        expect(referenceIdentifierFromGeoKeys({ProjectedCSTypeGeoKey: 32767})).toBeNull();
        expect(referenceIdentifierFromGeoKeys({GeographicTypeGeoKey: 4326})).toBe("EPSG:4326");
    });

    it("appends request parameters", () => {
        expect(withRequestParameters("https://h/a.tif", {requestParameters: {k: "a b"}})).toBe("https://h/a.tif?k=a%20b");
        expect(withRequestParameters("https://h/a.tif?x=1#f", {requestParameters: {k: 2}})).toBe("https://h/a.tif?x=1&k=2#f");
    });
});

describe("createFromURL over HTTP", () => {
    let server: Awaited<ReturnType<typeof startRangeServer>>;
    beforeAll(async () => { server = await startRangeServer(); });
    afterAll(async () => { await server.close(); });

    it("reads the COG with range requests and sends headers and parameters", async () => {
        const model = await GeoTiffTileSetModel.createFromURL(`${server.url}/elevation-3857-float32.tif`, {
            dataType: RasterDataType.ELEVATION,
            requestHeaders: {"X-Test": "yes"},
            requestParameters: {token: "abc"},
            pool: null,
        });
        await tileData(model, {level: 0, x: 0, y: 0});
        expect(server.requests.length).toBeGreaterThan(0);
        expect(server.requests.every((r) => r.url.includes("token=abc"))).toBe(true);
        expect(server.requests.every((r) => r.headers["x-test"] === "yes")).toBe(true);
        expect(server.requests.some((r) => r.range)).toBe(true);
    });

    it("reads through geotiff.js' blocked source: whole, 64 KiB-aligned blocks (regression: geotiff.js #516)", async () => {
        // geotiff.js 3.0.4/3.0.5 stopped using its blocked source for fromUrl() unless blockSize is passed. Without
        // it, every read becomes its own small range request (27 requests of 4 bytes to 1 KiB for these three tiles
        // instead of 1), which in browsers ends in refused streams and corrupt reads. The model passes blockSize.
        const before = server.requests.length;
        const model = await GeoTiffTileSetModel.createFromURL(`${server.url}/elevation-3857-float32.tif`, {
            dataType: RasterDataType.ELEVATION,
            pool: null,
        });
        for (const tile of [{level: 0, x: 0, y: 0}, {level: 2, x: 3, y: 1}, {level: 2, x: 6, y: 3}]) {
            await tileData(model, tile);
        }
        const ranges = server.requests.slice(before).map((r) => r.range).filter((r): r is string => !!r);
        expect(ranges.length).toBeGreaterThan(0);
        for (const range of ranges) {
            const [start, end] = /bytes=(\d+)-(\d+)/.exec(range)!.slice(1).map(Number);
            expect(start % 65536).toBe(0);
            expect(end - start + 1).toBe(65536);
        }
    });

    it("rejects missing files with ERROR_LOADING_FILE", async () => {
        await expect(GeoTiffTileSetModel.createFromURL(`${server.url}/missing.tif`, {pool: null}))
            .rejects.toMatchObject({cause: "ERROR_LOADING_FILE"});
    });

    it("returns info for a COG", async () => {
        const info = await GeoTiffTileSetModel.infoFromURL(`${server.url}/rgb-3857-uint8.tif`);
        expect(info.pixelMeaning).toBe(PixelMeaningEnum.RGB);
        expect(info.tileMatrix?.map((m) => m.tileColumnCount)).toEqual([2, 1]);
    });
});
