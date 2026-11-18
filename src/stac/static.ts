/**
 * Static catalogs (no item search): collections found by following `child` links, items by following `item` (and
 * `child`) links, everything bounded, and every item tested on the client.
 */
import {StacError, type StacClient} from "./client.js";
import type {StacCollectionJson, StacItemJson, StacLink} from "./json.js";
import {absolutize} from "./links.js";
import {bboxOf} from "./geometry.js";
import {codeOf, normaliseDatetime, type Degradation, type SearchPlan, type StacSearchRequest} from "./plan.js";

/** Defaults of `StacClientOptions.crawl`. */
export const CRAWL_DEFAULTS = {maxDepth: 4, maxDocuments: 500, concurrency: 8} as const;

type Doc = { type?: string; id?: string; links?: StacLink[]; [key: string]: unknown };

/** The crawl limits of a client. */
function limits(client: StacClient) {
    return {...CRAWL_DEFAULTS, ...client.options.crawl};
}

/** Links of one relation, absolute (documents are absolutized when read). */
const hrefs = (doc: Doc, rel: string) => (doc.links ?? []).filter((l) => l?.rel === rel && typeof l.href === "string").map((l) => l.href);

/** Reads a document and resolves its relative hrefs against its URL. */
async function read(client: StacClient, url: string, signal?: AbortSignal): Promise<Doc> {
    const {json} = await client.send({method: "GET", url, headers: {Accept: "application/json"}}, signal);
    return absolutize(json as Doc, url);
}

/**
 * {@link read}, or null when the document cannot be read and `crawl.onError` is `"skip"` (the default): the failure
 * is then recorded in `client.crawlProblems`. Aborts always throw.
 */
async function readOrSkip(client: StacClient, url: string, signal?: AbortSignal): Promise<Doc | null> {
    try {
        return await read(client, url, signal);
    } catch (e) {
        if (signal?.aborted || (client.options.crawl?.onError ?? "skip") === "throw") throw e;
        client.noteCrawlProblem(url, e);
        return null;
    }
}

/** Runs `f` on every value, at most `n` at a time, keeping the order. */
async function inParallel<T, R>(values: T[], n: number, f: (v: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(values.length);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(n, values.length)}, async () => {
        while (next < values.length) {
            const i = next++;
            out[i] = await f(values[i]);
        }
    }));
    return out;
}

/**
 * The collections of a static catalog: the landing page when it is a collection, else the collections reached by
 * `child` links (collections' own children included), breadth first, at most `maxDepth` links deep and
 * `maxDocuments` documents read.
 *
 * @internal
 */
export async function crawlCollections(client: StacClient, landing: Doc, landingUrl: string): Promise<{ collections: StacCollectionJson[]; urls: Map<string, string> }> {
    const {maxDepth, maxDocuments, concurrency} = limits(client);
    const collections: StacCollectionJson[] = [];
    const urls = new Map<string, string>();
    const seen = new Set<string>([landingUrl]);
    let level: { url: string; doc: Doc }[] = [{url: landingUrl, doc: landing}];
    let read_ = 1;
    for (let depth = 0; level.length; depth++) {
        for (const {url, doc} of level) {
            if (doc.type === "Collection" && typeof doc.id === "string" && !urls.has(doc.id)) {
                collections.push(doc as unknown as StacCollectionJson);
                urls.set(doc.id, url);
            }
        }
        if (depth >= maxDepth) break;
        const children = level.flatMap(({doc}) => hrefs(doc, "child")).filter((u) => !seen.has(u) && (seen.add(u), true));
        const room = Math.max(0, maxDocuments - read_);
        const batch = children.slice(0, room);
        read_ += batch.length;
        const docs = await inParallel(batch, concurrency, async (url) => ({url, doc: await readOrSkip(client, url)}));
        level = docs.filter((d): d is { url: string; doc: Doc } => d.doc !== null);
    }
    return {collections, urls};
}

/**
 * Items reachable from `roots` through `item` and `child` links, in batches of `batch` items, until `maxScanned`
 * items were read or nothing is left. Items without `collection` get the id of the collection they were found under.
 *
 * @internal
 */
export async function* crawlItems(client: StacClient, roots: { url: string; collection?: string }[], options: {
    batch: number; maxScanned: number; signal?: AbortSignal;
}): AsyncGenerator<StacItemJson[]> {
    const {maxDepth, maxDocuments, concurrency} = limits(client);
    const seen = new Set<string>();
    const queue: { url: string; depth: number; collection?: string }[] = roots.map((r) => ({...r, depth: 0}));
    for (const r of roots) seen.add(r.url);
    const pending: { url: string; collection?: string }[] = [];
    let documents = 0, scanned = 0;
    const flush = async function* (all: boolean) {
        while (pending.length >= options.batch || (all && pending.length)) {
            const room = options.maxScanned - scanned;
            if (room <= 0) return;
            const take = pending.splice(0, Math.min(options.batch, room));
            const read_ = await inParallel(take, concurrency, async ({url, collection}) => {
                const item = await readOrSkip(client, url, options.signal) as unknown as StacItemJson | null;
                if (item && !item.collection && collection) item.collection = collection;
                return item;
            });
            const items = read_.filter((i): i is StacItemJson => i !== null);
            scanned += items.length;
            yield items;
        }
    };
    while (queue.length && scanned < options.maxScanned) {
        const {url, depth, collection} = queue.shift()!;
        if (documents >= maxDocuments) break;
        documents++;
        // The roots themselves must be readable; documents found through links may be skipped.
        const doc = depth === 0 ? await read(client, url, options.signal) : await readOrSkip(client, url, options.signal);
        if (!doc) continue;
        const here = doc.type === "Collection" && typeof doc.id === "string" ? doc.id : collection;
        if (doc.type === "Feature") {
            const item = doc as unknown as StacItemJson;
            if (!item.collection && here) item.collection = here;
            scanned++;
            yield [item];
            continue;
        }
        for (const href of hrefs(doc, "item")) if (!seen.has(href)) { seen.add(href); pending.push({url: href, collection: here}); }
        if (depth < maxDepth) for (const href of hrefs(doc, "child")) if (!seen.has(href)) { seen.add(href); queue.push({url: href, depth: depth + 1, collection: here}); }
        yield* flush(false);
    }
    yield* flush(true);
}

/**
 * The plan of a search on a static catalog: nothing is sent to a search endpoint; every part of the request is
 * tested on the client while the catalog is crawled.
 *
 * @internal
 */
export function staticPlan(landingUrl: string, request: StacSearchRequest, secretHeaders: string[]): SearchPlan {
    const maxScanned = request.maxScanned ?? 2000;
    const clientApplies: string[] = [];
    if (request.collections?.length) clientApplies.push("collections");
    if (request.ids?.length) clientApplies.push("ids");
    if (request.datetime !== undefined) clientApplies.push("datetime");
    if (request.area) clientApplies.push("area");
    if (request.where !== undefined || request.filter !== undefined) clientApplies.push("where/filter");
    const degradations: Degradation[] = [{kind: "static-catalog", reason: "the catalog has no item search: its item links are followed and each item is tested in the browser", maxScanned}];
    if (request.where !== undefined || request.filter !== undefined) {
        degradations.push({kind: "filter-client-side", reason: "a static catalog applies no filter", maxScanned});
    }
    if (request.sortby?.length) degradations.push({kind: "sort-dropped", reason: "a static catalog cannot sort"});
    if (request.fields) degradations.push({kind: "fields-dropped"});
    if (request.q) degradations.push({kind: "q-dropped"});
    const http = {method: "GET" as const, url: landingUrl, headers: {Accept: "application/json"}};
    return {request, http, filterEncoding: "client", serverApplies: [], clientApplies, degradations, code: codeOf(http, secretHeaders)};
}

/**
 * The plan of a search on an OGC API - Features server without STAC item search: a GET of the collection's `items`
 * endpoint with the standard `bbox`, `datetime` and `limit` parameters; ids, polygons and predicates are tested on the
 * client. One collection per search.
 *
 * @internal
 */
export function collectionItemsPlan(apiUrl: string, request: StacSearchRequest, pageSize: number, secretHeaders: string[]): SearchPlan {
    const collection = request.collections?.[0];
    if (!collection || request.collections!.length > 1) {
        throw new StacError("This API has no STAC item search: its collections are searched one at a time; give exactly one collection");
    }
    const url = new URL(`${apiUrl}/collections/${encodeURIComponent(collection)}/items`);
    const serverApplies = ["collections"];
    const clientApplies: string[] = [];
    url.searchParams.set("limit", String(request.limit ?? pageSize));
    if (request.area) {
        url.searchParams.set("bbox", bboxOf(request.area).join(","));
        serverApplies.push("bbox");
        if (!Array.isArray(request.area)) clientApplies.push("polygon");
    }
    const datetime = normaliseDatetime(request.datetime);
    if (datetime) { url.searchParams.set("datetime", datetime); serverApplies.push("datetime"); }
    if (request.ids?.length) clientApplies.push("ids");
    if (request.where !== undefined || request.filter !== undefined) clientApplies.push("where/filter");
    const maxScanned = request.maxScanned ?? 2000;
    const degradations: Degradation[] = [{kind: "collection-items", reason: "the API has no STAC item search: the collection's items endpoint is read and filtered in the browser", maxScanned}];
    if (request.where !== undefined || request.filter !== undefined) degradations.push({kind: "filter-client-side", reason: "an items endpoint applies no filter", maxScanned});
    if (request.sortby?.length) degradations.push({kind: "sort-dropped", reason: "an items endpoint cannot sort"});
    if (request.fields) degradations.push({kind: "fields-dropped"});
    if (request.q) degradations.push({kind: "q-dropped"});
    const http = {method: "GET" as const, url: url.toString(), headers: {Accept: "application/geo+json, application/json"}};
    return {request, http, filterEncoding: "client", serverApplies, clientApplies, degradations, code: codeOf(http, secretHeaders)};
}
