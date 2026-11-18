/**
 * What a STAC API says it supports, from its conformance classes and links, and what it was seen to do
 * (the server profile). Conformance URIs are matched by pattern: their version segments are inconsistent across
 * extensions and releases (v1.0.0, v1.0.0-rc.2, v0.3.0, ...).
 */
import type {StacCatalogJson} from "./json.js";

/**
 * What a STAC API claims to support, derived from its conformance classes and landing page links by
 * {@link parseCapabilities}. A flag is true when a matching conformance class (any version) is declared.
 *
 * @category Client
 */
export interface StacCapabilities {
    /** `stac_version` of the landing page. */
    stacVersion?: string;
    /** All conformance class URIs, from the landing page and `/conformance`, without duplicates. */
    conformsTo: string[];
    /** STAC API - Core. */
    core: boolean;
    /** STAC API - Collections, OGC API - Features Core, or a `data` link on the landing page. */
    collections: boolean;
    /** OGC API - Features: `/collections/{id}/items` with bbox and datetime. */
    features: boolean;
    /** STAC API - Item Search, or a `search` link on a landing page that declares no conformance classes. */
    itemSearch: boolean;
    /** The Filter extension (CQL2) and its conformance classes, or null when the server declares no filtering. */
    filter: null | {
        /** CQL2 JSON encoding (also accepted from the deprecated `filter:cql-json` URIs). */
        cql2Json: boolean;
        /** CQL2 Text encoding (also accepted from the deprecated `filter:cql-text` URIs). */
        cql2Text: boolean;
        /** Basic spatial operators (`s_intersects`), or the full spatial operators class. */
        basicSpatial: boolean;
        /** All spatial operators. */
        spatial: boolean;
        /** Temporal operators (`t_intersects` and others). */
        temporal: boolean;
        /** Advanced comparison operators (`like`, `between`, `in`). */
        advancedComparison: boolean;
        /** Array operators (`a_contains` and others). */
        arrays: boolean;
    };
    /** The (older) Query extension: `query: {"eo:cloud_cover": {lt: 10}}`. */
    query: boolean;
    /** The Sort extension (`sortby`). */
    sort: boolean;
    /** The Fields extension (`fields: {include, exclude}`). */
    fields: boolean;
    /** The Free-text search extension (`q`). */
    freeText: boolean;
    /** The Collection Search extension. */
    collectionSearch: boolean;
    /** The Aggregation extension. */
    aggregation: boolean;
    /**
     * A static catalog: the landing page is a `Catalog` or `Collection` without item search and without a
     * collections endpoint (no collections conformance, no `data` link). {@link StacClient} then finds collections
     * by following `child` links and items by following `item` (and `child`) links, within the limits of
     * {@link StacClientOptions.crawl}, and tests the items on the client (`filterEncoding` `"client"`).
     */
    staticCatalog: boolean;
    /**
     * How {@link StacClient} searches items here, the one answer to "can I search this?":
     * - `"item-search"`: the STAC item search endpoint (filters, sorting and paging as the server supports them);
     * - `"collection-items"`: an OGC API - Features server without item search: the collection's `items` endpoint,
     *   with `bbox`, `datetime` and `limit` on the server, the rest on the client, one collection at a time;
     * - `"crawl"`: a static catalog, crawled through its links and filtered on the client;
     * - `"none"`: no way to search (not a catalog).
     */
    search: "item-search" | "collection-items" | "crawl" | "none";
}

const has = (uris: string[], pattern: RegExp) => uris.some((u) => pattern.test(u));

/**
 * Capabilities from a landing page's `conformsTo` (or a `/conformance` response).
 *
 * The URIs of both arguments are combined. Conformance classes are matched by name, with any version segment.
 * Landing page links count too: a `data` link implies collections, and a `search` link implies item search when
 * no conformance classes are declared at all. {@link StacClient.connect} calls this for you; call it directly to
 * inspect a landing page you fetched yourself.
 *
 * @param landing The landing page JSON (its `conformsTo`, `links` and `stac_version` are read).
 * @param conformance Conformance class URIs from the `/conformance` endpoint, when fetched separately.
 * @returns The capabilities. An empty landing page gives all flags false and `filter` null (and `staticCatalog`
 *   false: it is no catalog).
 * @example
 * ```ts
 * const catalogUrl = "https://example.com/stac/v1"; // the STAC API URL the user entered
 * const landing = await (await fetch(catalogUrl)).json();
 * const capabilities = parseCapabilities(landing);
 * if (capabilities.itemSearch && capabilities.filter?.cql2Json) {
 *     // the server can filter item properties with CQL2-JSON
 * }
 * ```
 *
 * @category Client
 */
export function parseCapabilities(landing: StacCatalogJson, conformance?: string[]): StacCapabilities {
    const uris = [...new Set([...(landing.conformsTo ?? []), ...(conformance ?? [])])];
    const links = landing.links ?? [];
    const searchLink = links.some((l) => l.rel === "search");
    // api.stacspec.org/{version}/{class}[#extension]: version segments differ, so match the class name.
    const stac = (name: string) => new RegExp(`stacspec\\.org\\/[^/]+\\/${name}$`);
    const itemSearch = has(uris, stac("item-search")) || (searchLink && uris.length === 0);
    const collections = has(uris, stac("collections")) || has(uris, /ogcapi-features-1\/[^/]+\/conf\/core$/) || links.some((l) => l.rel === "data");
    const filterUris = uris.filter((u) => /filter|cql/i.test(u));
    const anyFilter = has(uris, /item-search#filter|\/conf\/filter(#|$)|ogcapi-features-3\/[^/]+\/conf\/(features-)?filter/i);
    const cql2 = (name: string) => has(filterUris, new RegExp(`cql2\\/[^/]+\\/conf\\/${name}$`, "i"));
    return {
        stacVersion: landing.stac_version,
        conformsTo: uris,
        core: has(uris, stac("core")),
        collections,
        features: has(uris, stac("ogcapi-features")) || has(uris, /ogcapi-features-1\/[^/]+\/conf\/(core|geojson)$/),
        itemSearch,
        filter: anyFilter
            ? {
                // Deprecated stac-fastapi URIs (item-search#filter:cql-json) are accepted as stac-browser does.
                cql2Json: cql2("cql2-json") || has(filterUris, /filter:cql-json|cql2-json/i),
                cql2Text: cql2("cql2-text") || has(filterUris, /filter:cql-text|cql2-text/i),
                basicSpatial: cql2("basic-spatial-(operators|functions)") || cql2("spatial-(operators|functions)"),
                spatial: cql2("spatial-(operators|functions)"),
                temporal: cql2("temporal-(operators|functions)"),
                advancedComparison: cql2("advanced-comparison-operators"),
                arrays: cql2("array-(operators|functions)"),
            }
            : null,
        query: has(uris, /item-search#query$/),
        sort: has(uris, /item-search#sort$/),
        fields: has(uris, /item-search#fields$/),
        freeText: has(uris, /item-search#free-text$/),
        collectionSearch: has(uris, /collection-search(#[a-z-]+)?$/),
        aggregation: has(uris, /aggregation(#[a-z-]+)?$/),
        staticCatalog: !itemSearch && !collections && (landing.type === "Catalog" || landing.type === "Collection"),
        search: itemSearch ? "item-search" : collections ? "collection-items"
            : landing.type === "Catalog" || landing.type === "Collection" ? "crawl" : "none",
    };
}

/**
 * What a server was seen to do, beyond what it claims. JSON: save it per URL and pass it to
 * `StacClient.connect({profile})` so a later session does not rediscover the same quirks.
 *
 * @category Client
 */
export interface ServerProfile {
    /** The API URL the profile belongs to, without trailing slashes. `connect` ignores a profile for another URL. */
    url: string;
    /** When the profile last changed, as an ISO 8601 timestamp. */
    learnedAt: string;
    /** CQL2 filters: applied as claimed, found ignored (results violated them), or not yet seen. */
    filterApplied: "yes" | "ignored" | "unknown";
    /** The Query extension: same, for servers that offer it. */
    queryApplied: "yes" | "ignored" | "unknown";
    /** Largest page size the server accepted after a limit error, when one was seen. */
    maxLimit?: number;
    /** How the server reports totals. */
    counts: "numberMatched" | "context" | "none" | "unknown";
    /** POST search failed with 405: use GET from now on. */
    postToGet: boolean;
    /** The landing page needs a trailing slash (INPE BDC redirects without CORS headers). */
    trailingSlash: boolean;
}

/**
 * A profile for a server nothing is known about yet: everything `"unknown"` or false, `learnedAt` set to now.
 *
 * @param url The API URL the profile is for. Pass it without trailing slashes: {@link StacClient.connect} only
 *   uses a saved profile whose `url` equals the API URL with trailing slashes removed.
 * @returns A new profile.
 *
 * @category Client
 */
export function emptyProfile(url: string): ServerProfile {
    return {url, learnedAt: new Date().toISOString(), filterApplied: "unknown", queryApplied: "unknown", counts: "unknown",
        postToGet: false, trailingSlash: false};
}
