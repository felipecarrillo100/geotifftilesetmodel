/**
 * A STAC API client for browsers: connect to an API URL, learn what it offers, describe collections, plan and run
 * searches. Everything it returns is plain JSON; what it learns about the server is kept in a profile that can be
 * saved and restored.
 */
import {assetBands, isDataAsset, type BandDescriptor} from "./bands.js";
import {emptyProfile, parseCapabilities, type ServerProfile, type StacCapabilities} from "./capabilities.js";
import type {Bbox, StacCatalogJson, StacCollectionJson, StacItemCollectionJson, StacItemJson, StacLink} from "./json.js";
import type {HttpRequestHeaders, HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";
import {accessFetch, originOf, type AccessHook, type RiaGeoTiffRequestListener} from "../http.js";
import {codeOf, itemMatches, planSearch, type FilterEncoding, type HttpRequestSpec, type SearchPlan, type StacSearchRequest} from "./plan.js";
import {bboxesIntersect, bboxOf} from "./geometry.js";
import {itemFootprints} from "./select.js";
import type {Bbox as AreaBbox, GeoJsonArea} from "./json.js";
import {absolutize} from "./links.js";
import {collectionItemsPlan, crawlCollections, crawlItems, staticPlan} from "./static.js";
import {checkSelection, selectItems, summarise, type CollectionDetails, type CollectionSummary, type Pick,
    type StacSelection, type StacSelectionResult} from "./catalog.js";
import {RiaGeoTiffError, type RiaGeoTiffProblem} from "../errors.js";

/** Options of {@link StacClient.connect}. All are optional.
 *
 * @category Client */
export interface StacClientOptions {
    /** fetch to use (auth, proxies, tests). Default: the global fetch. */
    fetch?: typeof fetch;
    /**
     * Called after every request of the client (kind `"stac-api"`: landing page, conformance, collections,
     * queryables, searches, crawled documents), with the URL as requested before `rewriteUrl` and without the
     * added `requestParameters`; see {@link "ria-geotiff"!RiaGeoTiffRequest | RiaGeoTiffRequest}.
     */
    onRequest?: RiaGeoTiffRequestListener;
    /**
     * Cookies and HTTP authentication of API requests, as LuciadRIA's option: `true` = `"include"`, `false` or
     * unset = `"same-origin"`, or a fetch mode.
     */
    credentials?: boolean | RequestCredentials;
    /**
     * Headers of API requests (`{Authorization: "Bearer …"}`), sent only to the API's origin: never to links on
     * another origin, nor to assets. Shown as `<redacted>` in plans.
     */
    requestHeaders?: HttpRequestHeaders | null;
    /**
     * Query parameters of API requests (`{token: "…"}`), sent only to the API's origin. Not shown in plans or errors.
     */
    requestParameters?: HttpRequestParameters | null;
    /**
     * Decides the options of each API request instead (kind `"stac-api"`), see {@link AccessHook}. It is called
     * before every request, so it is the way to renew a token: the client has no setter for its headers.
     */
    access?: AccessHook;
    /**
     * Rewrites the URL of every request of the client before it is sent (landing page, conformance, collections,
     * queryables, searches and their next pages, items), for example through a CORS proxy. The client never
     * requests assets, so they are not rewritten by it: pass `rewriteUrl` to `GeoTiffTileSetModel.create` (or to
     * `toBandInputs`) for those, which has the same signature.
     */
    rewriteUrl?: (url: string) => string;
    /**
     * HTTP method for searches: `"GET"` forces GET; `"auto"` and `"POST"` use POST unless the server profile says
     * POST is rejected (405), then GET. Default `"auto"`.
     */
    method?: "auto" | "GET" | "POST";
    /**
     * Page size of searches whose request gives no `limit`. Default 50: large pages fail on several servers (502
     * or 504). {@link StacClient.select} always asks for 100.
     */
    pageSize?: number;
    /** Retries of failed API requests (network errors and the listed HTTP statuses). */
    retry?: {
        /** Total number of attempts, including the first. Default 3. */
        attempts?: number;
        /** HTTP statuses that are retried. Default `[429, 502, 503, 504]`. */
        statuses?: number[];
        /**
         * Delay before the first retry, in milliseconds, doubled for each further retry. A `Retry-After` header
         * (seconds) takes precedence. Default 1000.
         */
        backoffMs?: number;
    };
    /** Timeout of each API request attempt, in milliseconds. Default 30000. */
    timeoutMs?: number;
    /**
     * Check the first page of each search against the request, and fall back when the server ignored a filter.
     * Default `"first-page"`.
     */
    verify?: "first-page" | "never";
    /** What an earlier session learned about this server. Ignored when its `url` is not this API's URL. */
    profile?: ServerProfile;
    /**
     * Limits of crawling a static catalog (see `StacCapabilities.staticCatalog`); ignored for APIs. Collections
     * are found through `child` links, items through `item` and `child` links; besides these limits a search
     * reads at most its `maxScanned` items (default 2000) and stops at `maxItems`.
     */
    crawl?: {
        /** How many `child` links deep to follow from the landing page (collections) or a collection (items). Default 4. */
        maxDepth?: number;
        /** Catalog and collection documents read at most per listing or search (items not counted). Default 500. */
        maxDocuments?: number;
        /** Documents requested at the same time. Default 8. */
        concurrency?: number;
        /**
         * What a document found through a link that cannot be read does: `"skip"` (default) leaves it out and records
         * it in {@link StacClient.crawlProblems}; `"throw"` rejects the listing or search with its `StacError`. The
         * catalog itself, and the collections a search starts from, must always be readable.
         */
        onError?: "skip" | "throw";
    };
}

/** A collection in a form ready for display and for planning searches; see {@link StacClient.describeCollection}.
 *
 * @category Client */
export interface CollectionDescription {
    /** Collection id. */
    id: string;
    /** Human-readable title. */
    title?: string;
    /** Longer description (CommonMark). */
    description?: string;
    /** License identifier. */
    license?: string;
    /** Keywords. */
    keywords?: string[];
    /** Overall bbox (the first one), and the subsets that follow it. 3D boxes are reduced to 2D. */
    bbox?: Bbox;
    /** The bboxes after the first (subsets of the overall extent); empty when there are none. */
    subBboxes: Bbox[];
    /** Overall interval as RFC 3339 strings, open ends as null (`[null, null]` when the collection has none). */
    interval: [string | null, string | null];
    /** The collection's summaries (empty object when it has none). */
    summaries: Record<string, unknown>;
    /** Data assets declared in item_assets, with their bands. Empty when the collection has no item_assets. */
    assets: {
        /** Asset key, as in each item's `assets`. */
        key: string;
        /** Human-readable title. */
        title?: string;
        /** Asset roles (empty when none are declared). */
        roles: string[];
        /** Media type. */
        type?: string;
        /** Bands of the asset. */
        bands: BandDescriptor[];
    }[];
    /** EO common names to asset keys (`{red: "B04"}` or `{red: "red"}`). */
    commonNames: Record<string, string>;
    /** The collection JSON it was made from. */
    raw: StacCollectionJson;
}

/** A property a search can filter on; see {@link StacClient.queryables}.
 *
 * @category Client */
export interface Queryable {
    /** Property name, for example `"eo:cloud_cover"`. */
    name: string;
    /** Human-readable title (queryables endpoint only). */
    title?: string;
    /** JSON schema type, for example `"number"` or `"string"` (queryables endpoint only). */
    type?: string;
    /** Allowed values, when listed. */
    enum?: unknown[];
    /** Smallest value, when known. */
    minimum?: number;
    /** Largest value, when known. */
    maximum?: number;
    /** Where it was found: the queryables endpoint, or collection summaries when the server has none. */
    source: "queryables" | "summaries";
}

/**
 * Where a {@link StacClient.select} or a {@link StacClient.search} stands, given to their `onProgress` callback:
 * once when `select` starts reading the collection, after every page of results, and once when `select` starts
 * picking.
 *
 * @category Client
 */
export interface StacProgress {
    /** `"collection"`: reading the collection (select only); `"search"`: a page arrived; `"pick"`: choosing (select only). */
    step: "collection" | "search" | "pick";
    /** Pages received so far. */
    pages: number;
    /** Items read so far (before client-side checks; for a static catalog, item documents read). */
    scanned: number;
    /** Items kept so far (they match the request). */
    kept: number;
    /** The server's total for the search, when it reports one. */
    matched?: number;
}

/**
 * An error of a STAC API request, with the HTTP status, URL and response body when known; or of a selection that
 * cannot succeed, with its problems.
 *
 * Errors of {@link StacClient.select} (and of `GeoTiffTileSetModel.create({stac: {catalog, ...}})`) about the selection
 * itself have {@link "ria-geotiff"!RiaGeoTiffError.problems | problems}: those of {@link StacClient.check}, and, when
 * no item is left, one warning per requirement that excluded items. Those errors have no `status`. Request errors
 * have an empty `problems` list.
 *
 * Whether a method throws or rejects follows its return type: `connect`, `collections`, `collection`, `select`,
 * `items` and the other methods returning a promise reject; {@link StacClient.plan} and {@link StacClient.search}
 * throw synchronously; the pages of a {@link StacSearch} throw from the async generator. {@link StacClient.check}
 * makes no requests and reports problems in its result instead of throwing. An aborted signal rejects with the
 * signal's reason (an `AbortError` `DOMException` by default), not with a `StacError`.
 *
 * @category Errors */
export class StacError extends RiaGeoTiffError {
    /**
     * Creates an error; the client throws these, applications rarely need to.
     *
     * @param message Error message.
     * @param status HTTP status of the response, undefined for network errors, timeouts and selection errors.
     * @param url The URL that was requested.
     * @param body The response body: parsed JSON, or text when it is not JSON.
     * @param problems The problems of the selection, for errors of {@link StacClient.select} about the selection.
     *   Default none.
     */
    constructor(message: string, readonly status?: number, readonly url?: string, readonly body?: unknown,
        problems: RiaGeoTiffProblem[] = []) {
        super(message, problems);
        this.name = "StacError";
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A client for one STAC API. Create it with {@link StacClient.connect}; it reads the landing page and conformance
 * classes once, then lists and describes collections and plans and runs item searches. What it learns about the
 * server while doing so is kept in {@link StacClient.profile}.
 *
 * @category Client
 */
export class StacClient {
    /** The API URL, without trailing slashes. */
    readonly url: string;
    /** The landing page JSON. */
    readonly landing: StacCatalogJson;
    /** What the API claims to support, from its conformance classes and links. */
    readonly capabilities: StacCapabilities;
    /**
     * Set when {@link StacClient.connect} was given the URL of a collection: the id of that collection, for a user
     * interface to preselect. Undefined when it was given a landing page or catalog.
     */
    readonly collectionId?: string;
    private _profile: ServerProfile;
    private readonly _options: StacClientOptions;
    private readonly _crawlProblems = new Map<string, { url: string; message: string; status?: number }>();
    private readonly _listeners = new Set<(p: ServerProfile) => void>();
    private _collections?: Promise<StacCollectionJson[]>;
    private readonly _details = new Map<string, CollectionDetails>();
    private _static?: Promise<{ collections: StacCollectionJson[]; urls: Map<string, string> }>;
    /** The URL the landing page was read from (relative links of a static catalog resolve against it). */
    private readonly _landingUrl: string;

    private constructor(url: string, landing: StacCatalogJson, capabilities: StacCapabilities, profile: ServerProfile, options: StacClientOptions,
        landingUrl = url, collectionId?: string) {
        this._landingUrl = landingUrl;
        if (collectionId !== undefined) this.collectionId = collectionId;
        this.url = url;
        this.landing = landing;
        this.capabilities = capabilities;
        this._profile = profile;
        this._options = options;
    }

    /**
     * Reads the landing page (and `/conformance` when the landing page lists no classes). A landing page that
     * cannot be read is retried with a trailing slash: some servers redirect without CORS headers.
     *
     * The URL can also be a collection's (`…/collections/sentinel-2-l2a`, or a static `collection.json`): the client
     * is then of the API that serves it, with {@link StacClient.collectionId} set to the collection's id. The API is
     * its `root` link (else `parent`), used when it can search (item search, or an OGC API - Features collections
     * endpoint); otherwise (a static collection, or an API that
     * cannot be read) the client crawls the collection itself, as a static catalog. Credentials, headers and
     * parameters go to that API only when it is on the origin of the URL given; the `access` hook decides as for any
     * request.
     *
     * The URL may also be a static catalog or collection (a `catalog.json` file, no item search): then
     * `capabilities.staticCatalog` is true, no conformance request is made (when the landing page has no
     * `conformance`, `search` or `data` link), relative links resolve against the landing page's URL, and
     * collections and items are found by crawling links (see {@link StacClientOptions.crawl}).
     *
     * Trailing slashes are removed from `url`. The landing page is requested once per variant (no retries); when the
     * profile says the server needs a trailing slash, that variant is tried first. The conformance endpoint is the
     * landing page's `conformance` link, else `{url}/conformance`; failing to read it is not an error.
     *
     * @param url The URL of a STAC API landing page, a static catalog, or a collection (of an API or static).
     * @param options Client options; see {@link StacClientOptions}.
     * @returns A promise of the connected client.
     * @throws {@link StacError} (the promise rejects) when the landing page (or collection) cannot be read with or
     *   without a trailing slash.
     * @example
     * ```ts
     * const catalogUrl = "https://example.com/stac/v1"; // the STAC API URL the user entered
     * const client = await StacClient.connect(catalogUrl, {pageSize: 100});
     * console.log(client.landing.title, client.capabilities.itemSearch);
     *
     * // A collection URL: the client of its API, with the collection preselected.
     * const collectionUrl = ...;   // what the user pasted, e.g. ".../collections/sentinel-2-l2a"
     * const api = await StacClient.connect(collectionUrl);
     * const collection = await api.collection(api.collectionId!);
     * ```
     */
    static async connect(url: string, options: StacClientOptions = {}): Promise<StacClient> {
        const base = url.replace(/\/+$/, "");
        const profile = options.profile && options.profile.url === base ? {...options.profile} : emptyProfile(base);
        const probe = new StacClient(base, {}, parseCapabilities({}), profile, options);
        const variants = profile.trailingSlash ? [`${base}/`, base] : [base, `${base}/`];
        let landing: StacCatalogJson | undefined;
        let landingUrl = base;
        let lastError: unknown;
        for (const v of variants) {
            try {
                // No retries: a failed landing page is usually CORS (deterministic), try the next variant at once.
                landing = await probe.json<StacCatalogJson>(v, 1);
                landingUrl = v;
                if (v.endsWith("/")) probe._profile.trailingSlash = true;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!landing) {
            throw new StacError(`Cannot read the STAC API at ${url}: ${(lastError as Error)?.message ?? lastError}. `
                + "When the API works in a plain browser tab, the server probably sends no CORS headers: use rewriteUrl with a proxy.", undefined, url);
        }
        let conformance: string[] | undefined;
        const rels = new Set((landing.links ?? []).map((l) => l.rel));
        const maybeApi = rels.has("conformance") || rels.has("search") || rels.has("data") || !(landing.type === "Catalog" || landing.type === "Collection");
        if (!landing.conformsTo?.length && maybeApi) {
            const link = landing.links?.find((l) => l.rel === "conformance")?.href ?? `${base}/conformance`;
            conformance = await probe.json<{ conformsTo?: string[] }>(link).then((c) => c.conformsTo, () => undefined);
        }
        const capabilities = parseCapabilities(landing, conformance);
        if (capabilities.staticCatalog) absolutize(landing, landingUrl);
        if (landing.type === "Collection" && typeof landing.id === "string") {
            const api = await StacClient.apiOfCollection(landing, landingUrl, url, options);
            if (api) return api;
            return new StacClient(base, landing, capabilities, probe._profile, options, landingUrl, landing.id);
        }
        return new StacClient(base, landing, capabilities, probe._profile, options, landingUrl);
    }

    /** The client of the API that serves a collection (its root link, else parent), when that API has item search. */
    private static async apiOfCollection(collection: StacCatalogJson, collectionUrl: string, given: string, options: StacClientOptions): Promise<StacClient | null> {
        const link = collection.links?.find((l) => l.rel === "root") ?? collection.links?.find((l) => l.rel === "parent");
        if (!link?.href) return null;
        let root: string;
        try {
            root = new URL(link.href, collectionUrl).toString();
        } catch {
            return null;
        }
        if (root.replace(/\/+$/, "") === collectionUrl.replace(/\/+$/, "")) return null;
        // The API is a discovered URL: the application's credentials only go there on the origin it gave.
        const sameOrigin = originOf(root) !== null && originOf(root) === originOf(new URL(given, collectionUrl).toString());
        const rootOptions: StacClientOptions = sameOrigin ? options
            : {...options, credentials: undefined, requestHeaders: undefined, requestParameters: undefined, profile: undefined};
        try {
            const api = await StacClient.connect(root, rootOptions);
            const searchable = api.capabilities.search === "item-search" || api.capabilities.search === "collection-items";
            if (!searchable || api.collectionId !== undefined) return null;
            return new StacClient(api.url, api.landing, api.capabilities, api._profile, rootOptions, api._landingUrl, collection.id as string);
        } catch {
            return null;
        }
    }

    /**
     * Documents of a static catalog that could not be read while crawling (with `crawl.onError: "skip"`, the
     * default): one entry per URL, with the error message and the HTTP status when there was one. Empty for APIs.
     * The list grows as listings and searches crawl further.
     *
     * @returns a copy of the list, in the order the failures happened
     */
    get crawlProblems(): {
        /** The document that could not be read. */
        url: string;
        /** Why, in English, for display. */
        message: string;
        /** The HTTP status, when the server answered with an error. */
        status?: number;
    }[] {
        return [...this._crawlProblems.values()].map((p) => ({...p}));
    }

    /** @internal Records a document that could not be read while crawling. */
    noteCrawlProblem(url: string, error: unknown): void {
        const status = (error as StacError)?.status;
        this._crawlProblems.set(url, {url, message: (error as Error)?.message ?? String(error), ...(status !== undefined ? {status} : {})});
    }

    /** What the client learned about the server (save it and pass it to connect next time). Returns a copy. */
    get profile(): ServerProfile {
        return {...this._profile};
    }

    /**
     * Calls a listener whenever the profile changes, for example to save it.
     *
     * @param listener Called with a copy of the new profile.
     * @returns A function that removes the listener.
     */
    onProfileChange(listener: (p: ServerProfile) => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** @internal */
    learn(update: Partial<ServerProfile>): void {
        const before = JSON.stringify(this._profile);
        Object.assign(this._profile, update, {learnedAt: new Date().toISOString()});
        if (JSON.stringify(this._profile) !== before) this._listeners.forEach((l) => l(this.profile));
    }

    private link(rel: string): string | undefined {
        return this.landing.links?.find((l) => l.rel === rel)?.href;
    }

    /** The search endpoint, or undefined when the API has no item search. */
    get searchUrl(): string | undefined {
        return this.link("search") ?? (this.capabilities.itemSearch ? `${this.url}/search` : undefined);
    }

    // ------------------------------------------------------------------------------------------- collections

    /**
     * All collections (following paging links), fetched once and cached.
     *
     * Reads the landing page's `data` link, else `{url}/collections`, and follows `next` links until there are none,
     * a link repeats, or 10000 collections were read. A static catalog is crawled instead: the landing page when it
     * is a collection, else the collections reached by `child` links, breadth first, within
     * {@link StacClientOptions.crawl} (default 4 links deep, 500 documents).
     *
     * @returns A promise of the collections JSON, in server order. The same promise is returned on later calls, unless
     *   it failed: a failure is not cached.
     * @throws {@link StacError} (the promise rejects) when a page cannot be read.
     * @example
     * ```ts
     * const collections = await client.listCollections();
     * for (const c of collections) console.log(c.id, c.title);
     * ```
     */
    listCollections(): Promise<StacCollectionJson[]> {
        this._collections ??= this.capabilities.staticCatalog ? this.staticCatalog().then((s) => s.collections) : (async () => {
            const out: StacCollectionJson[] = [];
            let url: string | undefined = this.link("data") ?? `${this.url}/collections`;
            const seen = new Set<string>();
            while (url && !seen.has(url) && out.length < 10000) {
                seen.add(url);
                const page: { collections?: StacCollectionJson[]; links?: StacLink[] } = await this.json(url);
                out.push(...(page.collections ?? []));
                url = page.links?.find((l) => l.rel === "next")?.href;
            }
            return out;
        })();
        // A failure is not cached: the next call tries again.
        const pending = this._collections;
        pending.catch(() => { if (this._collections === pending) this._collections = undefined; });
        return pending;
    }

    /**
     * Collections whose extent overlaps a bbox and an interval, and whose text matches `q` (client side).
     *
     * Filters the result of {@link StacClient.listCollections}. Collections without a spatial or temporal extent
     * pass the corresponding test. Boxes whose west edge is greater than their east edge cross the antimeridian,
     * for the filter and for the collections' extents alike. `q` matches case-insensitively as a substring of the
     * id, title, description or a keyword.
     *
     * @param filter What to match; every part is optional and an empty filter returns all collections.
     * @returns A promise of the matching collections JSON.
     * @throws {@link StacError} (the promise rejects) when the collections cannot be listed.
     * @example
     * ```ts
     * const searchText = "sentinel"; // text the user typed
     * const found = await client.findCollections({
     *     bbox: [-10, 35, 5, 44],
     *     datetime: ["2024-01-01T00:00:00Z", null],
     *     q: searchText,
     * });
     * ```
     */
    async findCollections(filter: {
        /** Area of interest `[west, south, east, north]` in longitude/latitude (`west > east` crosses the antimeridian). */
        bbox?: Bbox;
        /** Interval `[start, end]` as RFC 3339 (or anything `Date.parse` reads), null for an open end. */
        datetime?: [string | null, string | null];
        /** Text to look for in the id, title, description and keywords (case-insensitive). */
        q?: string;
    } = {}): Promise<StacCollectionJson[]> {
        const all = await this.listCollections();
        const t0 = filter.datetime?.[0] ? Date.parse(filter.datetime[0]) : -Infinity;
        const t1 = filter.datetime?.[1] ? Date.parse(filter.datetime[1]) : Infinity;
        const q = filter.q?.toLowerCase();
        return all.filter((c) => {
            const d = describe(c);
            if (filter.bbox && d.bbox && !bboxesIntersect(filter.bbox, d.bbox)) return false;
            const i0 = d.interval[0] ? Date.parse(d.interval[0]) : -Infinity, i1 = d.interval[1] ? Date.parse(d.interval[1]) : Infinity;
            if (i0 > t1 || i1 < t0) return false;
            if (q && ![c.id, c.title, c.description, ...(c.keywords ?? [])].some((t) => t?.toLowerCase().includes(q))) return false;
            return true;
        });
    }

    /**
     * A collection's extent, data assets, bands and summaries, ready for display and for planning searches.
     *
     * Uses the cached result of {@link StacClient.listCollections} when it has `item_assets`, else requests
     * `{url}/collections/{id}`.
     *
     * @param id The collection id.
     * @returns A promise of the description.
     * @throws {@link StacError} (the promise rejects) when the collection cannot be read (for example HTTP 404).
     * @example
     * ```ts
     * const collectionId = collections[0].id; // a collection the user picked
     * const description = await client.describeCollection(collectionId);
     * const dataAssets = description.assets.map((a) => a.key);
     * const redAsset = description.commonNames.red; // asset key of the red band, when known
     * ```
     */
    async describeCollection(id: string): Promise<CollectionDescription> {
        if (this.capabilities.staticCatalog) {
            const found = (await this.listCollections()).find((c) => c.id === id);
            if (!found) throw new StacError(`The static catalog ${this.url} has no collection "${id}" (within the crawl limits)`, 404, this.url);
            return describe(found);
        }
        const cached = (await this._collections?.catch(() => undefined))?.find((c) => c.id === id);
        return describe(cached?.item_assets ? cached : await this.json<StacCollectionJson>(`${this.url}/collections/${encodeURIComponent(id)}`));
    }

    /**
     * Properties a search can filter on: the queryables endpoint, else the collection's summaries.
     *
     * Requests `{url}/collections/{collection}/queryables`, or `{url}/queryables` without a collection. When that
     * fails or lists no properties, the collection's summaries are used: ranges give `minimum`/`maximum` and lists
     * give `enum`. Without a collection there is no fallback. A static catalog has no queryables endpoint: only the
     * summaries are used, without a request.
     *
     * @param collection The collection id; omit for the queryables of the whole API.
     * @returns A promise of the queryables; empty when none are known.
     * @throws {@link StacError} (the promise rejects) when the fallback cannot read the collection.
     * @example
     * ```ts
     * const collectionId = collections[0].id; // a collection the user picked
     * const queryables = await client.queryables(collectionId);
     * const cloudCover = queryables.find((q) => q.name === "eo:cloud_cover");
     * ```
     */
    async queryables(collection?: string): Promise<Queryable[]> {
        if (this.capabilities.staticCatalog) return collection ? summaryQueryables(await this.describeCollection(collection)) : [];
        const url = collection ? `${this.url}/collections/${encodeURIComponent(collection)}/queryables` : `${this.url}/queryables`;
        try {
            const schema = await this.json<{ properties?: Record<string, Record<string, unknown>> }>(url);
            const props = Object.entries(schema.properties ?? {});
            if (props.length) {
                return props.map(([name, p]) => ({name, title: p.title as string | undefined, type: p.type as string | undefined,
                    enum: p.enum as unknown[] | undefined, minimum: p.minimum as number | undefined, maximum: p.maximum as number | undefined, source: "queryables"}));
            }
        } catch {
            // No queryables endpoint (404 on some servers): fall back to summaries.
        }
        if (!collection) return [];
        return summaryQueryables(await this.describeCollection(collection));
    }

    /** The collections of a static catalog, crawled once (a failure is not cached). */
    private staticCatalog() {
        this._static ??= crawlCollections(this, this.landing, this._landingUrl);
        const pending = this._static;
        pending.catch(() => { if (this._static === pending) this._static = undefined; });
        return pending;
    }

    /** @internal Where a static search starts: the URLs of the requested collections, else the landing page. */
    async staticRoots(collections: string[] | undefined): Promise<{ url: string; collection?: string }[]> {
        if (!collections?.length) return [{url: this._landingUrl}];
        const {urls} = await this.staticCatalog();
        return collections.map((id) => {
            const url = urls.get(id);
            if (!url) throw new StacError(`The static catalog ${this.url} has no collection "${id}" (within the crawl limits)`, 404, this.url);
            return {url, collection: id};
        });
    }

    /**
     * Step 1 of the workflow: the collections that overlap an area and a period and whose text matches `q`,
     * summarised for choosing (extent, bands, filterable properties).
     *
     * Filters the result of {@link StacClient.listCollections} (client side). Collections without a spatial or
     * temporal extent pass the corresponding test. The area's bbox is compared with each collection's bbox (the test
     * of {@link bboxesIntersect}); a collection bbox crossing the antimeridian (`west > east`) is handled. The list is
     * read once and cached, so calling this again with another filter (the view moved) makes no requests.
     *
     * @param filter What to match; every part is optional and an empty filter returns all collections.
     * @returns A promise of the collection summaries, in server order.
     * @throws {@link StacError} (the promise rejects) when the collections cannot be listed.
     * @example
     * ```ts
     * const catalogUrl = ...;   // the STAC API URL the user entered
     * const area = ...;         // [west, south, east, north] the user drew
     * const catalog = await StacClient.connect(catalogUrl);
     * const collections = await catalog.collections({area, datetime: ["2024-01-01", null]});
     * for (const c of collections) console.log(c.id, c.title, c.bands.join(", "));
     * ```
     */
    async collections(filter: {
        /** Area of interest: `[west, south, east, north]` or a GeoJSON (multi)polygon, in longitude/latitude. */
        area?: AreaBbox | GeoJsonArea;
        /** Interval `[start, end]` as RFC 3339 (or anything `Date.parse` reads), null for an open end. */
        datetime?: [string | null, string | null];
        /** Text to look for in the id, title, description and keywords (case-insensitive). */
        q?: string;
        /**
         * Ids of collections to keep whatever the other tests say, for example the collection the user pasted or
         * chose before, so it stays in the list when "only collections covering the view" is ticked.
         */
        include?: string[];
    } = {}): Promise<CollectionSummary[]> {
        const found = await this.findCollections({bbox: filter.area ? bboxOf(filter.area) : undefined, datetime: filter.datetime, q: filter.q});
        const include = new Set(filter.include ?? []);
        const all = include.size ? await this.listCollections() : found;
        return all.filter((c) => include.has(c.id) || found.includes(c)).map((c) => summarise(describe(c)));
    }

    /**
     * Step 1 of the workflow, for one collection: its summary plus its queryables, data assets and JSON. Cached:
     * {@link StacClient.check} uses the last details read.
     *
     * @param id The collection id.
     * @returns A promise of the details. Queryables that cannot be read are left empty.
     * @throws {@link StacError} (the promise rejects) when the collection cannot be read (for example HTTP 404).
     * @example
     * ```ts
     * const id = ...;           // the collection id the user picked
     * const collection = await catalog.collection(id);   // catalog: a connected StacClient
     * console.log(collection.interval, collection.bands, collection.queryables.map((q) => q.name));
     * ```
     */
    async collection(id: string): Promise<CollectionDetails> {
        const d = await this.describeCollection(id);
        const queryables = await this.queryables(id).catch(() => []);
        const details: CollectionDetails = {...summarise(d), description: d.description, license: d.license, queryables,
            assets: d.assets, commonNames: d.commonNames, raw: d.raw};
        this._details.set(id, details);
        return details;
    }

    /**
     * Step 2 of the workflow, before any search: the problems of a selection against its collection. An area or
     * period outside the collection's extent, or bands it does not offer, are errors (the search cannot succeed);
     * bands that only the items can confirm, and filters on properties the server does not list as queryables, are
     * warnings. No network.
     *
     * @param selection What the user chose.
     * @param collection The collection's details from {@link StacClient.collection}. Default: the details read last
     *   for `selection.collection`; without any, a single error says the collection is unknown.
     * @returns The problems; an empty list when the selection fits the collection.
     * @example
     * ```ts
     * const selection = {collection: id, area, datetime: "2024", bands: ["red", "nir"], maxCloud: 20};
     * for (const p of catalog.check(selection, collection)) console.log(p.severity, p.path, p.message);
     * ```
     */
    check(selection: StacSelection, collection?: CollectionDetails): RiaGeoTiffProblem[] {
        return checkSelection(selection, collection ?? this._details.get(selection.collection));
    }

    /**
     * Step 2 of the workflow: searches the collection and picks items. Asynchronous: every problem rejects the
     * promise. The steps:
     *
     * 1. Reads the collection with {@link StacClient.collection} (collection JSON and queryables) and checks the
     *    selection with {@link StacClient.check}. Errors reject; warnings are returned in `problems`.
     * 2. Searches with `area`, `datetime`, `where` and `maxCloud`, 100 items per page, until `maxItems` (default
     *    300) items or the last page. The filters are compiled for the server, see {@link StacClient.plan}.
     * 3. Applies `pick` (see {@link Pick}): `months`, then `coverage` (with an area), then `per` or `rank`. When
     *    the result can hold several items (`per`, or a mosaic of `coverage: "best"`), only the candidates of one
     *    coordinate reference are used; the others are listed in {@link StacSelectionResult.dropped}.
     *
     * When no single item covers the area, the default `coverage: "full"` leaves nothing and the promise rejects:
     * use `coverage: "best"` to get a mosaic of several items instead.
     *
     * Every item found is listed in {@link StacSelectionResult.candidates} with its coverage of the area, its
     * period, and whether it was picked or why not. When nothing is left, the rejection's `problems` say which
     * rule excluded how many items (`pick.months`, `pick.coverage`), or that the search found nothing.
     *
     * @param selection What to search, and `pick`: how to choose, see {@link Pick}.
     * @param options `signal` aborts the requests (the promise rejects with the signal's reason); `onProgress` is
     *   called when reading the collection, after every page of the search, and before picking.
     * @returns A promise of the picked items, their periods (with `pick.per`), the number found, every candidate
     *   with the reason it was not picked, the search plan and the warnings.
     * @throws {@link StacError} (rejection) when the selection has errors, when the collection cannot be read (it
     *   is then reported as unknown), or when no item is left after picking; these errors have
     *   `problems`. Also when a request fails (`status`, `url`, `body`), or the API has no item search.
     * @throws The signal's reason (rejection) when `options.signal` aborts.
     * @example
     * ```ts
     * const found = await catalog.select({collection: id, area, datetime: ["2018", null], maxCloud: 10,
     *     pick: {per: "year"}});
     * for (const c of found.candidates) console.log(c.item.id, c.period, c.picked ? "picked" : c.reason);
     * const model = await GeoTiffTileSetModel.create({stac: {items: found.items, per: "year"}});
     * map.layerTree.addChild(new RasterTileSetLayer(model, {label: id}));   // map: your LuciadRIA WebGLMap
     * ```
     */
    select(selection: StacSelection & {
        /** How to choose among the items found. */
        pick?: Pick;
    }, options: {
        /** Aborts the requests: the promise then rejects with the signal's reason. */
        signal?: AbortSignal;
        /** Called as the selection advances, see {@link StacProgress}. */
        onProgress?: (progress: StacProgress) => void;
    } = {}): Promise<StacSelectionResult> {
        return selectItems(this, selection, options);
    }

    // ------------------------------------------------------------------------------------------- search

    /**
     * The request compiled for this server, without sending it.
     *
     * Chooses the method, filter encoding (CQL2-JSON, CQL2-Text, Query extension or client side) and page size from
     * the capabilities, the options and the profile, and lists what the server and the client apply and what was
     * degraded. For a static catalog the plan applies everything on the client (encoding `"client"`, degradation
     * `static-catalog`), and `http` is the GET of the landing page.
     *
     * @param request The search request.
     * @param exclude Filter encodings not to use. Default `[]`.
     * @returns The plan, with the HTTP request and equivalent curl and fetch code.
     * @throws {@link StacError} When the API cannot be searched (`capabilities.search` is `"none"`), or when it is
     *   searched through a collection's items endpoint (`"collection-items"`) and the request does not give exactly
     *   one collection.
     * @example
     * ```ts
     * const collectionId = collections[0].id; // a collection the user picked
     * const plan = client.plan({collections: [collectionId], area: [-10, 35, 5, 44], datetime: "2024-06",
     *     where: {"eo:cloud_cover": {lt: 20}}});
     * console.log(plan.filterEncoding, plan.degradations, plan.code.curl);
     * ```
     */
    plan(request: StacSearchRequest, exclude: FilterEncoding[] = []): SearchPlan {
        const url = this.searchUrl;
        if (!url && this.capabilities.staticCatalog) return staticPlan(this._landingUrl, request, Object.keys(this._options.requestHeaders ?? {}));
        if (!url && this.capabilities.search === "collection-items") {
            return collectionItemsPlan(this.url, request, this._options.pageSize ?? 50, Object.keys(this._options.requestHeaders ?? {}));
        }
        if (!url) throw new StacError("This STAC API has no item search");
        const plan = planSearch(url, request, this.capabilities, this._profile, {method: this._options.method, pageSize: this._options.pageSize, exclude});
        const secret = Object.keys(this._options.requestHeaders ?? {});
        return secret.length ? {...plan, code: codeOf(plan.http, secret)} : plan;
    }

    /**
     * Starts a search. Nothing is requested until pages, items, `collect` or `matched` is used on the result.
     *
     * Pages follow the server's `next` links. Unless `verify` is `"never"`, the first page is checked against the
     * request: when the server ignored a filter, the search is planned again with the next encoding and restarted.
     * A POST rejected with 405 is retried as GET, and an oversized first page is retried with half the limit.
     *
     * On a static catalog the search crawls `item` and `child` links from the requested collections (else from the
     * landing page) and tests every item on the client with {@link itemMatches}; pages hold up to `limit` items
     * read (default the client's `pageSize`), have no `matched` and no `next` cursor (such a search cannot be
     * resumed), and the search stops after `maxScanned` items read (default 2000) or `maxItems` kept.
     *
     * @param request The search request.
     * @param options `signal` aborts the requests of the search; `onProgress` is called after every page.
     * @returns The search.
     * @throws {@link StacError} When the API cannot be searched (`capabilities.search` is `"none"`), or for
     *   `"collection-items"` without exactly one collection.
     * @example
     * ```ts
     * const collectionId = collections[0].id; // a collection the user picked
     * const search = client.search({collections: [collectionId], area: [-10, 35, 5, 44],
     *     datetime: ["2024-01-01", "2024-12-31"], maxItems: 200});
     * for await (const page of search.pages()) {
     *     console.log(`page ${page.index}: ${page.items.length} items`, page.matched);
     * }
     * ```
     */
    search(request: StacSearchRequest, options: {
        /** Aborts the requests of the search: pages, items and collect then reject with the signal's reason. */
        signal?: AbortSignal;
        /** Called after every page, see {@link StacProgress}. */
        onProgress?: (progress: StacProgress) => void;
    } = {}): StacSearch {
        return new StacSearch(this, request, options.signal, undefined, options.onProgress);
    }

    /**
     * Continues a search from a saved cursor. The resumed search starts at the cursor's request and is not verified
     * again.
     *
     * @param cursor A cursor from {@link SearchPage.next}, possibly saved as JSON.
     * @param options `signal` aborts the requests of the search; `onProgress` is called after every page.
     * @returns The search, starting at the cursor's page.
     * @throws {@link StacError} When the API has no item search.
     */
    resume(cursor: PageCursor, options: {
        /** Aborts the requests of the search: pages, items and collect then reject with the signal's reason. */
        signal?: AbortSignal;
        /** Called after every page, see {@link StacProgress}. */
        onProgress?: (progress: StacProgress) => void;
    } = {}): StacSearch {
        return new StacSearch(this, cursor.request, options.signal, cursor, options.onProgress);
    }

    /**
     * Items by collection and id (always sent with collections: some servers reject id-only searches).
     *
     * Each item is requested from `{url}/collections/{collection}/items/{id}`, in parallel. A static catalog is
     * crawled for them instead (within the crawl limits); items that are not found are left out.
     *
     * @param refs Collection and item id of each item.
     * @returns A promise of the items, in the order of `refs`.
     * @throws {@link StacError} (the promise rejects) when any item cannot be read.
     */
    async items(refs: {
        /** Collection id. */
        collection: string;
        /** Item id. */
        id: string;
    }[]): Promise<StacItemJson[]> {
        if (this.capabilities.staticCatalog) {
            const found = await this.search({collections: [...new Set(refs.map((r) => r.collection))], ids: refs.map((r) => r.id)}).collect();
            return refs.map((r) => found.find((i) => i.id === r.id && (!i.collection || i.collection === r.collection))).filter((i): i is StacItemJson => !!i);
        }
        return Promise.all(refs.map((r) => this.json<StacItemJson>(`${this.url}/collections/${encodeURIComponent(r.collection)}/items/${encodeURIComponent(r.id)}`)));
    }

    /**
     * One item of a collection, cheaply: for showing what its items hold (their assets and formats, see
     * {@link assetFormat}) when the collection declares no `item_assets`.
     *
     * An API is asked `{url}/collections/{collection}/items?limit=1`: the items endpoint, not a search, which some
     * servers answer much faster. A static catalog gives the first item its crawl finds for the collection.
     *
     * @param collection The collection id.
     * @returns A promise of an item, or `null` when the collection has none.
     * @throws {@link StacError} (the promise rejects) when the items cannot be read.
     *
     * @example
     * ```ts
     * const item = await client.sampleItem("ch.swisstopo.swissimage-dop10");
     * const formats = Object.values(item?.assets ?? {}).map((a) => assetFormat(a).format);   // ["COG"]
     * ```
     */
    async sampleItem(collection: string): Promise<StacItemJson | null> {
        if (this.capabilities.staticCatalog) {
            const [item] = await this.search({collections: [collection], limit: 1}).collect(1);
            return item ?? null;
        }
        const page = await this.json<{ features?: StacItemJson[] }>(`${this.url}/collections/${encodeURIComponent(collection)}/items?limit=1`);
        return page.features?.[0] ?? null;
    }

    // ------------------------------------------------------------------------------------------- HTTP

    /** @internal GET or POST with retries; throws StacError with status and body. */
    async send(spec: HttpRequestSpec, signal?: AbortSignal, attempts?: number): Promise<{ status: number; json: unknown }> {
        const f = this._options.fetch ?? fetch;
        const retry = {attempts: 3, statuses: [429, 502, 503, 504], backoffMs: 1000, ...this._options.retry};
        if (attempts !== undefined) retry.attempts = attempts;
        const url = this._options.rewriteUrl ? this._options.rewriteUrl(spec.url) : spec.url;
        let attempt = 0;
        for (;;) {
            let response: Response;
            try {
                const timeout = AbortSignal.timeout(this._options.timeoutMs ?? 30000);
                response = await accessFetch(url, this.accessFor(spec.url), {
                    method: spec.method,
                    headers: spec.headers,
                    body: spec.method === "POST" && spec.body ? JSON.stringify(spec.body) : undefined,
                    signal: signal ? anySignal([signal, timeout]) : timeout,
                }, f, {onRequest: this._options.onRequest, kind: "stac-api", url: spec.url});
            } catch (e) {
                if (signal?.aborted) throw signal.reason;
                if (attempt + 1 >= retry.attempts) throw new StacError(`Request failed: ${(e as Error).message}`, undefined, spec.url);
                await sleep(retry.backoffMs * 2 ** attempt++);
                if (signal?.aborted) throw signal.reason;
                continue;
            }
            const text = await response.text();
            let json: unknown = undefined;
            try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
            if (response.ok) return {status: response.status, json};
            if (retry.statuses.includes(response.status) && attempt + 1 < retry.attempts) {
                const after = Number(response.headers.get("Retry-After"));
                await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : retry.backoffMs * 2 ** attempt++);
                if (signal?.aborted) throw signal.reason;
                continue;
            }
            throw new StacError(`HTTP ${response.status} from ${spec.url}`, response.status, spec.url, json);
        }
    }

    /** The options of a request to `url`: the client's, on the API's origin only; or those of the access hook. */
    private accessFor(url: string) {
        const o = this._options;
        if (o.access) return o.access(new URL(url), "stac-api");
        if (originOf(url) !== originOf(this.url)) return null;
        return {credentials: o.credentials, requestHeaders: o.requestHeaders, requestParameters: o.requestParameters};
    }

    /** @internal */
    async json<T>(url: string, attempts?: number): Promise<T> {
        return (await this.send({method: "GET", url, headers: {Accept: "application/json"}}, undefined, attempts)).json as T;
    }

    /** @internal */
    get options(): StacClientOptions {
        return this._options;
    }
}

/** Queryables from a collection's summaries: ranges give minimum and maximum, lists give enum. */
function summaryQueryables(d: CollectionDescription): Queryable[] {
    return Object.entries(d.summaries).map(([name, s]) => {
        const range = s && typeof s === "object" && !Array.isArray(s) ? s as { minimum?: number; maximum?: number } : undefined;
        return {name, minimum: range?.minimum, maximum: range?.maximum, enum: Array.isArray(s) ? s : undefined, source: "summaries" as const};
    });
}

function anySignal(signals: AbortSignal[]): AbortSignal {
    const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    if (any) return any(signals);
    const c = new AbortController();
    for (const s of signals) s.addEventListener("abort", () => c.abort(s.reason), {once: true});
    return c.signal;
}

/**
 * A description of collection JSON, without requests (exported as `describeCollectionJson`).
 *
 * Takes the first bbox as the overall extent (3D boxes reduced to 2D), the first interval, and the data assets of
 * `item_assets` with their bands. `commonNames` maps each EO common name to the first asset that has it.
 *
 * @param c The collection JSON.
 * @returns The description.
 *
 * @category Client
 */
export function describe(c: StacCollectionJson): CollectionDescription {
    const bboxes = (c.extent?.spatial?.bbox ?? []).map((b) => (b.length >= 6 ? [b[0], b[1], b[3], b[4]] : b.slice(0, 4)) as Bbox);
    const interval = (c.extent?.temporal?.interval?.[0] ?? [null, null]) as [string | null, string | null];
    const assets = Object.entries(c.item_assets ?? {}).filter(([k, a]) => isDataAsset(k, a))
        .map(([key, a]) => ({key, title: a.title as string | undefined, roles: (a.roles as string[] | undefined) ?? [],
            type: a.type as string | undefined, bands: assetBands(a)}));
    const commonNames: Record<string, string> = {};
    for (const a of assets) for (const b of a.bands) if (b.commonName && !commonNames[b.commonName]) commonNames[b.commonName] = a.key;
    return {
        id: c.id, title: c.title, description: c.description, license: c.license, keywords: c.keywords,
        bbox: bboxes[0], subBboxes: bboxes.slice(1), interval, summaries: c.summaries ?? {}, assets, commonNames, raw: c,
    };
}

// ------------------------------------------------------------------------------------------------ search

/** Where a search stands: the next request exactly as the server described it. JSON.
 *
 * @category Client */
export interface PageCursor {
    /** The original search request. */
    request: StacSearchRequest;
    /** The HTTP request of the next page, built from the server's next link. */
    next: HttpRequestSpec;
    /** The filter encoding the search used; a resumed search does not fall back to encodings before it. */
    encoding: FilterEncoding;
}

/** A page of a {@link StacSearch}.
 *
 * @category Client */
export interface SearchPage {
    /** Items of the page that satisfy the request (after client-side checks). */
    items: StacItemJson[];
    /** Page number in this search, from 0. */
    index: number;
    /** Items the server returned in this page (before client-side checks). */
    returned: number;
    /** Items scanned so far in this search. */
    scanned: number;
    /** Total reported by the server, when it reports one (exact: false when the client filters). */
    matched?: {
        /** The total. */
        value: number;
        /** False when the client filters items, so the server's total is an upper bound. */
        exact: boolean;
    };
    /** The plan the page was requested with. */
    plan: SearchPlan;
    /**
     * Cursor of the next page; undefined on the last page, when `maxItems` or `maxScanned` was reached, or when the
     * server's next link repeats the current request. JSON: save it to resume later with {@link StacClient.resume}.
     */
    next?: PageCursor;
    /**
     * Footprints of the page's items as GeoJSON: {@link itemFootprints} of `items` (feature ids are
     * {@link itemKey}s).
     *
     * @returns A GeoJSON FeatureCollection in longitude/latitude.
     */
    footprints(): {
        /** Always `"FeatureCollection"`. */
        type: "FeatureCollection";
        /** One GeoJSON Feature per item of the page. */
        features: unknown[];
    };
}

/**
 * A running search, created by {@link StacClient.search} or {@link StacClient.resume}. Each call of pages, items or
 * collect starts the requests again from the first page (or the cursor); `matched` reads the first page once.
 *
 * @category Client
 */
export class StacSearch {
    private _plan: SearchPlan;
    private _first?: Promise<SearchPage | null>;
    /** The response of the first page, kept so that `matched()` and a later read do not request it twice. */
    private _firstResponse?: { spec: string; response: StacItemCollectionJson };
    private _excluded: FilterEncoding[] = [];
    private _rejected: Record<string, number> = {};

    /** @internal */
    constructor(private readonly client: StacClient, private readonly request: StacSearchRequest,
        private readonly signal?: AbortSignal, private readonly cursor?: PageCursor,
        private readonly onProgress?: (progress: StacProgress) => void) {
        this._plan = client.plan(request, cursor ? excludeBefore(cursor.encoding) : []);
    }

    /**
     * Items the client read but left out, counted per requirement: `collections`, `ids`, `datetime`, `area`, or
     * `where.{property}` (a CQL2 `filter` counts as `filter`). Each item counts once, for the first requirement it
     * fails in that order. Only requirements tested in the browser are counted (a static catalog, a collection's
     * items endpoint, a filter the server cannot apply); what the server filters out is never seen. Counts are of
     * the last read of the pages, and empty before.
     *
     * @returns a copy of the counts
     */
    get rejected(): Record<string, number> {
        return {...this._rejected};
    }

    /** Counts the requirement an item left out on the client fails first. */
    private reject(item: StacItemJson, parts: { area?: boolean; datetime?: boolean; predicates?: boolean }): void {
        const key = firstFailing(item, this.request, parts);
        if (key) this._rejected[key] = (this._rejected[key] ?? 0) + 1;
    }

    /** The plan in use (it changes when verification finds that the server ignored a filter). */
    get plan(): SearchPlan {
        return this._plan;
    }

    /**
     * Pages of matching items, following the server's next links.
     *
     * Stops after the last page, after `maxItems` items were kept, or after `maxScanned` items (default 2000) were
     * scanned. Items that fail client-side checks (polygon, predicates) are left out of `items` but counted in
     * `scanned`.
     *
     * @returns An async generator of pages.
     * @throws {@link StacError} (from the generator) when a page request fails and cannot be recovered.
     */
    async *pages(): AsyncGenerator<SearchPage> {
        if (this.client.capabilities.staticCatalog) {
            yield* this.staticPages();
            return;
        }
        const maxItems = this.request.maxItems ?? Infinity;
        const maxScanned = this.request.maxScanned ?? 2000;
        let next: HttpRequestSpec | undefined = this.cursor?.next ?? this._plan.http;
        let previous: HttpRequestSpec | undefined;
        let verify = !this.cursor && this.client.options.verify !== "never";
        let index = 0, scanned = 0, kept = 0;
        this._rejected = {};
        while (next) {
            if (this.signal?.aborted) throw this.signal.reason;
            let response: StacItemCollectionJson;
            const spec = JSON.stringify(next);
            try {
                if (index === 0 && this._firstResponse?.spec === spec) {
                    response = this._firstResponse.response;
                } else {
                    response = (await this.client.send(next, this.signal)).json as StacItemCollectionJson;
                    if (index === 0 && !this.cursor) this._firstResponse = {spec, response};
                }
            } catch (e) {
                const recovered = this.recover(e as StacError, next, index === 0);
                if (recovered) { next = recovered; continue; }
                throw e;
            }
            const features = response.features ?? [];
            if (index === 0) {
                this.client.learn({counts: response.numberMatched !== undefined ? "numberMatched" : response.context?.matched !== undefined ? "context" : "none"});
            }
            // Verification: did the server apply the predicates it was sent? If not, re-plan and start again.
            if (verify && features.length) {
                const encoding = this._plan.filterEncoding;
                if (encoding === "cql2-json" || encoding === "cql2-text" || encoding === "query") {
                    const violating = features.filter((f) => !safeMatches(f, this.request, {area: false, datetime: false}));
                    const key = encoding === "query" ? "queryApplied" : "filterApplied";
                    if (violating.length) {
                        this.client.learn({[key]: "ignored"});
                        this._excluded.push(encoding);
                        this._plan = this.client.plan(this.request, this._excluded);
                        next = this._plan.http;
                        continue;
                    }
                    this.client.learn({[key]: "yes"});
                }
                verify = false;
            }
            scanned += features.length;
            const clientArea = this._plan.clientApplies.includes("polygon");
            const clientPredicates = this._plan.clientApplies.includes("where/filter");
            const parts = {area: clientArea, datetime: false, predicates: clientPredicates};
            const items = clientArea || clientPredicates || this._plan.clientApplies.includes("ids")
                ? features.filter((f) => safeMatches(f, this.request, parts) || (this.reject(f, parts), false))
                : features;
            const room = maxItems - kept;
            const pageItems = items.slice(0, room);
            kept += pageItems.length;
            const total = response.numberMatched ?? response.context?.matched;
            const link = response.links?.find((l) => l.rel === "next");
            const following = link && kept < maxItems && scanned < maxScanned ? followNext(link, next) : undefined;
            const loop = following && previous && following.url === next.url && JSON.stringify(following.body) === JSON.stringify(next.body);
            const page: SearchPage = {
                items: pageItems, index, returned: features.length, scanned, plan: this._plan,
                matched: total !== undefined ? {value: total, exact: !(clientArea || clientPredicates)} : undefined,
                next: following && !loop ? {request: this.request, next: following, encoding: this._plan.filterEncoding} : undefined,
                footprints: () => itemFootprints(pageItems),
            };
            this.onProgress?.({step: "search", pages: index + 1, scanned, kept, ...(total !== undefined ? {matched: total} : {})});
            yield page;
            index++;
            previous = next;
            next = page.next?.next;
        }
    }

    /**
     * Matching items, one by one, across pages.
     *
     * @returns An async generator of items.
     * @throws {@link StacError} (from the generator) when a page request fails and cannot be recovered.
     */
    async *items(): AsyncGenerator<StacItemJson> {
        for await (const page of this.pages()) yield* page.items;
    }

    /**
     * All matching items (up to `max`, or the request's maxItems).
     *
     * @param max Largest number of items to return. Default: no limit besides the request's `maxItems` and
     *   `maxScanned`.
     * @returns A promise of the items.
     * @throws {@link StacError} (the promise rejects) when a page request fails and cannot be recovered.
     */
    async collect(max = Infinity): Promise<StacItemJson[]> {
        const out: StacItemJson[] = [];
        for await (const item of this.items()) {
            out.push(item);
            if (out.length >= max) break;
        }
        return out;
    }

    /**
     * The server's total for the search, from the first page, when it reports one.
     *
     * The first page is requested once and the result cached; a later read of the pages reuses it.
     *
     * @returns A promise of the total, or undefined when the server reports none or there are no pages.
     * @throws {@link StacError} (the promise rejects) when the first page cannot be read.
     */
    async matched(): Promise<{
        /** The total. */
        value: number;
        /** False when the client filters items, so the server's total is an upper bound. */
        exact: boolean;
    } | undefined> {
        this._first ??= (async () => {
            for await (const page of this.pages()) return page;
            return null;
        })();
        return (await this._first)?.matched;
    }

    /** Pages of a static catalog: crawled items, tested on the client. */
    private async *staticPages(): AsyncGenerator<SearchPage> {
        const maxItems = this.request.maxItems ?? Infinity;
        const maxScanned = this.request.maxScanned ?? 2000;
        const roots = await this.client.staticRoots(this.request.collections);
        let index = 0, scanned = 0, kept = 0;
        this._rejected = {};
        const batch = this.request.limit ?? this.client.options.pageSize ?? 50;
        for await (const read of crawlItems(this.client, roots, {batch, maxScanned, signal: this.signal})) {
            if (this.signal?.aborted) throw this.signal.reason;
            scanned += read.length;
            const pageItems = read.filter((i) => safeMatches(i, this.request, {}) || (this.reject(i, {}), false)).slice(0, maxItems - kept);
            kept += pageItems.length;
            this.onProgress?.({step: "search", pages: index + 1, scanned, kept});
            yield {items: pageItems, index: index++, returned: read.length, scanned, plan: this._plan, footprints: () => itemFootprints(pageItems)};
            if (kept >= maxItems || scanned >= maxScanned) return;
        }
    }

    /** Recovers from errors that have a known cure; returns the request to retry, or undefined. */
    private recover(error: StacError, spec: HttpRequestSpec, firstPage: boolean): HttpRequestSpec | undefined {
        if (spec.method === "POST" && error.status === 405) {
            this.client.learn({postToGet: true});
            if (firstPage) {
                this._plan = this.client.plan(this.request, this._excluded);
                return this._plan.http;
            }
            return undefined;
        }
        // Page size too large: 400 naming the limit, or gateway errors from oversized responses.
        const limit = Number(spec.body?.limit ?? new URL(spec.url).searchParams.get("limit"));
        const sizeError = error.status === 413 || error.status === 502 || error.status === 504
            || (error.status === 400 && /limit/i.test(JSON.stringify(error.body ?? "")));
        if (firstPage && sizeError && limit > 10) {
            this.client.learn({maxLimit: Math.floor(limit / 2)});
            this._plan = this.client.plan({...this.request, limit: Math.floor(limit / 2)}, this._excluded);
            return this._plan.http;
        }
        return undefined;
    }
}

function excludeBefore(encoding: FilterEncoding): FilterEncoding[] {
    const order: FilterEncoding[] = ["cql2-json", "cql2-text", "query", "client"];
    const i = order.indexOf(encoding);
    return i > 0 ? order.slice(0, i) : [];
}

/** The first requirement of `request` an item fails: collections, ids, datetime, area, then each `where` property. */
function firstFailing(item: StacItemJson, request: StacSearchRequest, parts: { area?: boolean; datetime?: boolean; predicates?: boolean }): string | undefined {
    const {area = true, datetime = true, predicates = true} = parts;
    const none = {area: false, datetime: false, predicates: false};
    const fails = (r: StacSearchRequest, p: typeof parts) => !safeMatches(item, r, p);
    if (request.collections?.length && fails({collections: request.collections}, none)) return "collections";
    if (request.ids?.length && fails({ids: request.ids}, none)) return "ids";
    if (datetime && request.datetime !== undefined && fails({datetime: request.datetime}, {datetime: true, area: false, predicates: false})) return "datetime";
    if (area && request.area && fails({area: request.area}, {area: true, datetime: false, predicates: false})) return "area";
    if (predicates) {
        for (const [k, v] of Object.entries(request.where ?? {})) {
            if (fails({where: {[k]: v}}, {predicates: true, area: false, datetime: false})) return `where.${k}`;
        }
        if (request.filter !== undefined && fails({filter: request.filter}, {predicates: true, area: false, datetime: false})) return "filter";
    }
    return undefined;
}

function safeMatches(item: StacItemJson, request: StacSearchRequest, parts: { area?: boolean; datetime?: boolean; predicates?: boolean }): boolean {
    try {
        return itemMatches(item, request, parts);
    } catch {
        // An operator the client cannot evaluate: trust the server.
        return true;
    }
}

/**
 * The next request from a next link (method, headers, body and merge as the server gave them).
 *
 * The method is POST only when the link says so. Link headers are added to the current headers. For GET the
 * `Content-Type` header is dropped and there is no body. For POST the body is the link's body merged into the
 * current one when `merge` is true, else the link's body, else the current body.
 *
 * @param link The `next` link of a page.
 * @param current The request of the current page.
 * @returns The request of the next page.
 *
 * @category Client
 */
export function followNext(link: StacLink, current: HttpRequestSpec): HttpRequestSpec {
    const method = (link.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const headers: Record<string, string> = {...current.headers};
    for (const [k, v] of Object.entries(link.headers ?? {})) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    if (method === "GET") {
        delete headers["Content-Type"];
        return {method, url: link.href, headers};
    }
    const body = link.merge ? {...(current.body ?? {}), ...(link.body ?? {})} : (link.body ?? current.body);
    return {method, url: link.href, headers: {...headers, "Content-Type": "application/json"}, body};
}

