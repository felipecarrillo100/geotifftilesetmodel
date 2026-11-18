import {afterEach, describe, expect, it} from "vitest";
import {addReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {GeoTiffTileSetModel} from "../src/index.js";
import {StacClient} from "../src/stac/index.js";
import {startRangeServer, tileData} from "./helpers.js";

addReference(parseWellKnownText(`PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],
UNIT["metre",1],AUTHORITY["EPSG","32633"]]`), "EPSG:32633");

type Server = Awaited<ReturnType<typeof startRangeServer>>;
let server: Server | null = null;
afterEach(async () => {
    await server?.close();
    server = null;
});

const AREA: [number, number, number, number] = [15.002, 45.145, 15.012, 45.15];

describe("StacClient on a static catalog", () => {
    it("recognises it, lists its collections through child links, and describes one", async () => {
        server = await startRangeServer();
        const client = await StacClient.connect(`${server.url}/static-catalog/catalog.json`);
        expect(client.capabilities.staticCatalog).toBe(true);
        expect(client.capabilities.itemSearch).toBe(false);
        expect(client.searchUrl).toBeUndefined();
        // No conformance request: the landing page shows it is a static catalog.
        expect(server.requests.map((r) => r.url)).toEqual(["/static-catalog/catalog.json"]);
        const collections = await client.collections({area: AREA});
        expect(collections.map((c) => c.id)).toEqual(["s2-sample"]);
        expect(collections[0].bands).toEqual(["red", "nir"]);
        const details = await client.collection("s2-sample");
        expect(details.queryables.map((q) => q.name)).toContain("eo:cloud_cover");
        expect(details.queryables.every((q) => q.source === "summaries")).toBe(true);
        expect(client.check({collection: "s2-sample", area: AREA, datetime: ["2024-01-01", null], bands: ["red", "nir"]}, details)).toEqual([]);
        await expect(client.collection("nope")).rejects.toThrow(/no collection "nope"/);
    });

    it("searches by crawling item links and filtering on the client", async () => {
        server = await startRangeServer();
        const client = await StacClient.connect(`${server.url}/static-catalog/catalog.json`);
        const search = client.search({collections: ["s2-sample"], area: AREA, where: {"eo:cloud_cover": {lt: 20}}});
        expect(search.plan.filterEncoding).toBe("client");
        expect(search.plan.degradations.map((d) => d.kind)).toEqual(["static-catalog", "filter-client-side"]);
        const pages = [];
        for await (const page of search.pages()) pages.push(page);
        expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(["sample-2024"]);
        expect(pages.at(-1)!.scanned).toBe(2);
        expect(pages.every((p) => p.next === undefined && p.matched === undefined)).toBe(true);
        // A search without collections starts at the landing page.
        expect((await client.search({datetime: "2025"}).collect()).map((i) => i.id)).toEqual(["sample-2025"]);
        expect((await client.search({maxScanned: 1}).collect())).toHaveLength(1);
        expect((await client.items([{collection: "s2-sample", id: "sample-2025"}])).map((i) => i.id)).toEqual(["sample-2025"]);
    });

    it("selects items per year and opens them as a model, with relative assets resolved", async () => {
        server = await startRangeServer();
        const client = await StacClient.connect(`${server.url}/static-catalog/catalog.json`);
        const found = await client.select({collection: "s2-sample", area: AREA, bands: ["red", "nir"], pick: {per: "year"}});
        expect(found.items.map((i) => i.id)).toEqual(["sample-2024", "sample-2025"]);
        expect(found.periods).toEqual(["2024", "2025"]);
        expect(found.plan.filterEncoding).toBe("client");
        expect(found.items[0].assets.red.href).toBe(`${server.url}/s2-red-10m.tif`);
        const model = await GeoTiffTileSetModel.create({stac: {items: found.items, per: "year"}, pool: null});
        expect(model.getBandNames()).toEqual(["red_2024", "nir_2024", "red_2025", "nir_2025"]);
        expect(model.getSource().periods).toEqual(["2024", "2025"]);
        await tileData(model, {level: 0, x: 0, y: 0});
    });

    it("sends the client's options to the catalog's origin only, and respects the crawl limits", async () => {
        let other = "";
        const outside = await startRangeServer();
        other = outside.url;
        server = await startRangeServer({
            "/cat.json": () => JSON.stringify({type: "Catalog", stac_version: "1.1.0", id: "c", description: "", links: [
                {rel: "child", href: "./s2.json"}, {rel: "child", href: `${other}/static-catalog/s2-sample/collection.json`}]}),
            "/s2.json": () => JSON.stringify({type: "Collection", stac_version: "1.1.0", id: "local", description: "", license: "MIT",
                extent: {spatial: {bbox: [[0, 0, 1, 1]]}, temporal: {interval: [[null, null]]}}, links: [{rel: "child", href: "./deeper.json"}]}),
            "/deeper.json": () => JSON.stringify({type: "Collection", stac_version: "1.1.0", id: "deep", description: "", license: "MIT",
                extent: {spatial: {bbox: [[0, 0, 1, 1]]}, temporal: {interval: [[null, null]]}}, links: []}),
        });
        try {
            const client = await StacClient.connect(`${server.url}/cat.json`, {requestHeaders: {Authorization: "Bearer t"}});
            expect((await client.listCollections()).map((c) => c.id)).toEqual(["local", "s2-sample", "deep"]);
            expect(server.requests.every((r) => r.headers.authorization === "Bearer t")).toBe(true);
            expect(outside.requests.length).toBeGreaterThan(0);
            expect(outside.requests.some((r) => r.headers.authorization !== undefined)).toBe(false);
            const shallow = await StacClient.connect(`${server.url}/cat.json`, {crawl: {maxDepth: 1}});
            expect((await shallow.listCollections()).map((c) => c.id)).toEqual(["local", "s2-sample"]);
        } finally {
            await outside.close();
        }
    });
});
