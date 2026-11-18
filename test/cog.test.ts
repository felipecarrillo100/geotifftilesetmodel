import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {GeoTiffTileSetModel, probeCog} from "../src/index.js";
import {FIXTURES, startRangeServer} from "./helpers.js";

type Server = Awaited<ReturnType<typeof startRangeServer>>;
let server: Server | null = null;
afterEach(async () => {
    await server?.close();
    server = null;
});
const blob = (name: string) => new Blob([readFileSync(join(FIXTURES, name))]);

describe("probeCog", () => {
    it("accepts the COG fixtures, from a URL with one range request and from a Blob", async () => {
        server = await startRangeServer();
        const probe = await probeCog(`${server.url}/rgb-3857-uint8.tif`);
        expect(probe).toMatchObject({isCog: true, reasons: [], width: 128, height: 96, tileWidth: 64, tileHeight: 64, overviewCount: 1, bigTiff: false,
            checks: {tiff: true, tiled: true, headerFirst: true, overviews: true, gdalLayout: true}});
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0].range).toBe("bytes=0-65535");
        expect(probe.bytesRead).toBe(readFileSync(join(FIXTURES, "rgb-3857-uint8.tif")).length);   // smaller than the probe
        for (const name of ["s2-red-10m.tif", "elevation-3857-float32.tif", "monthly-4326-float32.tif"]) {
            expect((await probeCog(blob(name))).isCog, name).toBe(true);
        }
    });

    it("rejects strips, missing overviews and directories after the data, with reasons", async () => {
        const strips = await probeCog(blob("not-cog-strips.tif"));
        expect(strips.isCog).toBe(false);
        expect(strips.checks.tiled).toBe(false);
        expect(strips.tileWidth).toBeUndefined();
        expect(strips.reasons[0]).toMatch(/strips, not tiles/);
        const flat = await probeCog(blob("not-cog-no-overviews.tif"));
        expect(flat.checks).toMatchObject({tiled: true, overviews: false, gdalLayout: false});
        expect(flat.reasons).toEqual(["no overviews: zoomed-out views read the full resolution"]);
        server = await startRangeServer();
        const late = await probeCog(`${server.url}/not-cog-ifd-at-end.tif`);
        expect(late.checks).toMatchObject({tiled: true, overviews: true, headerFirst: false});
        expect(late.reasons[0]).toMatch(/after image data/);
        // One more read for the directories beyond the first 64 KiB, never the whole file.
        expect(server.requests).toHaveLength(2);
        expect(late.bytesRead).toBeLessThan(200 * 1024);
    });

    it("answers isCog false with a reason for what is not a TIFF, and works without Range support", async () => {
        server = await startRangeServer({"/doc.json": "{}", "/secret.tif": {status: 403}});
        expect((await probeCog(`${server.url}/doc.json`)).reasons).toEqual(["not a TIFF file: JSON (identifySource tells what it is)"]);
        expect((await probeCog(`${server.url}/secret.tif`)).reasons[0]).toMatch(/403/);
        expect((await probeCog(`${server.url}/missing.tif`)).isCog).toBe(false);
        await expect(probeCog("")).rejects.toBeInstanceOf(RangeError);
        const plain = await startRangeServer({}, {ignoreRange: true});
        try {
            expect((await probeCog(`${plain.url}/not-cog-ifd-at-end.tif`)).checks.overviews).toBe(true);
            expect((await probeCog(`${plain.url}/rgb-3857-uint8.tif`)).isCog).toBe(true);
        } finally {
            await plain.close();
        }
    });

    it("is the definition of infoFromURL().isCog and getModelInfo().isCog", async () => {
        server = await startRangeServer();
        expect((await GeoTiffTileSetModel.infoFromURL(`${server.url}/rgb-3857-uint8.tif`)).isCog).toBe(true);
        expect((await GeoTiffTileSetModel.infoFromURL(`${server.url}/not-cog-no-overviews.tif`)).isCog).toBe(false);
        const model = await GeoTiffTileSetModel.create({url: `${server.url}/not-cog-strips.tif`, pool: null});
        expect(model.getModelInfo().isCog).toBe(false);
    });
});
