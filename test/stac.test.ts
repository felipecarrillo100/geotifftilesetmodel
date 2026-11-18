import {afterEach, describe, expect, it, vi} from "vitest";
import {
    assetBands, bestPerPeriod, coverArea, dedupeItems, emptyProfile, evaluateCql2, groupItems, itemBandNames,
    itemsCovering, normaliseDatetime, parseCapabilities, planetaryComputerSigner, planSearch, resolveAsset, sortItems,
    StacClient, toBandInputs, toCql2Text, type StacItemJson,
} from "../src/stac/index.js";

// ------------------------------------------------------------------------------------------------ fixtures

const C = (s: string) => `https://api.stacspec.org/v1.0.0/${s}`;
const CQL2 = (s: string) => `http://www.opengis.net/spec/cql2/1.0/conf/${s}`;

function item(id: string, props: Record<string, unknown>, bbox: [number, number, number, number] = [0, 0, 10, 10], assets: Record<string, unknown> = {}): StacItemJson {
    const [w, s, e, n] = bbox;
    return {
        type: "Feature", id, collection: "s2", bbox,
        geometry: {type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]},
        properties: {datetime: "2024-07-01T10:00:00Z", ...props},
        assets: assets as StacItemJson["assets"],
    };
}

/** A tiny STAC API with configurable quirks, answering through a stubbed fetch. */
function mockServer(options: {
    conformsTo?: string[];
    ignoresFilter?: boolean;
    ignoresQuery?: boolean;
    post405?: boolean;
    maxLimit?: number;
    landingNeedsSlash?: boolean;
    items: StacItemJson[];
    pageSize?: number;
    mergePaging?: boolean;
}) {
    const base = "https://stac.test/v1";
    const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
    const handler = async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        calls.push({method, url: url.toString(), body});
        if (url.pathname === "/v1" || url.pathname === "/v1/") {
            if (options.landingNeedsSlash && url.pathname === "/v1") throw new TypeError("Failed to fetch");
            return json(200, {type: "Catalog", id: "test", stac_version: "1.1.0", conformsTo: options.conformsTo ?? [],
                links: [{rel: "search", href: `${base}/search`, type: "application/geo+json"}, {rel: "data", href: `${base}/collections`}]});
        }
        if (url.pathname === "/v1/search") {
            if (method === "POST" && options.post405) return json(405, {detail: "Method Not Allowed"});
            const params = body ?? Object.fromEntries(url.searchParams.entries());
            const limit = Number(params.limit ?? 10);
            if (options.maxLimit && limit > options.maxLimit) return json(400, {detail: `limit must be <= ${options.maxLimit}`});
            let matches = options.items;
            const cc = (i: StacItemJson) => Number(i.properties["eo:cloud_cover"]);
            const filter = typeof params.filter === "string" ? undefined : params.filter as {op: string; args: [unknown, number]} | undefined;
            if (filter && !options.ignoresFilter) matches = matches.filter((i) => evaluateCql2(filter, i));
            const query = typeof params.query === "string" ? JSON.parse(params.query) : params.query as Record<string, {lt?: number}> | undefined;
            if (query && !options.ignoresQuery && query["eo:cloud_cover"]?.lt !== undefined) matches = matches.filter((i) => cc(i) < query["eo:cloud_cover"].lt!);
            const page = Number(params.page ?? 1);
            const size = Math.min(limit, options.pageSize ?? limit);
            const features = matches.slice((page - 1) * size, page * size);
            const links = page * size < matches.length
                ? [method === "POST"
                    ? {rel: "next", href: `${base}/search`, method: "POST", ...(options.mergePaging ? {merge: true, body: {page: page + 1}} : {body: {...params, page: page + 1}})}
                    : {rel: "next", href: `${base}/search?${new URLSearchParams({...Object.fromEntries(url.searchParams), page: String(page + 1)})}`}]
                : [];
            return json(200, {type: "FeatureCollection", features, links, numberMatched: matches.length});
        }
        return json(404, {detail: "not found"});
    };
    vi.stubGlobal("fetch", vi.fn(handler));
    return {base, calls};
}

afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------ tests

describe("capabilities and requests", () => {
    it("matches conformance classes by pattern, whatever their version segment", () => {
        const caps = parseCapabilities({conformsTo: [
            C("core"), C("item-search"), "https://api.stacspec.org/v1.0.0-rc.2/item-search#filter", C("item-search#query"),
            "https://api.stacspec.org/v1.0.0-rc.1/item-search#sort", CQL2("cql2-json"), CQL2("basic-cql2"),
        ]});
        expect(caps.itemSearch).toBe(true);
        expect(caps.filter).toMatchObject({cql2Json: true, cql2Text: false, advancedComparison: false});
        expect(caps.query && caps.sort).toBe(true);
        expect(parseCapabilities({conformsTo: [C("item-search")]}).filter).toBeNull();
    });

    it("normalises dates: partial dates are whole periods, times get Z", () => {
        expect(normaliseDatetime("2024")).toBe("2024-01-01T00:00:00Z/2024-12-31T23:59:59.999Z");
        expect(normaliseDatetime("2024-02")).toBe("2024-02-01T00:00:00Z/2024-02-29T23:59:59.999Z");
        expect(normaliseDatetime(["2018", null])).toBe("2018-01-01T00:00:00Z/..");
        expect(normaliseDatetime("2018/2026")).toBe("2018-01-01T00:00:00Z/2026-12-31T23:59:59.999Z");
        expect(normaliseDatetime("2024-06-15T10:00:00")).toBe("2024-06-15T10:00:00Z");
    });

    it("compiles a request per server: CQL2-JSON, the Query extension, or a client-side filter", () => {
        const request = {collections: ["s2"], area: [0, 0, 1, 1] as [number, number, number, number], where: {"eo:cloud_cover": {lt: 5}},
            sortby: [{field: "datetime", direction: "desc" as const}]};
        const pgstac = parseCapabilities({conformsTo: [C("item-search"), C("item-search#filter"), CQL2("cql2-json"), CQL2("cql2-text"), C("item-search#sort")]});
        const a = planSearch("https://x/search", request, pgstac, emptyProfile("https://x"));
        expect(a.filterEncoding).toBe("cql2-json");
        expect(a.http.body).toMatchObject({filter: {op: "<", args: [{property: "eo:cloud_cover"}, 5]}, "filter-lang": "cql2-json",
            sortby: [{field: "properties.datetime", direction: "desc"}], bbox: [0, 0, 1, 1], limit: 50});

        const stacServer = parseCapabilities({conformsTo: [C("item-search"), C("item-search#query")]});
        const b = planSearch("https://x/search", request, stacServer, emptyProfile("https://x"));
        expect(b.filterEncoding).toBe("query");
        expect(b.http.body?.query).toEqual({"eo:cloud_cover": {lt: 5}});
        expect(b.degradations.map((d) => d.kind)).toContain("sort-dropped");

        const bare = planSearch("https://x/search", request, parseCapabilities({conformsTo: [C("item-search")]}), emptyProfile("https://x"));
        expect(bare.filterEncoding).toBe("client");
        expect(bare.clientApplies).toContain("where/filter");

        // GET: CQL2-text, and a polygon goes as its bbox plus a client-side test.
        const polygon = {type: "Polygon" as const, coordinates: [[[0, 0], [2, 0], [0, 2], [0, 0]]]};
        const get = planSearch("https://x/search", {...request, area: polygon}, pgstac, {...emptyProfile("https://x"), postToGet: true});
        expect(get.http.method).toBe("GET");
        expect(new URL(get.http.url).searchParams.get("filter")).toBe("eo:cloud_cover < 5");
        expect(new URL(get.http.url).searchParams.get("bbox")).toBe("0,0,2,2");
        expect(get.clientApplies).toContain("polygon");
        expect(get.code.curl).toMatch(/^curl 'https:\/\/x\/search\?/);
    });

    it("writes and evaluates the CQL2 subset", () => {
        const e = {op: "and", args: [{op: "<", args: [{property: "eo:cloud_cover"}, 10]}, {op: "in", args: [{property: "platform"}, ["s2a", "s2b"]]},
            {op: "like", args: [{property: "id"}, "S2%"]}]};
        expect(toCql2Text(e)).toBe("(eo:cloud_cover < 10) AND (platform IN ('s2a', 's2b')) AND (id LIKE 'S2%')");
        expect(evaluateCql2(e, item("S2X", {"eo:cloud_cover": 3, platform: "s2b"}))).toBe(true);
        expect(evaluateCql2(e, item("S2X", {"eo:cloud_cover": 30, platform: "s2b"}))).toBe(false);
        // Regression: a timestamp literal compared as a number with the datetime string, so nothing matched.
        const after = {op: ">", args: [{property: "datetime"}, {timestamp: "2024-06-01T00:00:00Z"}]};
        expect(evaluateCql2(after, item("late", {datetime: "2024-07-01T10:00:00Z"}))).toBe(true);
        expect(evaluateCql2(after, item("early", {datetime: "2024-05-01T10:00:00Z"}))).toBe(false);
        expect(evaluateCql2({op: "between", args: [{property: "datetime"}, {date: "2024-06-01"}, {date: "2024-08-01"}]}, item("x", {}))).toBe(true);
        expect(evaluateCql2({op: "s_intersects", args: [{property: "geometry"}, {type: "Polygon", coordinates: [[[5, 5], [20, 5], [20, 20], [5, 5]]]}]},
            item("a", {}))).toBe(true);
    });
});

describe("StacClient against server quirks", () => {
    const items = Array.from({length: 30}, (_, i) => item(`it${i}`, {"eo:cloud_cover": i * 3, datetime: `2024-0${1 + (i % 9)}-15T10:00:00Z`}));

    it("retries the landing page with a trailing slash (redirects without CORS headers)", async () => {
        mockServer({items, landingNeedsSlash: true, conformsTo: [C("item-search")]});
        const client = await StacClient.connect("https://stac.test/v1");
        expect(client.profile.trailingSlash).toBe(true);
        expect(client.capabilities.itemSearch).toBe(true);
    });

    it("detects a filter the server ignores on the first page and falls back to the Query extension", async () => {
        const {calls} = mockServer({items, ignoresFilter: true, conformsTo: [C("item-search"), C("item-search#filter"), CQL2("cql2-json"), C("item-search#query")]});
        const client = await StacClient.connect("https://stac.test/v1");
        const search = client.search({where: {"eo:cloud_cover": {lt: 10}}});
        const found = await search.collect();
        expect(found.map((i) => i.id)).toEqual(["it0", "it1", "it2", "it3"]);
        expect(search.plan.filterEncoding).toBe("query");
        expect(client.profile.filterApplied).toBe("ignored");
        expect(calls.filter((c) => c.url.endsWith("/search")).length).toBe(2);   // the ignored attempt, then query
    });

    it("filters on the client, within a budget, when the server applies nothing", async () => {
        mockServer({items, ignoresFilter: true, ignoresQuery: true, pageSize: 10, conformsTo: [C("item-search"), C("item-search#query")]});
        const client = await StacClient.connect("https://stac.test/v1");
        const found = await client.search({where: {"eo:cloud_cover": {lt: 10}}, limit: 10}).collect();
        expect(found.map((i) => i.id)).toEqual(["it0", "it1", "it2", "it3"]);
        expect(client.profile.queryApplied).toBe("ignored");
        const capped = client.search({where: {"eo:cloud_cover": {gt: 80}}, limit: 10, maxScanned: 10});
        expect(await capped.collect()).toEqual([]);   // only the first page was scanned
    });

    it("follows next links: merged POST bodies, GET after a 405, smaller pages after a limit error", async () => {
        const merged = mockServer({items, mergePaging: true, pageSize: 10});
        let client = await StacClient.connect("https://stac.test/v1");
        expect((await client.search({limit: 10}).collect()).length).toBe(30);
        expect(merged.calls.filter((c) => c.method === "POST").map((c) => c.body?.page)).toEqual([undefined, 2, 3]);

        mockServer({items, post405: true, pageSize: 10});
        client = await StacClient.connect("https://stac.test/v1");
        expect((await client.search({limit: 10}).collect()).length).toBe(30);
        expect(client.profile.postToGet).toBe(true);

        mockServer({items, maxLimit: 20});
        client = await StacClient.connect("https://stac.test/v1");
        const search = client.search({limit: 50});
        expect((await search.collect()).length).toBe(30);
        expect(client.profile.maxLimit).toBe(12);   // halved twice: 50 → 25 → 12
        expect(await client.search({}).matched()).toEqual({value: 30, exact: true});
    });

    it("remembers what it learned in a JSON profile that a later session reuses", async () => {
        mockServer({items, ignoresFilter: true, conformsTo: [C("item-search"), C("item-search#filter"), CQL2("cql2-json"), C("item-search#query")]});
        const first = await StacClient.connect("https://stac.test/v1");
        await first.search({where: {"eo:cloud_cover": {lt: 10}}}).collect();
        const saved = JSON.parse(JSON.stringify(first.profile));
        const {calls} = mockServer({items, ignoresFilter: true, conformsTo: [C("item-search"), C("item-search#filter"), CQL2("cql2-json"), C("item-search#query")]});
        const second = await StacClient.connect("https://stac.test/v1", {profile: saved});
        expect(second.plan({where: {"eo:cloud_cover": {lt: 10}}}).filterEncoding).toBe("query");
        await second.search({where: {"eo:cloud_cover": {lt: 10}}}).collect();
        expect(calls.filter((c) => c.url.endsWith("/search")).length).toBe(1);   // no rediscovery
    });
});

describe("selection", () => {
    const area = [2, 2, 8, 8] as [number, number, number, number];

    it("covers an area with the fewest, best items", () => {
        const west = item("west", {"eo:cloud_cover": 1}, [0, 0, 5, 10]);
        const east = item("east", {"eo:cloud_cover": 2}, [5, 0, 10, 10]);
        const all = item("all", {"eo:cloud_cover": 40}, [0, 0, 10, 10]);
        const r = coverArea([all, east, west], area);
        expect(r.items.map((i) => i.id)).toEqual(["west", "east"]);
        expect(r.coverage).toBeGreaterThan(0.99);
        expect(itemsCovering([west, east, all], area).map((i) => i.id)).toEqual(["all"]);
    });

    it("picks the best item per period, groups, dedupes and sorts", () => {
        const a = item("a", {datetime: "2023-07-01T10:00:00Z", "eo:cloud_cover": 5});
        const b = item("b", {datetime: "2023-08-01T10:00:00Z", "eo:cloud_cover": 1});
        const c = item("c", {datetime: "2024-07-01T10:00:00Z", "eo:cloud_cover": 9, "proj:code": "EPSG:32723"});
        expect(bestPerPeriod([a, b, c], {period: "year"}).map((p) => [p.period, p.items[0].id])).toEqual([["2023", "b"], ["2024", "c"]]);
        expect(bestPerPeriod([a, b, c], {period: "month"}).map((p) => p.period)).toEqual(["2023-07", "2023-08", "2024-07"]);
        expect([...groupItems([a, c], "crs").keys()]).toEqual(["unknown", "EPSG:32723"]);
        expect(dedupeItems([a, a, b]).map((i) => i.id)).toEqual(["a", "b"]);
        expect(sortItems([a, b, c], [{field: "eo:cloud_cover", direction: "desc"}]).map((i) => i.id)).toEqual(["c", "a", "b"]);
    });
});

describe("assets and band inputs", () => {
    const s2 = item("S2", {}, undefined, {
        // Earth Search style (STAC 1.0)
        red: {href: "https://e84.test/B04.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized",
            "eo:bands": [{name: "B04", common_name: "red"}], "raster:bands": [{scale: 0.0001, offset: -0.1, nodata: 0}]},
        nir: {href: "https://e84.test/B08.tif", type: "image/tiff", "eo:bands": [{common_name: "nir"}]},
        nir08: {href: "https://e84.test/B8A.tif", type: "image/tiff", "eo:bands": [{common_name: "nir08"}]},
        scl: {href: "https://e84.test/SCL.tif", type: "image/tiff", roles: ["data"]},
        thumbnail: {href: "https://e84.test/t.jpg", type: "image/jpeg", roles: ["thumbnail"]},
    });
    const pc = Object.assign(item("PC", {}, undefined, {
        // Planetary Computer style: asset keys B04 / B08, STAC 1.1 bands
        B04: {href: "https://acct.blob.core.windows.net/cont/B04.tif", type: "image/tiff",
            bands: [{name: "B04", "eo:common_name": "red", "raster:scale": 0.0001, "raster:offset": -0.1, nodata: 0}]},
        B08: {href: "https://acct.blob.core.windows.net/cont/B08.tif", type: "image/tiff", bands: [{"eo:common_name": "nir"}]},
        SR_B5: {href: "s3://usgs/x.tif", type: "image/tiff", "storage:requester_pays": true, "eo:bands": [{common_name: "nir08"}]},
        // INPE style: scale and nodata inside eo:bands, a non-standard common name for the class band.
        SCL: {href: "https://x/scl.tif", type: "image/tiff", "eo:bands": [{name: "SCL", common_name: "quality", scale: 1, nodata: 0}]},
    }), {links: [{rel: "self", href: "https://planetarycomputer.microsoft.com/api/stac/v1/collections/s2/items/PC"}]});

    it("reads STAC 1.0 and 1.1 band metadata alike", () => {
        expect(assetBands(s2.assets.red)).toEqual([{name: "B04", commonName: "red", scale: 0.0001, offset: -0.1, nodata: 0}]);
        expect(assetBands(pc.assets.B04)).toEqual([{name: "B04", commonName: "red", scale: 0.0001, offset: -0.1, nodata: 0}]);
    });

    it("names bands by common name, so presets work on every catalog", () => {
        expect(itemBandNames(s2)).toEqual({red: "red", nir: "nir", nir08: "nir08", scl: "scl"});
        expect(itemBandNames(pc)).toEqual({B04: "red", B08: "nir", SR_B5: "nir08", SCL: "SCL"});   // "quality" is no EO role
        expect(itemBandNames(item("L", {}, undefined, {SR_B5: {href: "https://x/b5.tif", type: "image/tiff", "eo:bands": [{common_name: "nir08"}]}})))
            .toEqual({SR_B5: "nir"});   // Landsat: nir08 is the NIR band when nothing else is called nir
        expect(itemBandNames(pc, "asset-key")).toEqual({B04: "B04", B08: "B08", SR_B5: "SR_B5", SCL: "SCL"});
        expect(assetBands(pc.assets.SCL)).toEqual([{name: "SCL", scale: 1, nodata: 0}]);
        // Shared common names are ambiguous: Sentinel-2's three red-edge bands are all "rededge".
        const edges = item("E", {}, undefined, Object.fromEntries(["B05", "B06", "B07"].map((k) =>
            [k, {href: `https://x/${k}.tif`, type: "image/tiff", "eo:bands": [{common_name: "rededge"}]}])));
        expect(itemBandNames(edges)).toEqual({B05: "B05", B06: "B06", B07: "B07"});
    });

    it("opens only the assets a style reads, signs what needs it, and refuses unreadable assets", () => {
        const inputs = toBandInputs(s2, {style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)"}, mask: [{band: "scl", values: [9]}]}});
        expect(inputs.map((i) => [i.bands, i.resampling])).toEqual([["red", "bilinear"], ["nir", "bilinear"], ["scl", "nearest"]]);
        expect(inputs[0]).toMatchObject({url: "https://e84.test/B04.tif", scale: 0.0001, offset: -0.1, nodata: 0, sign: undefined});
        expect(resolveAsset(pc, "B04").readable).toBe("signed");
        expect(resolveAsset(pc, "SR_B5")).toMatchObject({readable: "no", reason: "requester-pays storage"});
        expect(() => toBandInputs(pc, {assets: ["SR_B5"]})).toThrow(/cannot be read from a browser/);
        expect(toBandInputs(pc, {assets: ["B04"], rename: (b) => `${b}_2024`})[0].bands).toBe("red_2024");
    });

    it("handles multiband assets: names from common names, or given per asset", () => {
        const naip = item("NAIP", {}, undefined, {image: {href: "https://x/naip.tif", type: "image/tiff", roles: ["data"],
            "eo:bands": [{name: "Red", common_name: "red"}, {common_name: "green"}, {common_name: "blue"}, {name: "NIR", common_name: "nir"}]}});
        expect(toBandInputs(naip)[0].bands).toEqual(["red", "green", "blue", "nir"]);
        expect(toBandInputs(naip, {style: {render: {type: "pseudocolor", band: "nir"}}}).length).toBe(1);
        const cbers = item("CB", {}, undefined, {tci: {href: "https://x/tci.tif", type: "image/tiff", roles: ["data"]}});
        expect(toBandInputs(cbers, {assets: ["tci"], bandNames: {tci: ["red", "green", "blue"]}, rename: (b) => `${b}_2026`})[0].bands)
            .toEqual(["red_2026", "green_2026", "blue_2026"]);
    });

        it("decides class bands from metadata first, then a key fallback, and lets you override", () => {
        const it = item("C", {}, undefined, {
            map: {href: "https://x/map.tif", type: "image/tiff", "classification:classes": [{value: 10}]},
            qa: {href: "https://x/qa.tif", type: "image/tiff", roles: ["cloud", "cloud-shadow"]},
            scl: {href: "https://x/scl.tif", type: "image/tiff", roles: ["data"]},
            red: {href: "https://x/red.tif", type: "image/tiff", "eo:bands": [{common_name: "red"}]},
        });
        expect(toBandInputs(it).map((i) => [i.bands, i.resampling])).toEqual([["map", "nearest"], ["qa", "nearest"], ["scl", "nearest"], ["red", "bilinear"]]);
        expect(toBandInputs(it, {resampling: {scl: "bilinear"}}).find((i) => i.bands === "scl")!.resampling).toBe("bilinear");
    });

        it("signs Planetary Computer URLs with a cached token", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({token: "st=1&se=2&sig=abc", "msft:expiry": new Date(Date.now() + 3600_000).toISOString()})));
        vi.stubGlobal("fetch", fetchMock);
        const sign = planetaryComputerSigner("https://pc.test/token");
        expect(await sign("https://acct.blob.core.windows.net/cont/a.tif")).toBe("https://acct.blob.core.windows.net/cont/a.tif?st=1&se=2&sig=abc");
        expect(await sign.sign("https://acct.blob.core.windows.net/cont/b.tif?x=1")).toBe("https://acct.blob.core.windows.net/cont/b.tif?x=1&st=1&se=2&sig=abc");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sign.matches("https://acct.blob.core.windows.net/cont/a.tif", pc)).toBe(true);
        expect(sign.matches("https://e84.test/B04.tif", pc)).toBe(false);
        // Regression: every Azure blob URL matched, so other Azure storage got Planetary Computer tokens.
        expect(sign.matches("https://acct.blob.core.windows.net/cont/a.tif")).toBe(false);
        const other = item("O", {}, undefined, {B04: {href: "https://mine.blob.core.windows.net/c/B04.tif", type: "image/tiff"}});
        expect(sign.matches("https://mine.blob.core.windows.net/c/B04.tif", other)).toBe(false);
        expect(resolveAsset(other, "B04").readable).toBe("yes");
    });
});
