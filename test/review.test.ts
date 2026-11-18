/**
 * Regression tests of the code issues found by the documentation reviews (docs/review-findings.md, "Possible code
 * issues"). Each test failed before its fix.
 */
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {addReference, getReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import type {GeoTIFF} from "geotiff";
import {
    buildRampLut, packRGBA, resolveRamp, sampleRamp,
} from "../src/rs/colormaps.js";
import {compileExpression, ExpressionError} from "../src/rs/expression.js";
import {presetStyle} from "../src/rs/presets.js";
import {compileStyle, GeoTiffTileSetModel, StyleError, toManifest, validateManifest} from "../src/index.js";
import {getReferenceFromPrjFile} from "../src/fileutils.js";
import {
    collectionBands, describeCollectionJson, evaluateCql2, footprintOf, bboxOf, groupItems, itemBandNames, periodOf,
    assetFormat, elevationHint, resolveAsset, solarLongitude, StacClient, StacError, toBandInputs, type StacCollectionJson, type StacItemJson,
} from "../src/stac/index.js";
import {bboxesIntersect} from "../src/stac/geometry.js";
import {openFixture, startRangeServer, tileData} from "./helpers.js";

const UTM33 = `PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],
UNIT["metre",1],AUTHORITY["EPSG","32633"]]`;
addReference(parseWellKnownText(UTM33), "EPSG:32633");

let server: Awaited<ReturnType<typeof startRangeServer>>;
beforeAll(async () => { server = await startRangeServer({"/scene.prj": UTM33}); });
afterAll(async () => { await server.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A STAC item over the Sentinel-2 fixtures (UTM 33N). */
function s2Item(id: string, date: string, extra: Partial<StacItemJson> = {}): StacItemJson {
    return {
        type: "Feature", id, collection: "s2", bbox: [15.0, 45.12, 15.03, 45.15],
        geometry: {type: "Polygon", coordinates: [[[15.0, 45.12], [15.03, 45.12], [15.03, 45.15], [15.0, 45.15], [15.0, 45.12]]]},
        properties: {datetime: date, "eo:cloud_cover": 1},
        assets: {
            red: {href: `${server.url}/s2-red-10m.tif`, type: "image/tiff", "eo:bands": [{common_name: "red"}], "raster:bands": [{scale: 0.0001, offset: -0.1, nodata: 0}]},
            nir: {href: `${server.url}/s2-nir-10m.tif`, type: "image/tiff", "eo:bands": [{common_name: "nir"}], "raster:bands": [{scale: 0.0001, offset: -0.1, nodata: 0}]},
            scl: {href: `${server.url}/s2-scl-20m.tif`, type: "image/tiff", roles: ["data"]},
        },
        ...extra,
    } as StacItemJson;
}

/** An item over a lon/lat box, in a given coordinate reference. */
function boxItem(id: string, [w, s, e, n]: number[], code: string, cloud = 1, datetime = "2024-07-01T10:00:00Z"): StacItemJson {
    return {
        type: "Feature", id, collection: "s2", bbox: [w, s, e, n],
        geometry: {type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]},
        properties: {datetime, "eo:cloud_cover": cloud, "proj:code": code}, assets: {data: {href: `https://x.test/${id}.tif`, type: "image/tiff; application=geotiff; profile=cloud-optimized"}},
    } as StacItemJson;
}

/** A minimal STAC API answering every search with `found`. */
function stubCatalog(found: StacItemJson[]) {
    const realFetch = globalThis.fetch;
    const collection: StacCollectionJson = {id: "s2", title: "Sentinel-2", extent: {spatial: {bbox: [[-180, -90, 180, 90]]}, temporal: {interval: [[null, null]]}}} as StacCollectionJson;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("https://stac.test")) return realFetch(input, init);
        if (url === "https://stac.test/v1") return json({stac_version: "1.1.0", conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"],
            links: [{rel: "search", href: "https://stac.test/v1/search"}, {rel: "data", href: "https://stac.test/v1/collections"}]});
        if (url === "https://stac.test/v1/collections") return json({collections: [collection]});
        if (url === "https://stac.test/v1/collections/s2") return json(collection);
        if (url.startsWith("https://stac.test/v1/search")) return json({type: "FeatureCollection", features: found, links: []});
        return json({}, 404);
    }));
}

/** A GeoTIFF of the fixtures whose images declare no EPSG reference (geo keys removed). */
async function withoutGeoKeys(name: string): Promise<GeoTIFF> {
    const tiff = await openFixture(name);
    const getImage = tiff.getImage.bind(tiff);
    tiff.getImage = async (index?: number) => {
        const image = await getImage(index);
        (image as unknown as { getGeoKeys: () => unknown }).getGeoKeys = () => ({});
        return image;
    };
    return tiff;
}

describe("STAC sources of create", () => {
    it("1. opens the assets of other bands when a style first reads them, for the model and its twins", async () => {
        const model = await GeoTiffTileSetModel.create({stac: {items: [s2Item("jun", "2024-06-01T10:00:00Z"), s2Item("jul", "2024-07-01T10:00:00Z")],
            per: "month"}, style: {render: {type: "pseudocolor", band: "red_2024_07", stretch: [0, 1]}}, pool: null});
        // Every band is listed; only the style's are opened.
        expect(model.getBandNames()).toEqual(["red_2024_06", "nir_2024_06", "scl_2024_06", "red_2024_07", "nir_2024_07", "scl_2024_07"]);
        expect(model.getBands().map((b) => b.name)).toEqual(["red_2024_07"]);
        const twin = await model.withStyle({render: {type: "pseudocolor", band: "red_2024_07", stretch: [0, 0.5]}});
        await model.setStyle({render: {type: "pseudocolor", expression: "nir_2024_06 - red_2024_06", stretch: [-1, 1]}});
        expect(model.getBands().map((b) => b.name).sort()).toEqual(["nir_2024_06", "red_2024_06", "red_2024_07"]);
        expect(twin.getBands().map((b) => b.name).sort()).toEqual(["nir_2024_06", "red_2024_06", "red_2024_07"]);
        await tileData(model, {level: 0, x: 0, y: 0});
        // Opened once: the twin's style on the same band reads no header again.
        const files = (model as unknown as { _files: unknown[] })._files.length;
        await twin.setStyle({render: {type: "pseudocolor", band: "nir_2024_06", stretch: [0, 1]}});
        expect((model as unknown as { _files: unknown[] })._files.length).toBe(files);
        await expect(model.setStyle({render: {type: "pseudocolor", band: "swir16", stretch: [0, 1]}})).rejects.toBeInstanceOf(StyleError);
    });

    it("2. groups solar days at the item's centre longitude, as select and groupItems do", async () => {
        // Longitude 15: solar time is UTC + 1 h. 22:30 UTC is still June 1, 23:30 UTC is June 2.
        const items = [s2Item("a", "2024-06-01T22:30:00Z"), s2Item("b", "2024-06-01T23:30:00Z")];
        const model = await GeoTiffTileSetModel.create({stac: {items, per: "solar-day"}, style: {render: {type: "pseudocolor", band: "red_2024_06_02", stretch: [0, 1]}}, pool: null});
        expect(model.getSource().periods).toEqual(["2024-06-01", "2024-06-02"]);
        expect([...groupItems(items, "solar-day").keys()]).toEqual(["2024-06-01", "2024-06-02"]);
        expect(items.map((i) => periodOf(i, "solar-day", solarLongitude(i)))).toEqual(["2024-06-01", "2024-06-02"]);
    });

    it("2. takes the centre of a bbox across the antimeridian, and of a 3D bbox", () => {
        expect(solarLongitude(boxItem("x", [170, 0, -170, 1], "EPSG:4326"))).toBeCloseTo(180);
        expect(solarLongitude({...boxItem("y", [0, 0, 1, 1], "EPSG:4326"), bbox: [10, 0, -5, 20, 1, 5]})).toBe(15);
    });
});

describe("select: one coordinate reference", () => {
    const area: [number, number, number, number] = [15, 45, 15.1, 45.1];

    it("3. makes a best-coverage mosaic in one reference and reports the dropped items", async () => {
        const west = boxItem("west", [15, 45, 15.05, 45.1], "EPSG:32633", 1);
        const eastA = boxItem("eastA", [15.05, 45, 15.1, 45.1], "EPSG:32634", 2);
        const eastB = boxItem("eastB", [15.05, 45, 15.1, 45.1], "EPSG:32634", 3);
        stubCatalog([west, eastA, eastB]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const found = await catalog.select({collection: "s2", area, pick: {coverage: "best"}});
        // Both references cover half of the area; EPSG:32634 has more candidates.
        expect(found.items.map((i) => i.id)).toEqual(["eastA"]);
        expect(found.dropped).toEqual([{reference: "EPSG:32633", items: [west]}]);
        expect(found.problems).toEqual([expect.objectContaining({path: "pick", severity: "warning"})]);
    });

    it("3. keeps the reference covering most of the area with per, and reports the others", async () => {
        const full = boxItem("full", [14.9, 44.9, 15.2, 45.2], "EPSG:32633", 5, "2023-07-01T10:00:00Z");
        const part1 = boxItem("part1", [15, 45, 15.05, 45.1], "EPSG:32634", 1, "2023-07-01T10:00:00Z");
        const part2 = boxItem("part2", [15, 45, 15.05, 45.1], "EPSG:32634", 1, "2024-07-01T10:00:00Z");
        stubCatalog([full, part1, part2]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const found = await catalog.select({collection: "s2", area, pick: {coverage: "best", per: "year"}});
        expect(found.items.map((i) => i.id)).toEqual(["full"]);
        expect(found.dropped.map((d) => [d.reference, d.items.map((i) => i.id)])).toEqual([["EPSG:32634", ["part1", "part2"]]]);
        // A single item drops nothing.
        const one = await catalog.select({collection: "s2", area, pick: {coverage: "best"}});
        expect(one).toMatchObject({dropped: [], problems: []});
    });

    it("6. declares StacError.problems", async () => {
        const problem = {path: "area", severity: "error" as const, message: "outside"};
        expect(new StacError("x", undefined, undefined, undefined, [problem]).problems).toEqual([problem]);
        stubCatalog([]);
        const catalog = await StacClient.connect("https://stac.test/v1");
        const error = await catalog.select({collection: "s2", area}).catch((e: StacError) => e);
        expect(error).toBeInstanceOf(StacError);
        expect((error as StacError).problems).toEqual([{path: "", severity: "warning", message: "the search found no item: widen the area"}]);
    });

    it("5. calls the client's rewriteUrl with the URL only", async () => {
        stubCatalog([]);
        const rewriteUrl = vi.fn((url: string) => url);
        const catalog = await StacClient.connect("https://stac.test/v1", {rewriteUrl});
        await catalog.listCollections();
        expect(rewriteUrl).toHaveBeenCalled();
        for (const call of rewriteUrl.mock.calls) expect(call.length).toBe(1);
    });
});

describe("model options", () => {
    it("4. requests the .prj file through rewriteUrl and with the file's HTTP options", async () => {
        const rewriteUrl = (url: string) => url.replace("https://data.test", server.url);
        const model = await GeoTiffTileSetModel.create({inputs: [{file: await withoutGeoKeys("s2-red-10m.tif"), url: "https://data.test/scene.tif"}],
            rewriteUrl, pool: null, style: {render: {type: "pseudocolor", band: "b1", stretch: [0, 1]}}});
        expect(model.reference.identifier).toBe("EPSG:32633");
        await expect(GeoTiffTileSetModel.create({inputs: [{file: await withoutGeoKeys("s2-red-10m.tif"), url: "https://data.test/scene.tif"}], pool: null}))
            .rejects.toMatchObject({cause: "BoundsMissing"});
    });

    it("uses the input's crsName when the file declares no EPSG reference (user-defined GeoKeys)", async () => {
        const style = {render: {type: "pseudocolor" as const, band: "b1", stretch: [0, 1] as [number, number]}};
        // No GeoKeys, no URL (so no .prj): crsName gives the reference.
        const model = await GeoTiffTileSetModel.create({inputs: [{file: await withoutGeoKeys("s2-red-10m.tif"), crsName: "EPSG:32633"}], style, pool: null});
        expect(model.reference.identifier).toBe("EPSG:32633");
        // The file's own EPSG reference wins over crsName.
        const own = await GeoTiffTileSetModel.create({inputs: [{file: await openFixture("s2-red-10m.tif"), crsName: "EPSG:4326"}], style, pool: null});
        expect(own.reference.identifier).toBe("EPSG:32633");
        // crsName comes before the .prj file: no request is made.
        const fetchSpy = vi.fn(async () => new Response("not found", {status: 404}));
        vi.stubGlobal("fetch", fetchSpy);
        const before = await GeoTiffTileSetModel.create({inputs: [{file: await withoutGeoKeys("s2-red-10m.tif"), url: "https://data.test/scene.tif",
            crsName: "EPSG:32633"}], style, pool: null});
        expect(before.reference.identifier).toBe("EPSG:32633");
        expect(fetchSpy).not.toHaveBeenCalled();
        // Written to manifests, and validated there.
        expect(toManifest(before).inputs![0]).toMatchObject({url: "https://data.test/scene.tif", crsName: "EPSG:32633"});
        expect(validateManifest({...toManifest(before), inputs: [{url: "a.tif", crsName: ""}]}).map((p) => p.path)).toContain("inputs[0].crsName");
    });

    it("takes crsName of STAC inputs from proj:code or proj:epsg, of the asset before the item", () => {
        const item = s2Item("a", "2024-06-01T10:00:00Z", {properties: {datetime: "2024-06-01T10:00:00Z", "proj:epsg": 32633}});
        (item.assets.red as Record<string, unknown>)["proj:code"] = "EPSG:2056";
        const inputs = toBandInputs(item, {assets: ["red", "nir"]});
        expect(inputs.map((i) => i.crsName)).toEqual(["EPSG:2056", "EPSG:32633"]);
        expect(toBandInputs(s2Item("b", "2024-06-01T10:00:00Z"), {assets: ["red"]})[0].crsName).toBeUndefined();
    });

    it("names asset formats and says which ones a model can open (assetFormat)", () => {
        const f = (type: string | undefined, href = "https://x.test/a") => assetFormat({type, href});
        expect(f("image/tiff; application=geotiff; profile=cloud-optimized")).toEqual({format: "COG", openable: true, cog: true});
        expect(f("image/tiff; application=geotiff")).toEqual({format: "GeoTIFF", openable: true, cog: false});
        expect(f(undefined, "https://x.test/dem.tif?sig=1")).toMatchObject({format: "GeoTIFF", openable: true});
        expect(f("application/x.tiff+zip")).toEqual({format: "GeoTIFF (zipped)", openable: false, cog: false});
        expect(f(undefined, "https://x.test/dem.tif.zip")).toMatchObject({format: "GeoTIFF (zipped)", openable: false});
        expect(f("application/x.interlis+zip; version=2.3").format).toBe("INTERLIS (zipped)");
        expect(f("application/x.ms-access+zip").format).toBe("MS Access (zipped)");
        expect(f("application/zip").format).toBe("ZIP");
        expect(f("application/geopackage+sqlite3").format).toBe("GeoPackage");
        expect(f("text/csv").format).toBe("CSV");
        expect(f("application/geo+json").format).toBe("GeoJSON");
        expect(f("image/jpeg").format).toBe("JPEG");
        expect(f("application/xml").format).toBe("XML");
        expect(f("application/vnd.google-earth.kmz").format).toBe("KML");
        expect(f("application/x-foo").format).toBe("FOO");
    });

    it("samples one item of a collection through the items endpoint, or the crawl of a static catalog", async () => {
        const fixture = await StacClient.connect(`${server.url}/static-catalog/catalog.json`);
        expect((await fixture.sampleItem("s2-sample"))?.collection).toBe("s2-sample");
        const requested: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
            const url = String(input);
            requested.push(url);
            if (url.endsWith("/v1")) return Response.json({type: "Catalog", id: "api", stac_version: "1.0.0", description: "", links: [],
                conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/collections"]});
            return Response.json({type: "FeatureCollection", features: [{type: "Feature", id: "one", properties: {}, assets: {}}]});
        }));
        const api = await StacClient.connect("https://api.test/v1");
        expect((await api.sampleItem("a b"))?.id).toBe("one");
        expect(requested.at(-1)).toBe("https://api.test/v1/collections/a%20b/items?limit=1");
    });

    it("hints which collections are elevation, from keywords, title, description or asset keys (elevationHint)", () => {
        const c = (id: string, title: string, description: string, extra: Partial<StacCollectionJson> = {}) =>
            ({type: "Collection", id, title, description, stac_version: "1.0.0", license: "", links: [],
                extent: {spatial: {bbox: [[0, 0, 1, 1]]}, temporal: {interval: [[null, null]]}}, ...extra}) as StacCollectionJson;
        // swisstopo: no keywords, no item_assets: the description says it.
        expect(elevationHint(c("ch.swisstopo.swissaltiregio", "swissALTIRegio",
            "swissALTIRegio is a medium-resolution digital terrain model (10m).")))
            .toBe('its description says "digital terrain model"');
        expect(elevationHint(c("ch.swisstopo.swisssurface3d-raster", "swissSURFACE3D Raster",
            "swissSURFACE3D Raster is a digital surface model (DSM) which represents the earth's surface"))).toMatch(/surface model/);
        expect(elevationHint(c("ch.swisstopo.swissbathy3d", "swissBATHY3D, Bathymetric data of Swiss lakes", "lakebeds"))).toMatch(/Bathymetric/);
        // Earth Search, Planetary Computer: keywords; or an asset key.
        expect(elevationHint(c("cop-dem-glo-30", "Copernicus DEM GLO-30", "…", {keywords: ["Copernicus", "DEM", "DSM", "Elevation"]})))
            .toBe('its keywords include "DEM"');
        expect(elevationHint(c("x", "Heights", "…", {item_assets: {elevation: {type: "image/tiff"}}}))).toBe('its items have an asset "elevation"');
        // Not elevation: imagery, and products derived from heights.
        expect(elevationHint(c("ch.swisstopo.swissimage-dop10", "SWISSIMAGE 10 cm, digital orthophotomosaic of Switzerland",
            "The orthophoto mosaic SWISSIMAGE 10 cm is a composition of new digital color aerial photographs"))).toBeNull();
        expect(elevationHint(c("ch.bafu.landesforstinventar-vegetationshoehenmodell", "Vegetation height model NFI",
            "Countrywide vegetation height models (VHM) were generated from a digital surface model"))).toBeNull();
        expect(elevationHint(c("ch.bafu.landesforstinventar-vegetationshoehenmodell_relief", "Relief shading of vegetation height model NFI",
            "Information on vegetation height"))).toBeNull();
        // "dem" inside a word is no evidence.
        expect(elevationHint(c("academia", "Academic demographics", "Population by academic degree"))).toBeNull();
    });

    it("says what STAC items hold when none of their assets is a GeoTIFF", async () => {
        const item = {...s2Item("v", "2024-06-01T10:00:00Z"), assets: {"routes.xtf.zip": {href: "https://x.test/routes.xtf.zip", type: "application/x.interlis+zip"}}};
        await expect(GeoTiffTileSetModel.create({stac: {items: [item as StacItemJson]}, pool: null}))
            .rejects.toThrow(/no GeoTIFF data assets; they hold routes\.xtf\.zip \(application\/x\.interlis\+zip\)/);
    });

    it("4. signs and rewrites the .prj URL (prepare), keeps the query and drops the fragment (32)", async () => {
        const requested: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => { requested.push(String(input)); return new Response(UTM33); }));
        expect(await getReferenceFromPrjFile("https://x.test/a.tif?v=2#frag.x", null, async (u) => `${u}&sig=1`)).toBe("EPSG:32633");
        expect(await getReferenceFromPrjFile("https://x.test/dir/b.tif#part.one", null)).toBe("EPSG:32633");
        expect(requested).toEqual(["https://x.test/a.prj?v=2&sig=1", "https://x.test/dir/b.prj"]);
        expect(await getReferenceFromPrjFile("https://x.test/a.tif", null, () => { throw new Error("no token"); })).toBeNull();
    });

    it("7. rejects an invalid elevation.tileSize with a RangeError", async () => {
        const file = await openFixture("elevation-3857-float32.tif");
        await expect(GeoTiffTileSetModel.create({file, dataType: RasterDataType.ELEVATION, elevation: {tileSize: 1.5}, pool: null}))
            .rejects.toBeInstanceOf(RangeError);
        const terrain = await GeoTiffTileSetModel.create({file, dataType: RasterDataType.ELEVATION, pool: null});
        await expect(terrain.asElevation({tileSize: 1})).rejects.toBeInstanceOf(RangeError);
    });

    it("8. validates the imagery tileSize", async () => {
        const file = await openFixture("rgb-3857-uint8.tif");
        for (const tileSize of [0, -256, 100.5, 8, 8192, Number.NaN]) {
            await expect(GeoTiffTileSetModel.create({file, tileSize, pool: null})).rejects.toBeInstanceOf(RangeError);
        }
        expect((await GeoTiffTileSetModel.create({file, tileSize: 512, pool: null})).getBandNames()).toEqual(["b1", "b2", "b3"]);
    });

    it("9. sizes the fetched-bytes cache of each input with byteCacheSize", async () => {
        const blocksOf = (m: GeoTiffTileSetModel) => (m as unknown as { _files: { tiff: { source: { blockCache: { maxSize: number } } } }[] })
            ._files[0].tiff.source.blockCache.maxSize;
        const url = `${server.url}/rgb-3857-uint8.tif`;
        expect(blocksOf(await GeoTiffTileSetModel.create({url, pool: null}))).toBe(256);
        expect(blocksOf(await GeoTiffTileSetModel.create({url, byteCacheSize: 2, pool: null}))).toBe(32);
        await expect(GeoTiffTileSetModel.create({url, byteCacheSize: 0, pool: null})).rejects.toBeInstanceOf(RangeError);
    });

    it("10. starts a withStyle twin with the statistics region of its model", async () => {
        const style = {render: {type: "pseudocolor" as const, band: "b1", stretch: {type: "minmax" as const}}};
        const model = await GeoTiffTileSetModel.create({file: await openFixture("gray-3857-uint16.tif"), style, pool: null});
        const [x0, y0, x1, y1] = model.getDataExtent();
        const region: [number, number, number, number] = [x0, y0, x0 + (x1 - x0) / 4, y0 + (y1 - y0) / 4];
        const [regional] = await model.computeStatistics(region);
        const [whole] = await (await model.withStyle(style)).computeStatistics();
        expect([regional!.min, regional!.max, regional!.mean]).not.toEqual([whole!.min, whole!.max, whole!.mean]);
        const twin = await model.withStyle({...style, render: {...style.render, gamma: 1.5}});
        expect(twin.getStatistics()).toEqual([regional]);
        expect(twin.getResolvedStretches()).toEqual(model.getResolvedStretches());
    });

    it("11. saves an explicit reference in the manifest, and reopens with it", async () => {
        const model = await GeoTiffTileSetModel.create({url: `${server.url}/s2-red-10m.tif`, reference: getReference("EPSG:32633"), pool: null,
            style: {render: {type: "pseudocolor", band: "b1", stretch: [0, 1]}}});
        const manifest = toManifest(model);
        expect(manifest.reference).toBe("EPSG:32633");
        expect(validateManifest(manifest)).toEqual([]);
        expect(validateManifest({...manifest, reference: 3})).toEqual([expect.objectContaining({path: "reference"})]);
        const reopened = await GeoTiffTileSetModel.create({manifest, pool: null});
        expect(reopened.reference.identifier).toBe("EPSG:32633");
        expect(toManifest(await GeoTiffTileSetModel.create({url: `${server.url}/s2-red-10m.tif`, pool: null})).reference).toBeUndefined();
    });
});

describe("STAC helpers", () => {
    it("14. reports http-only assets as mixed content on https pages", () => {
        const item = {...boxItem("i", [0, 0, 1, 1], "EPSG:4326"), assets: {
            b1: {href: "http://data.test/b1.tif", type: "image/tiff"},
            b2: {href: "http://data.test/b2.tif", type: "image/tiff", alternate: {https: {href: "https://data.test/b2.tif"}}},
        }} as StacItemJson;
        expect(resolveAsset(item, "b1", [])).toMatchObject({readable: "yes", href: "http://data.test/b1.tif"});
        vi.stubGlobal("location", {protocol: "https:", href: "https://app.test/"});
        expect(resolveAsset(item, "b1", [])).toMatchObject({readable: "no", reason: "mixed content", href: "http://data.test/b1.tif"});
        expect(resolveAsset(item, "b2", [])).toMatchObject({readable: "yes", href: "https://data.test/b2.tif"});
    });

    it("15. intersects bounding boxes across the antimeridian", () => {
        expect(bboxesIntersect([170, -10, -170, 10], [175, 0, 176, 1])).toBe(true);
        expect(bboxesIntersect([170, -10, -170, 10], [-175, 0, -174, 1])).toBe(true);
        expect(bboxesIntersect([170, -10, -170, 10], [0, 0, 1, 1])).toBe(false);
        expect(bboxesIntersect([175, 0, 176, 1], [170, -10, -170, 10])).toBe(true);
        expect(bboxesIntersect([170, -10, -170, 10], [160, 20, 179, 30])).toBe(false);
    });

    it("15. finds a collection whose extent crosses the antimeridian", async () => {
        const realFetch = globalThis.fetch;
        const pacific = {id: "pacific", extent: {spatial: {bbox: [[170, -20, -170, 20]]}, temporal: {interval: [[null, null]]}}};
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (!url.startsWith("https://stac.test")) return realFetch(input, init);
            const body = url === "https://stac.test/v1" ? {links: [{rel: "data", href: "https://stac.test/v1/collections"}]} : {collections: [pacific]};
            return new Response(JSON.stringify(body), {headers: {"Content-Type": "application/json"}});
        }));
        const catalog = await StacClient.connect("https://stac.test/v1");
        expect((await catalog.findCollections({bbox: [175, 0, 176, 1]})).map((c) => c.id)).toEqual(["pacific"]);
        expect((await catalog.collections({area: [-179, 0, -178, 1]})).map((c) => c.id)).toEqual(["pacific"]);
    });

    it("17. throws for an unsupported CQL2 operator, also when the property is missing", () => {
        const item = boxItem("i", [0, 0, 1, 1], "EPSG:4326");
        expect(() => evaluateCql2({op: "a_contains", args: [{property: "missing"}, ["x"]]}, item)).toThrow(/a_contains/);
        expect(() => evaluateCql2({op: "t_during", args: [{property: "datetime"}, {interval: ["2024-01-01", "2025-01-01"]}]},
            {...item, properties: {}})).toThrow(/t_during/);
        expect(evaluateCql2({op: "=", args: [{property: "missing"}, 1]}, item)).toBe(false);
    });

    it("19. names the bands of a collection as the bridge names an item's", () => {
        const assets = {
            "b-1": {href: "https://x.test/b1.tif", type: "image/tiff", roles: ["data"]},
            "2nd": {href: "https://x.test/b2.tif", type: "image/tiff", roles: ["data"], "eo:bands": [{common_name: "nir08"}]},
            vis: {href: "https://x.test/v.tif", type: "image/tiff", roles: ["data"], "eo:bands": [{name: "x-1"}, {}]},
        };
        const collection = {id: "c", item_assets: assets} as unknown as StacCollectionJson;
        const item = {...boxItem("i", [0, 0, 1, 1], "EPSG:4326"), assets} as StacItemJson;
        expect(collectionBands(describeCollectionJson(collection))).toEqual(["b_1", "nir", "x_1", "vis_b2"]);
        expect(Object.values(itemBandNames(item))).toEqual(["b_1", "nir"]);
    });

    it("20. reads 3D bboxes as footprints, and refuses a bbox of a geometry without positions", () => {
        const item = {...boxItem("i", [0, 0, 1, 1], "EPSG:4326"), geometry: null, bbox: [10, 20, -5, 11, 21, 5]} as unknown as StacItemJson;
        expect(footprintOf(item)).toEqual([[[[10, 20], [11, 20], [11, 21], [10, 21], [10, 20]]]]);
        expect(bboxOf({type: "Point", coordinates: [3, 4]})).toEqual([3, 4, 3, 4]);
        expect(bboxOf({type: "LineString", coordinates: [[0, 1], [2, -1]]})).toEqual([0, -1, 2, 1]);
        expect(() => bboxOf({type: "MultiPolygon", coordinates: []})).toThrow(RangeError);
    });
});

describe("styles and expressions", () => {
    it("21. reports invalid JSON-array expressions of compileExpression as ExpressionError", () => {
        expect(() => compileExpression("[oops", ["a"])).toThrow(ExpressionError);
        expect(() => compileExpression("[1, \"a\"]", ["a"])).toThrow(ExpressionError);
    });

    it("22. gives a StyleError without path a message without a leading colon", () => {
        expect(new StyleError("a style object is required", "").message).toBe("a style object is required");
        expect(() => compileStyle(null as never, [])).toThrow(/^a style object is required$/);
    });

    it("23. matches class tables in float32 precision", () => {
        const style = compileStyle({render: {type: "pseudocolor", band: "v", colorMap: {type: "table", entries: [{value: 0.1, color: "#ff0000"}]}}}, ["v"]);
        const rgba = style.render({v: Float32Array.of(0.1, 0.2)}, 2, []);
        expect(Array.from(rgba)).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
    });

    it("24. hides NaN mask values with and without invert, for band and expression rules", () => {
        const draw = (mask: object) => {
            const style = compileStyle({render: {type: "pseudocolor", band: "v", stretch: [0, 1]}, mask: [mask as never]}, ["v", "m"]);
            const rgba = style.render({v: Float32Array.of(0.5, 0.5, 0.5), m: Float32Array.of(Number.NaN, 1, 0)}, 3, []);
            return [rgba[3], rgba[7], rgba[11]].map((a) => (a ? "shown" : "hidden"));
        };
        expect(draw({band: "m", values: [1]})).toEqual(["hidden", "hidden", "shown"]);
        expect(draw({band: "m", values: [1], invert: true})).toEqual(["hidden", "shown", "hidden"]);
        expect(draw({expression: "m == 1"})).toEqual(["hidden", "hidden", "shown"]);
        expect(draw({expression: "m == 1", invert: true})).toEqual(["hidden", "shown", "hidden"]);
        expect(draw({expression: "m"})).toEqual(["hidden", "hidden", "shown"]);
    });

    it("25. returns a copy of a ramp's colour from sampleRamp", () => {
        const ramp = resolveRamp({stops: [{position: 0, color: "#000000"}, {position: 1, color: "#ffffff"}], blend: "stepped"});
        const c = sampleRamp(ramp, 0);
        c.r = 99;
        expect(sampleRamp(ramp, 0).r).toBe(0);
        expect(ramp.stops[0].color.r).toBe(0);
        expect(sampleRamp(resolveRamp({stops: ramp.stops.map((s) => ({position: s.position, color: s.css}))}), 1)).not.toBe(ramp.stops[1].color);
    });

    it("26. evaluates infinite literals alike in compiled and vectorised mode", () => {
        const run = (src: string, mode: "compiled" | "vectorised") => {
            const out = new Float32Array(2);
            compileExpression(src, ["b"], mode)({b: Float32Array.of(2, -3)}, 2, out);
            return Array.from(out);
        };
        for (const src of ["min(1e999, b)", "max(-1e999, b)", "b / 1e999", "where(1e999 > b, b, 0)", "1e999"]) {
            expect(run(src, "compiled")).toEqual(run(src, "vectorised"));
        }
        expect(run("min(1e999, b)", "compiled")).toEqual([2, -3]);
        expect(run("1e999", "compiled")).toEqual([Number.NaN, Number.NaN]);
    });

    it("27. throws a RangeError listing the ids for an unknown preset", () => {
        expect(() => presetStyle("nope")).toThrow(RangeError);
        expect(() => presetStyle("nope")).toThrow(/true-color/);
    });

    it("29. passes the pixel value to a colour function when gamma is not 1", () => {
        const values: number[] = [];
        const style = compileStyle({render: {type: "pseudocolor", band: "v", stretch: [0, 1], gamma: 2,
            colorMap: (t, value) => { values.push(value); return [Math.round(value * 255), Math.round(t * 255), 0]; }}}, ["v"]);
        const rgba = style.render({v: Float32Array.of(0.25)}, 1, []);
        expect(Math.abs(rgba[0] - 64)).toBeLessThanOrEqual(1);    // the value 0.25, not its position 0.5
        expect(Math.abs(rgba[1] - 128)).toBeLessThanOrEqual(1);   // drawn at position sqrt(0.25)
        expect(values[values.length - 1]).toBeCloseTo(1);
    });

    it("30. renders into an output array at a byte offset that is not a multiple of 4", () => {
        const style = compileStyle({render: {type: "pseudocolor", band: "v", stretch: [0, 1]}}, ["v"]);
        const out = new Uint8ClampedArray(new ArrayBuffer(14), 1, 12);
        expect(style.render({v: Float32Array.of(0, 1, Number.NaN)}, 3, [], out)).toBe(out);
        expect(Array.from(out)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    });

    it("34. rounds interpolated ramp channels in lookup tables", () => {
        const lut = buildRampLut(resolveRamp({stops: [{position: 0, color: "#000000"}, {position: 1, color: "#ffffff"}]}));
        // Entry 3: 255 * 3 / 1023 = 0.748, which rounds to 1.
        expect(lut[3]).toBe(packRGBA(1, 1, 1, 255));
        expect(lut[511]).toBe(packRGBA(127, 127, 127, 255));
        expect(lut[512]).toBe(packRGBA(128, 128, 128, 255));
    });
});
