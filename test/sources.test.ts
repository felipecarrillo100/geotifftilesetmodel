import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {addReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {
    GeoTiffReadError, GeoTiffTileSetModel, ManifestError, readManifest, StyleError, toManifest, validateManifest, type StackManifest,
} from "../src/index.js";
import {StacClient, type StacCollectionJson, type StacItemJson} from "../src/stac/index.js";
import {samplePositions} from "../src/elevation.js";
import {fixtureBytes, openFixture, plane, QUANTISATION, startRangeServer, tileData, tileHeights} from "./helpers.js";

addReference(parseWellKnownText(`PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],
UNIT["metre",1],AUTHORITY["EPSG","32633"]]`), "EPSG:32633");

let server: Awaited<ReturnType<typeof startRangeServer>>;
beforeAll(async () => { server = await startRangeServer(); });
afterAll(async () => { await server.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A STAC item over the Sentinel-2 fixtures (UTM 33N, 500000 E / 5000000 N). */
function s2Item(id: string, date: string, cloud = 1): StacItemJson {
    return {
        type: "Feature", id, collection: "s2", bbox: [15.0, 45.12, 15.03, 45.15],
        geometry: {type: "Polygon", coordinates: [[[15.0, 45.12], [15.03, 45.12], [15.03, 45.15], [15.0, 45.15], [15.0, 45.12]]]},
        properties: {datetime: date, "eo:cloud_cover": cloud},
        assets: {
            red: {href: `${server.url}/s2-red-10m.tif`, type: "image/tiff", "eo:bands": [{common_name: "red"}], "raster:bands": [{scale: 0.0001, offset: -0.1, nodata: 0}]},
            nir: {href: `${server.url}/s2-nir-10m.tif`, type: "image/tiff", "eo:bands": [{common_name: "nir"}], "raster:bands": [{scale: 0.0001, offset: -0.1, nodata: 0}]},
            scl: {href: `${server.url}/s2-scl-20m.tif`, type: "image/tiff", roles: ["data"]},
        },
    } as StacItemJson;
}

const ndvi = {render: {type: "pseudocolor" as const, expression: "(nir - red) / (nir + red)", stretch: [-1, 1] as [number, number]}};

describe("create: one factory, one source", () => {
    it("opens a URL, a file in memory (ArrayBuffer, Blob, GeoTIFF) and inputs", async () => {
        const byUrl = await GeoTiffTileSetModel.create({url: `${server.url}/rgb-3857-uint8.tif`, pool: null});
        expect(byUrl.getBandNames()).toEqual(["b1", "b2", "b3"]);
        expect(byUrl.getStyle()!.render).toMatchObject({type: "rgb", red: "b1", green: "b2", blue: "b3"});   // autoStyle
        expect(byUrl.getSource()).toEqual({kind: "inputs"});
        for (const file of [fixtureBytes("rgb-3857-uint8.tif"), new Blob([fixtureBytes("rgb-3857-uint8.tif")]), await openFixture("rgb-3857-uint8.tif")]) {
            const model = await GeoTiffTileSetModel.create({file, pool: null, bands: {red: "b1", green: "b2", blue: "b3"}});
            expect(model.getStyle()!.render).toMatchObject({type: "rgb", red: "red", green: "green", blue: "blue"});
        }
        const two = await GeoTiffTileSetModel.create({inputs: [{url: `${server.url}/s2-red-10m.tif`}, {url: `${server.url}/s2-nir-10m.tif`}], pool: null});
        expect(two.getBandNames()).toEqual(["f1_b1", "f2_b1"]);   // several inputs without names
    });

    it("rejects (never throws) for a missing or double source and invalid options", async () => {
        const none = GeoTiffTileSetModel.create({} as never);
        await expect(none).rejects.toThrow(RangeError);
        await expect(GeoTiffTileSetModel.create({url: "a.tif", file: new ArrayBuffer(8)})).rejects.toThrow(/exactly one source.*url and file/);
        await expect(GeoTiffTileSetModel.create({stac: {items: []}})).rejects.toThrow(RangeError);
        await expect(GeoTiffTileSetModel.create({file: fixtureBytes("rgb-3857-uint8.tif"), pool: null,
            style: {render: {type: "rgb", red: "nir", green: "b2", blue: "b3"}}})).rejects.toBeInstanceOf(StyleError);
    });

    it("makes a mosaic of the same band name in several inputs: first input with data wins, union extent", async () => {
        const west = {url: `${server.url}/elevation-3857-float32-west.tif`, bands: "h"};
        const east = {url: `${server.url}/elevation-3857-float32-east.tif`, bands: "h"};
        const single = await GeoTiffTileSetModel.create({url: `${server.url}/elevation-3857-float32.tif`, pool: null});
        const mosaic = await GeoTiffTileSetModel.create({inputs: [west, east], pool: null});
        expect(mosaic.getBandNames()).toEqual(["h"]);
        expect(mosaic.getBands()[0].locations.map((l) => l.input)).toEqual([0, 1]);
        expect(mosaic.getDataExtent()).toEqual(single.getDataExtent());
        for (const [x, y] of [[1000000 + 1000, 6000000 - 1000], [1000000 + 8000, 6000000 - 5000]]) {
            expect((await mosaic.getValuesAt(x, y))!.bands.h).toBeCloseTo(plane(x, y), 2);
        }
        // Priority: the first input (raised by 1000 m) wins where both have data; elsewhere the second shows.
        const raised = await GeoTiffTileSetModel.create({inputs: [{...west, offset: 1000}, {url: `${server.url}/elevation-3857-float32.tif`, bands: "h"}], pool: null});
        const [xw, yw] = [1000000 + 1000, 6000000 - 1000], [xe, ye] = [1000000 + 8000, 6000000 - 5000];
        expect((await raised.getValuesAt(xw, yw))!.bands.h).toBeCloseTo(plane(xw, yw) + 1000, 2);
        expect((await raised.getValuesAt(xe, ye))!.bands.h).toBeCloseTo(plane(xe, ye), 2);
        const rgba = new Uint8Array((await tileData(mosaic, {level: 0, x: 0, y: 0})).data as ArrayBuffer);
        expect(rgba.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
    });

    it("rejects inputs in different references with REFERENCE_MISMATCH", async () => {
        await expect(GeoTiffTileSetModel.create({
            inputs: [{file: await openFixture("s2-red-10m.tif"), bands: "red"}, {file: await openFixture("monthly-4326-float32.tif")}], pool: null,
        })).rejects.toMatchObject({name: "GeoTiffModelError", cause: "REFERENCE_MISMATCH"});
    });
});

describe("create: elevation", () => {
    const dem = () => openFixture("elevation-3857-float32.tif");
    const tile = {level: 2, x: 1, y: 1};

    it("serves one band as heights", async () => {
        const model = await GeoTiffTileSetModel.create({file: await dem(), dataType: RasterDataType.ELEVATION, pool: null});
        expect(model.dataType).toBe(RasterDataType.ELEVATION);
        expect(model.getStyle()).toBeNull();
        expect(model.getElevation()).toEqual({height: "b1", tileSize: 64});
        const heights = await tileHeights(model, tile);
        const {xs, ys} = samplePositions(model.getTileBounds(tile), 64);
        for (const [i, j] of [[0, 0], [30, 20], [63, 63]]) {
            expect(Math.abs(heights[j * 64 + i] - plane(xs[i], ys[j]))).toBeLessThanOrEqual(QUANTISATION);
        }
    });

    it("computes heights from an expression over several bands", async () => {
        const model = await GeoTiffTileSetModel.create({
            inputs: [{file: await dem(), bands: "a"}, {file: await dem(), bands: "b"}], pool: null,
            dataType: RasterDataType.ELEVATION, elevation: {height: "(a + b) / 2 + 10"},
        });
        const heights = await tileHeights(model, tile);
        const {xs, ys} = samplePositions(model.getTileBounds(tile), 64);
        for (const [i, j] of [[0, 0], [30, 20], [63, 63]]) {
            expect(Math.abs(heights[j * 64 + i] - plane(xs[i], ys[j]) - 10)).toBeLessThanOrEqual(QUANTISATION);
        }
        expect((await model.getValuesAt(xs[30], ys[20]))!.sources.height).toBeCloseTo(plane(xs[30], ys[20]) + 10, 3);
    });

    it("needs elevation.height with several bands, and rejects a style", async () => {
        const two = async () => [{file: await dem(), bands: "lidar"}, {file: await dem(), bands: "national"}];
        await expect(GeoTiffTileSetModel.create({inputs: await two(), dataType: RasterDataType.ELEVATION, pool: null}))
            .rejects.toThrow(new RangeError("elevation.height is required with several bands: name one or combine them with an expression (bands: lidar, national)"));
        await expect(GeoTiffTileSetModel.create({file: await dem(), dataType: RasterDataType.ELEVATION, pool: null, style: ndvi}))
            .rejects.toBeInstanceOf(RangeError);
        await expect(GeoTiffTileSetModel.create({inputs: await two(), dataType: RasterDataType.ELEVATION, pool: null, elevation: {height: "lidr"}}))
            .rejects.toMatchObject({name: "StyleError", path: "elevation.height"});
    });

    it("makes twins (asElevation, withStyle) that share files and decoded tiles", async () => {
        const terrain = await GeoTiffTileSetModel.create({file: await dem(), dataType: RasterDataType.ELEVATION, pool: null});
        const before = await tileHeights(terrain, tile);
        const coloured = await terrain.withStyle({render: {type: "pseudocolor", band: "b1", stretch: [0, 500]}});
        expect(coloured.dataType).toBe(RasterDataType.IMAGE);
        const internals = (m: GeoTiffTileSetModel) => m as unknown as { _files: unknown[]; _shared: unknown };
        expect(internals(coloured)._files).toBe(internals(terrain)._files);
        expect(internals(coloured)._shared).toBe(internals(terrain)._shared);
        await tileData(coloured, {level: 0, x: 0, y: 0});
        const again = await coloured.asElevation();
        const spy = vi.spyOn(again as unknown as { sampleHeights: () => unknown }, "sampleHeights");
        expect(Array.from(await tileHeights(again, tile))).toEqual(Array.from(before));
        expect(spy).not.toHaveBeenCalled();   // read by the first model, served from the shared cache
        await expect(terrain.setStyle(ndvi)).rejects.toBeInstanceOf(RangeError);
    });

    it("reports read errors of imagery reads and of twins to the listeners", async () => {
        const received: GeoTiffReadError[] = [];
        const model = await GeoTiffTileSetModel.create({file: await dem(), pool: null, onReadError: (e) => received.push(e),
            style: {render: {type: "pseudocolor", band: "b1", stretch: [0, 500]}}});
        const twin = await model.withStyle({render: {type: "pseudocolor", band: "b1", stretch: [0, 100]}});
        for (const image of (model as unknown as { _files: { images: { readRasters: unknown }[] }[] })._files[0].images) {
            image.readRasters = () => Promise.reject(new RangeError("damaged block"));
        }
        await tileData(twin, {level: 0, x: 0, y: 0});
        expect(received.length).toBeGreaterThan(0);
        expect(received[0]).toMatchObject({cause: "READ_FAILED", recovery: "nodata"});
    });
});

describe("create: STAC items", () => {
    it("makes a mosaic of the items of one period, opening only the assets the style reads", async () => {
        const model = await GeoTiffTileSetModel.create({stac: {items: [s2Item("a", "2024-06-01T10:00:00Z"), s2Item("b", "2024-06-01T10:00:05Z")]},
            style: ndvi, pool: null, tileSize: 64});
        expect(model.getBandNames()).toEqual(["red", "nir", "scl"]);
        expect(model.getBands().map((b) => b.name)).toEqual(["red", "nir"]);   // scl opens when a style reads it
        expect(model.getBands()[0].locations.length).toBe(2);
        const source = model.getSource();
        expect(source.kind).toBe("stac");
        expect(source.items!.map((i) => i.id)).toEqual(["a", "b"]);
        expect(source.periods).toBeUndefined();
    });

    it("makes a time series of several periods, with item URLs fetched", async () => {
        const realFetch = globalThis.fetch;
        const items: Record<string, StacItemJson> = {
            "https://stac.test/items/2023.json": s2Item("y2023", "2023-07-01T10:00:00Z"),
            "https://stac.test/items/2024.json": s2Item("y2024", "2024-07-01T10:00:00Z"),
        };
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
            const item = items[String(input)];
            return item ? new Response(JSON.stringify(item), {status: 200}) : realFetch(input, init);
        }));
        const model = await GeoTiffTileSetModel.create({stac: {items: Object.keys(items), per: "year"}, pool: null,
            style: {render: {type: "pseudocolor", expression: "nir_2024 - nir_2023", stretch: [-1, 1]}}});
        expect(model.getBands().map((b) => b.name)).toEqual(["nir_2023", "nir_2024"]);
        expect(model.getSource().periods).toEqual(["2023", "2024"]);
        // Without a style: true colour of the last period when possible, else its first band.
        const auto = await GeoTiffTileSetModel.create({stac: {items: Object.values(items), per: "year"}, pool: null});
        expect(auto.getStyle()!.render).toMatchObject({type: "pseudocolor", band: "red_2024"});
    });
});

describe("manifests", () => {
    const valid: StackManifest = {type: "ria-geotiff/stack", version: 1, inputs: [{url: "s2-red-10m.tif", bands: "red"}]};

    it("recognises the format and reports problems with JSON paths", () => {
        expect(validateManifest(valid)).toEqual([]);
        const problems = validateManifest({type: "geojson", version: 2, inputs: [{url: "", bands: ["red", "9x"], nodata: "none", colour: 1}],
            bands: {nir: "band 4"}, tileSze: 256, dataType: "terrain"});
        expect(problems.map((p) => p.path)).toEqual(expect.arrayContaining(["type", "version", "tileSze", "inputs[0].url",
            "inputs[0].bands", "inputs[0].nodata", "inputs[0].colour", "bands.nir", "dataType"]));
        expect(validateManifest({type: "ria-geotiff/stack", version: 1})[0]).toMatchObject({path: "", message: "give either inputs or stac"});
    });

    it("opens inputs relative to the manifest URL; options next to it override the manifest's", async () => {
        const manifest: StackManifest = {
            type: "ria-geotiff/stack", version: 1, title: "two files",
            inputs: [{url: "s2-red-10m.tif", nodata: 0}, {url: "s2-nir-10m.tif", nodata: "nan", sign: "planetary-computer"}],
            bands: {red: "f1_b1", nir: "f2_b1"}, style: ndvi, tileSize: 64,
        };
        vi.stubGlobal("fetch", globalThis.fetch);
        const model = await GeoTiffTileSetModel.create({manifest, base: `${server.url}/x.json`, pool: null});
        expect(model.getBandNames()).toEqual(["red", "nir"]);
        expect(model.levelCount).toBe(2);   // tileSize 64 from the manifest
        expect(model.getSource()).toMatchObject({kind: "manifest", manifest});
        const bigger = await GeoTiffTileSetModel.create({manifest, base: `${server.url}/x.json`, pool: null, tileSize: 128});
        expect(bigger.levelCount).toBe(1);
        // Round trip, including nodata and sign (regression: both were dropped).
        const saved = toManifest(model, {title: "saved"});
        expect(validateManifest(saved)).toEqual([]);
        expect(saved.inputs).toEqual([
            {url: `${server.url}/s2-red-10m.tif`, bands: "red", scale: 0.0001, offset: -0.1, nodata: 0},
            {url: `${server.url}/s2-nir-10m.tif`, bands: "nir", scale: 0.0001, offset: -0.1, nodata: "nan", sign: "planetary-computer"},
        ]);
        expect(saved.tileSize).toBe(64);
    });

    it("reads manifests from JSON text and Blobs, resolves URLs through a hook, and saves elevation models", async () => {
        expect((await readManifest(JSON.stringify(valid))).manifest.inputs![0].url).toBe("s2-red-10m.tif");
        expect((await readManifest(new Blob([JSON.stringify(valid)]))).manifest.version).toBe(1);
        await expect(readManifest('{"type": "x", "version": 1, "inputs": []}')).rejects.toBeInstanceOf(ManifestError);
        const model = await GeoTiffTileSetModel.create({manifest: valid, resolve: (url) => fixtureBytes(url), pool: null});
        expect(model.getBandNames()).toEqual(["red"]);
        await expect(GeoTiffTileSetModel.create({manifest: valid, pool: null})).rejects.toThrow(/needs a base/);
        const terrain = await GeoTiffTileSetModel.create({manifest: {type: "ria-geotiff/stack", version: 1, dataType: "elevation",
            inputs: [{url: "elevation-3857-float32.tif"}], elevation: {noDataHeight: -5}}, base: `${server.url}/m.json`, pool: null});
        expect(terrain.dataType).toBe(RasterDataType.ELEVATION);
        expect(toManifest(terrain)).toMatchObject({dataType: "elevation", elevation: {height: "b1", noDataHeight: -5}});
    });

    it("opens STAC sources with the manifest's model options and bands (regression: they were ignored)", async () => {
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => (String(input) === "https://stac.test/item.json"
            ? new Response(JSON.stringify(s2Item("one", "2024-06-01T10:00:00Z")), {status: 200}) : realFetch(input, init))));
        const model = await GeoTiffTileSetModel.create({manifest: {type: "ria-geotiff/stack", version: 1, tileSize: 64,
            stac: {items: ["https://stac.test/item.json"], assets: ["red"]}, bands: {r: "b1"},
            style: {render: {type: "pseudocolor", band: "r", stretch: [0, 0.2]}}}, pool: null});
        expect(model.getBandNames()).toEqual(["r"]);
        expect(model.levelCount).toBe(2);
        expect(model.getSource()).toMatchObject({kind: "manifest"});
        expect(model.getSource().items!.map((i) => i.id)).toEqual(["one"]);
    });
});

describe("StacClient: capabilities and choice", () => {
    const collection: StacCollectionJson = {
        id: "s2", title: "Sentinel-2", extent: {spatial: {bbox: [[14.9, 45.0, 15.2, 45.3]]}, temporal: {interval: [["2020-01-01T00:00:00Z", null]]}},
        summaries: {"eo:cloud_cover": {minimum: 0, maximum: 100}},
        item_assets: {
            red: {type: "image/tiff", roles: ["data"], "eo:bands": [{common_name: "red"}]},
            nir: {type: "image/tiff", roles: ["data"], "eo:bands": [{common_name: "nir"}]},
            thumbnail: {type: "image/jpeg", roles: ["thumbnail"]},
        },
    };
    const other: StacCollectionJson = {id: "dem", extent: {spatial: {bbox: [[100, 0, 101, 1]]}, temporal: {interval: [[null, null]]}}};

    function stubCatalog(found: StacItemJson[], options: { failCollections?: number } = {}) {
        const realFetch = globalThis.fetch;
        const calls: string[] = [];
        let failures = options.failCollections ?? 0;
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (!url.startsWith("https://stac.test")) return realFetch(input, init);
            calls.push(url);
            if (url === "https://stac.test/v1") return json({stac_version: "1.1.0", conformsTo: ["https://api.stacspec.org/v1.0.0/item-search", "https://api.stacspec.org/v1.0.0/item-search#query"],
                links: [{rel: "search", href: "https://stac.test/v1/search"}, {rel: "data", href: "https://stac.test/v1/collections"}]});
            if (url === "https://stac.test/v1/collections") return failures-- > 0 ? json({}, 500) : json({collections: [collection, other]});
            if (url === "https://stac.test/v1/collections/s2") return json(collection);
            if (url === "https://stac.test/v1/collections/s2/queryables") return json({properties: {"eo:cloud_cover": {type: "number"}, datetime: {type: "string"}}});
            if (url.startsWith("https://stac.test/v1/search")) return json({type: "FeatureCollection", features: found, links: [], numberMatched: found.length});
            return json({}, 404);
        }));
        return calls;
    }

    it("lists collections by area and text, and describes one with its queryables", async () => {
        stubCatalog([]);
        const catalog = await StacClient.connect("https://stac.test/v1", {retry: {attempts: 1}});
        expect((await catalog.collections()).map((c) => c.id)).toEqual(["s2", "dem"]);
        expect((await catalog.collections({area: [15, 45.1, 15.1, 45.2]})).map((c) => c.id)).toEqual(["s2"]);
        expect((await catalog.collections({q: "sentinel"}))[0]).toMatchObject({id: "s2", bands: ["red", "nir"], bandNaming: "common-names"});
        const details = await catalog.collection("s2");
        expect(details).toMatchObject({id: "s2", title: "Sentinel-2", interval: ["2020-01-01T00:00:00Z", null]});
        expect(details.queryables.map((q) => q.name)).toEqual(["eo:cloud_cover", "datetime"]);
        expect(details.raw).toBe(details.raw);
    });

    it("checks a selection against the collection before searching", async () => {
        stubCatalog([]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const details = await catalog.collection("s2");
        expect(catalog.check({collection: "s2", area: [15, 45.1, 15.1, 45.2], datetime: "2024", bands: ["red", "nir"], maxCloud: 5}, details)).toEqual([]);
        const problems = catalog.check({collection: "s2", area: [100, 0, 101, 1], datetime: "2010", bands: ["red", "swir16"], where: {platform: {eq: "x"}}});
        expect(problems.map((p) => [p.path, p.severity])).toEqual([["area", "error"], ["datetime", "error"], ["bands", "error"], ["where.platform", "warning"]]);
        expect(catalog.check({collection: "nope"})[0]).toMatchObject({path: "collection", severity: "error"});
    });

    it("selects items: least cloud, per period, closest to a day across the year end", async () => {
        stubCatalog([s2Item("cloudy", "2024-07-01T10:00:00Z", 4), s2Item("clear", "2024-06-01T10:00:00Z", 0.5),
            s2Item("dec", "2023-12-30T10:00:00Z", 2), s2Item("jan", "2024-01-20T10:00:00Z", 2)]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const area: [number, number, number, number] = [15.005, 45.125, 15.02, 45.14];
        const best = await catalog.select({collection: "s2", area, datetime: ["2023-01-01", null], maxCloud: 5});
        expect(best.items.map((i) => i.id)).toEqual(["clear"]);
        expect(best).toMatchObject({found: 4, problems: []});
        expect(best.plan.filterEncoding).toBe("query");
        const yearly = await catalog.select({collection: "s2", area, pick: {per: "year"}});
        expect(yearly.periods).toEqual(["2023", "2024"]);
        expect(yearly.items.map((i) => i.id)).toEqual(["dec", "clear"]);
        // Regression: "01-02" measured Dec 30 against Jan 2 of the same year (363 days instead of 3).
        const winter = await catalog.select({collection: "s2", area, pick: {rank: {closestTo: "01-02"}}});
        expect(winter.items.map((i) => i.id)).toEqual(["dec"]);
        await expect(catalog.select({collection: "s2", area: [100, 0, 101, 1]}))
            .rejects.toMatchObject({problems: [expect.objectContaining({path: "area", severity: "error"})]});
    });

    it("creates a model from a catalog selection, a mosaic of the picked items", async () => {
        stubCatalog([s2Item("clear", "2024-06-01T10:00:00Z", 0.5)]);
        const model = await GeoTiffTileSetModel.create({stac: {catalog: "https://stac.test/v1", collection: "s2", area: [15.005, 45.125, 15.02, 45.14]},
            style: ndvi, pool: null});
        expect(model.getSource()).toMatchObject({kind: "stac", found: 1});
        expect(model.getSource().plan).toBeDefined();
        expect(model.getBands().map((b) => b.name)).toEqual(["red", "nir"]);
    });

    it("does not cache a failed collection list (regression)", async () => {
        stubCatalog([], {failCollections: 1});
        const catalog = await StacClient.connect("https://stac.test/v1", {retry: {attempts: 1}});
        await expect(catalog.listCollections()).rejects.toThrow();
        expect((await catalog.listCollections()).length).toBe(2);
    });

    it("requests the first page once for matched() and the items (regression)", async () => {
        const calls = stubCatalog([s2Item("clear", "2024-06-01T10:00:00Z", 0.5)]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const search = catalog.search({collections: ["s2"]});
        expect(await search.matched()).toEqual({value: 1, exact: true});
        expect((await search.collect()).length).toBe(1);
        expect(calls.filter((c) => c.includes("/search")).length).toBe(1);
    });
});
