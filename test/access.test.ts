import {afterEach, describe, expect, it} from "vitest";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffTileSetModel, toManifest} from "../src/index.js";
import {StacClient} from "../src/stac/index.js";
import {addReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {startRangeServer, tileData, type RecordedRequest} from "./helpers.js";

addReference(parseWellKnownText(`PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],
UNIT["metre",1],AUTHORITY["EPSG","32633"]]`), "EPSG:32633");

/** Two servers on different ports: two origins. */
type Server = Awaited<ReturnType<typeof startRangeServer>>;
let servers: Server[] = [];
async function origins(filesA: Parameters<typeof startRangeServer>[0] = {}, filesB: Parameters<typeof startRangeServer>[0] = {}) {
    const a = await startRangeServer(filesA), b = await startRangeServer(filesB);
    servers.push(a, b);
    return {a, b};
}
afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
});

const TOKEN = "s3cret-token";
const headers = {Authorization: `Bearer ${TOKEN}`};
const carries = (r: RecordedRequest) => r.headers.authorization !== undefined || r.url.includes(TOKEN);
const redirect = (from: Server, to: string) => `${from.url}/__redirect/${encodeURIComponent(to)}`;

describe("credentials, headers and parameters reach the intended server only", () => {
    it("sends the token to the input's origin, not to an input on another origin with its own options", async () => {
        const {a, b} = await origins();
        const model = await GeoTiffTileSetModel.create({pool: null, inputs: [
            {url: `${a.url}/s2-red-10m.tif`, bands: "red", requestHeaders: headers, requestParameters: {token: TOKEN}},
            {url: `${b.url}/s2-nir-10m.tif`, bands: "nir"},
        ], style: {render: {type: "pseudocolor", band: "nir", stretch: [0, 1]}}});
        await tileData(model, {level: 0, x: 0, y: 0});
        expect(a.requests.length).toBeGreaterThan(0);
        expect(a.requests.every((r) => r.headers.authorization === headers.Authorization && r.url.includes(`token=${TOKEN}`))).toBe(true);
        expect(b.requests.length).toBeGreaterThan(0);
        expect(b.requests.some(carries)).toBe(false);
        // Never shown: URLs of bands, sources and manifests have no added parameters.
        expect(JSON.stringify([model.getBands(), model.getSource(), toManifest(model)])).not.toContain(TOKEN);
    });

    it("gives a manifest's files the token on the manifest's origin only", async () => {
        let other = "";
        const {a, b} = await origins({"/m.json": () => JSON.stringify({type: "ria-geotiff/stack", version: 1,
            inputs: [{url: "s2-red-10m.tif", bands: "red"}, {url: `${other}/s2-nir-10m.tif`, bands: "nir"}],
            style: {render: {type: "pseudocolor", band: "nir", stretch: [0, 1]}}})});
        other = b.url;
        const model = await GeoTiffTileSetModel.create({manifest: `${a.url}/m.json`, requestHeaders: headers, pool: null});
        await tileData(model, {level: 0, x: 0, y: 0});
        expect(a.requests.map((r) => r.url.split("?")[0])).toEqual(expect.arrayContaining(["/m.json", "/s2-red-10m.tif"]));
        expect(a.requests.every(carries)).toBe(true);
        expect(b.requests.length).toBeGreaterThan(0);
        expect(b.requests.some(carries)).toBe(false);
        expect(JSON.stringify(toManifest(model))).not.toContain(TOKEN);
        expect(toManifest(model)).not.toHaveProperty("requestHeaders");
    });

    it("sends the token to STAC item URLs, not to the assets (unless assetAccess says so)", async () => {
        let storage = "";
        const item = () => JSON.stringify({type: "Feature", id: "i", bbox: [15, 45.12, 15.03, 45.15], properties: {datetime: "2024-06-01T10:00:00Z"},
            geometry: {type: "Polygon", coordinates: [[[15, 45.12], [15.03, 45.12], [15.03, 45.15], [15, 45.15], [15, 45.12]]]},
            assets: {red: {href: `${storage}/s2-red-10m.tif`, type: "image/tiff", "eo:bands": [{common_name: "red"}]}}});
        const {a, b} = await origins({"/item.json": item});
        storage = b.url;
        const model = await GeoTiffTileSetModel.create({stac: {items: [`${a.url}/item.json`]}, requestHeaders: headers, pool: null});
        await tileData(model, {level: 0, x: 0, y: 0});
        expect(a.requests.every(carries)).toBe(true);
        expect(b.requests.length).toBeGreaterThan(0);
        expect(b.requests.some(carries)).toBe(false);

        b.requests.length = 0;
        await GeoTiffTileSetModel.create({stac: {items: [`${a.url}/item.json`], assetAccess: () => ({requestHeaders: {"X-Storage-Key": "k"}})},
            requestHeaders: headers, pool: null});
        expect(b.requests.every((r) => r.headers["x-storage-key"] === "k" && !carries(r))).toBe(true);
    });

    it("does not follow next links to another origin with the client's token, and redacts headers in plans", async () => {
        let second = "";
        const page = (features: unknown[], next?: string) => JSON.stringify({type: "FeatureCollection", features,
            links: next ? [{rel: "next", href: next}] : []});
        const feature = (id: string) => ({type: "Feature", id, bbox: [0, 0, 1, 1], properties: {datetime: "2024-01-01T00:00:00Z"}, assets: {}});
        const {a, b} = await origins({
            "/v1": (o) => JSON.stringify({conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"], links: [{rel: "search", href: `${o}/v1/search`}]}),
            "/v1/search": () => page([feature("one")], `${second}/page2`),
        }, {"/page2": page([feature("two")])});
        second = b.url;
        const client = await StacClient.connect(`${a.url}/v1`, {requestHeaders: headers, requestParameters: {token: TOKEN}, method: "GET", verify: "never"});
        const found = await client.search({}).collect();
        expect(found.map((i) => i.id)).toEqual(["one", "two"]);
        expect(a.requests.every(carries)).toBe(true);
        expect(b.requests.length).toBe(1);
        expect(b.requests.some(carries)).toBe(false);
        const plan = client.plan({});
        expect(plan.code.curl).toContain("Authorization: <redacted>");
        expect(JSON.stringify(plan)).not.toContain(TOKEN);
    });

    it("follows same-origin redirects and refuses cross-origin ones, naming the withheld host", async () => {
        const {a, b} = await origins();
        const same = await GeoTiffTileSetModel.create({url: redirect(a, `${a.url}/rgb-3857-uint8.tif`), requestHeaders: headers, pool: null});
        expect(same.getBandNames()).toEqual(["b1", "b2", "b3"]);
        const rejected = GeoTiffTileSetModel.create({url: redirect(a, `${b.url}/rgb-3857-uint8.tif`), requestParameters: {token: TOKEN}, pool: null});
        await expect(rejected).rejects.toMatchObject({cause: "ERROR_LOADING_FILE"});
        const error = await rejected.catch((e) => e);
        expect(String((error.originalError as Error).message)).toContain(new URL(b.url).host);
        expect(error.message).not.toContain(TOKEN);
        expect(b.requests.length).toBe(0);
        // Without headers or parameters there is nothing to withhold: the redirect is followed.
        expect((await GeoTiffTileSetModel.create({url: redirect(a, `${b.url}/rgb-3857-uint8.tif`), pool: null})).getBandNames()).toHaveLength(3);
    });

    it("uses renewed headers for the next requests, without reading again", async () => {
        const {a} = await origins();
        const model = await GeoTiffTileSetModel.create({url: `${a.url}/elevation-3857-float32.tif`, dataType: RasterDataType.ELEVATION,
            requestHeaders: {Authorization: "Bearer one"}, pool: null});
        await tileData(model, {level: 0, x: 0, y: 0});
        const before = a.requests.length;
        model.requestHeaders = {Authorization: "Bearer two"};
        expect(model.requestHeaders).toEqual({Authorization: "Bearer two"});
        expect(a.requests.length).toBe(before);   // nothing re-read
        // The fixture fits in one cached block: ask the file's HTTP client for another range, as a new block read does.
        const tiff = (model as unknown as { _files: { tiff: { source: { source: { client: { request(o: RequestInit): Promise<unknown> } } } } }[] })._files[0].tiff;
        await tiff.source.source.client.request({headers: {Range: "bytes=0-99"}});
        const after = a.requests.slice(before);
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((r) => r.headers.authorization === "Bearer two")).toBe(true);
    });
});
