import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {identifySource, IDENTIFY_PROBE_BYTES, type IdentifiedSource} from "../src/index.js";
import {FIXTURES, startRangeServer} from "./helpers.js";

type Server = Awaited<ReturnType<typeof startRangeServer>>;
let servers: Server[] = [];
async function serve(...args: Parameters<typeof startRangeServer>) {
    const s = await startRangeServer(...args);
    servers.push(s);
    return s;
}
afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
});

const C = (s: string) => `https://api.stacspec.org/v1.0.0/${s}`;
const api = {type: "Catalog", id: "api", stac_version: "1.0.0", title: "Test API", description: "An API",
    conformsTo: [C("core"), C("item-search")], links: [{rel: "search", href: "/search"}]};
const item = (id: string) => ({type: "Feature", stac_version: "1.1.0", id, properties: {datetime: "2024-01-01T00:00:00Z"},
    geometry: null, assets: {data: {href: "data.tif", type: "image/tiff"}}, links: []});

function expectKind<K extends IdentifiedSource["kind"]>(found: IdentifiedSource, kind: K): Extract<IdentifiedSource, { kind: K }> {
    expect(found.kind, JSON.stringify(found).slice(0, 300)).toBe(kind);
    return found as Extract<IdentifiedSource, { kind: K }>;
}

describe("identifySource", () => {
    it("recognises a GeoTIFF with one range request, without reading further", async () => {
        const s = await serve();
        const found = expectKind(await identifySource(`${s.url}/rgb-3857-uint8.tif`), "geotiff");
        expect(found.url).toBe(`${s.url}/rgb-3857-uint8.tif`);
        expect(found.bigTiff).toBe(false);
        expect(s.requests).toHaveLength(1);
        expect(s.requests[0].range).toBe(`bytes=0-${IDENTIFY_PROBE_BYTES - 1}`);
    });

    it("works with a server that ignores Range (200 with the whole file)", async () => {
        const s = await serve({}, {ignoreRange: true});
        expectKind(await identifySource(`${s.url}/s2-red-10m.tif`), "geotiff");
        const big = JSON.stringify({type: "FeatureCollection", features: Array.from({length: 600}, (_, i) => item(`item-${i}`))});
        expect(big.length).toBeGreaterThan(IDENTIFY_PROBE_BYTES);
        const s2 = await serve({"/big.json": big}, {ignoreRange: true});
        const found = expectKind(await identifySource(`${s2.url}/big.json`), "stac-item-collection");
        expect(found.items).toHaveLength(600);
        expect(s2.requests).toHaveLength(1);   // the rest of the same body, no second request
    });

    it("reads a JSON document larger than the probe with a second plain GET", async () => {
        const big = JSON.stringify({type: "FeatureCollection", features: Array.from({length: 600}, (_, i) => item(`item-${i}`)),
            links: [{rel: "next", href: "big.json?page=2"}]});
        const s = await serve({"/big.json": big});
        const found = expectKind(await identifySource(`${s.url}/big.json`), "stac-item-collection");
        expect(found.items).toHaveLength(600);
        expect(found.next?.href).toBe(`${s.url}/big.json?page=2`);
        expect(s.requests.map((r) => r.range)).toEqual([`bytes=0-${IDENTIFY_PROBE_BYTES - 1}`, undefined]);
        // Relative asset hrefs resolve against the document's URL.
        expect(found.items[0].assets.data.href).toBe(`${s.url}/data.tif`);
    });

    it("recognises a manifest and reports its problems instead of throwing", async () => {
        const s = await serve({"/broken.json": JSON.stringify({type: "ria-geotiff/stack", version: 2, inputs: []})});
        const good = expectKind(await identifySource(`${s.url}/manifest-s2.json`), "manifest");
        expect(good.problems).toEqual([]);
        expect(good.manifest.title).toBe("Red and NIR sample");
        const bad = expectKind(await identifySource(`${s.url}/broken.json`), "manifest");
        expect(bad.problems.map((p) => p.path)).toEqual(expect.arrayContaining(["version", "inputs"]));
    });

    it("tells a STAC API, a static catalog, a collection, an item and an item collection apart", async () => {
        const s = await serve({
            "/api": JSON.stringify(api),
            "/api-no-search": JSON.stringify({...api, conformsTo: [C("core")], links: []}),
            "/api/collections/s2": (origin) => JSON.stringify({type: "Collection", stac_version: "1.0.0", id: "s2", extent: {},
                links: [{rel: "items", href: `${origin}/api/collections/s2/items`}, {rel: "root", href: `${origin}/api`}]}),
        });
        const a = expectKind(await identifySource(`${s.url}/api`), "stac-api");
        expect([a.url, a.title, a.description]).toEqual([`${s.url}/api`, "Test API", "An API"]);
        expectKind(await identifySource(`${s.url}/api-no-search`), "stac-catalog");
        const cat = expectKind(await identifySource(`${s.url}/static-catalog/catalog.json`), "stac-catalog");
        expect(cat.title).toBe("ria-geotiff sample static catalog");
        expect(cat.document.links?.find((l) => l.rel === "child")?.href).toBe(`${s.url}/static-catalog/s2-sample/collection.json`);
        const col = expectKind(await identifySource(`${s.url}/api/collections/s2`), "stac-collection");
        expect(col.apiUrl).toBe(`${s.url}/api`);
        const staticCol = expectKind(await identifySource(`${s.url}/static-catalog/s2-sample/collection.json`), "stac-collection");
        expect(staticCol.apiUrl).toBeUndefined();
        expect(staticCol.collection.id).toBe("s2-sample");
        const it_ = expectKind(await identifySource(`${s.url}/static-catalog/s2-sample/a/a.json`), "stac-item");
        expect(it_.item.assets.red.href).toBe(`${s.url}/s2-red-10m.tif`);
        const ic = expectKind(await identifySource(`${s.url}/static-catalog/items.json`), "stac-item-collection");
        expect(ic.items.map((i) => i.id)).toEqual(["sample-2024", "sample-2025"]);
        expect(ic.items[1].assets.nir.href).toBe(`${s.url}/s2-nir-10m.tif`);
    });

    it("explains what it cannot open: HTTP status, HTML, other JSON, empty bodies", async () => {
        const s = await serve({
            "/secret.tif": {status: 403, body: "Forbidden"},
            "/page": {body: "<!DOCTYPE html><html><body>Hello</body></html>", contentType: "text/html"},
            "/other.json": JSON.stringify({name: "not stac"}),
            "/feature.json": JSON.stringify({type: "Feature", properties: {}, geometry: null}),
            "/empty": "",
            "/text": "hello world",
        });
        const forbidden = expectKind(await identifySource(`${s.url}/secret.tif`), "unknown");
        expect(forbidden.status).toBe(403);
        expect(forbidden.reason).toMatch(/403.*credentials/);
        expect(expectKind(await identifySource(`${s.url}/missing.tif`), "unknown").reason).toMatch(/404/);
        expect(expectKind(await identifySource(`${s.url}/page`), "unknown").reason).toMatch(/HTML page/);
        const other = expectKind(await identifySource(`${s.url}/other.json`), "unknown");
        expect(other.reason).toMatch(/neither a STAC document nor a ria-geotiff manifest/);
        expect(other.document).toEqual({name: "not stac"});
        expect(expectKind(await identifySource(`${s.url}/feature.json`), "unknown").reason).toMatch(/without stac_version/);
        expect(expectKind(await identifySource(`${s.url}/empty`), "unknown").reason).toMatch(/empty/);
        expect(expectKind(await identifySource(`${s.url}/text`), "unknown").reason).toMatch(/neither a TIFF nor JSON/);
    });

    it("reports an unreachable server as CORS or network failure", async () => {
        const s = await serve();
        const url = s.url;
        await s.close();
        servers = [];
        const found = expectKind(await identifySource(`${url}/x.tif`), "unknown");
        expect(found.reason).toBe("the server does not allow this page to read it (CORS), or it is unreachable");
    });

    it("sends credentials to the URL's origin, shows the URL without parameters, and applies rewriteUrl", async () => {
        const s = await serve();
        const found = await identifySource(`${s.url}/rgb-3857-uint8.tif`, {requestHeaders: {Authorization: "Bearer t"}, requestParameters: {token: "t0k"}});
        expect(found.url).toBe(`${s.url}/rgb-3857-uint8.tif`);
        expect(s.requests[0].headers.authorization).toBe("Bearer t");
        expect(s.requests[0].url).toContain("token=t0k");
        const kinds: string[] = [];
        await identifySource(`${s.url}/rgb-3857-uint8.tif`, {access: (_u, kind) => { kinds.push(kind); return null; },
            rewriteUrl: (u) => u.replace("rgb-3857-uint8", "gray-3857-uint16")});
        expect(kinds).toEqual(["source"]);
        expect(s.requests[1].url).toBe("/gray-3857-uint16.tif");
    });

    it("reads Blobs and Files, and rejects invalid arguments and aborts", async () => {
        const tif = readFileSync(join(FIXTURES, "s2-red-10m.tif"));
        const blob = new Blob([tif]);
        const found = expectKind(await identifySource(blob), "geotiff");
        expect(found.file).toBe(blob);
        expect(found.url).toBeUndefined();
        const manifest = new Blob([readFileSync(join(FIXTURES, "manifest-s2.json"))], {type: "application/json"});
        expectKind(await identifySource(manifest), "manifest");
        await expect(identifySource("")).rejects.toBeInstanceOf(RangeError);
        await expect(identifySource(42 as unknown as string)).rejects.toBeInstanceOf(RangeError);
        await expect(identifySource("relative/path.tif")).rejects.toBeInstanceOf(RangeError);
        const s = await serve();
        const controller = new AbortController();
        controller.abort(new Error("stopped"));
        await expect(identifySource(`${s.url}/rgb-3857-uint8.tif`, {signal: controller.signal})).rejects.toThrow("stopped");
    });
});
