/**
 * A portable search request, and its compilation for one server into an explained plan: what is sent, what the
 * server applies, what runs in the browser, and every degradation. No network here.
 */
import type {StacCapabilities, ServerProfile} from "./capabilities.js";
import {evaluateCql2, toCql2Text, whereToCql2, whereToQuery, type Cql2Json, type WhereComparison} from "./cql2.js";
import {bboxOf, intersectsArea, isBbox} from "./geometry.js";
import type {Bbox, GeoJsonArea, StacItemJson} from "./json.js";

/** A date or time: an RFC 3339 string (complete or partial, such as `"2024-06"`) or a `Date`.
 *
 * @category Search */
export type DateLike = string | Date;

/**
 * A portable search request: what to find, independent of what a given server supports. {@link planSearch}
 * compiles it for one server; `StacClient.search` plans and runs it.
 *
 * @example
 * ```ts
 * const collection = "...";                                 // a collection id chosen by the user
 * const area: Bbox = [west, south, east, north];            // drawn by the user, in degrees
 * const request: StacSearchRequest = {
 *     collections: [collection],
 *     area,
 *     datetime: "2024",                                     // the whole year
 *     where: {"eo:cloud_cover": {lt: 20}},
 *     sortby: [{field: "eo:cloud_cover", direction: "asc"}],
 *     maxItems: 100,
 * };
 * ```
 *
 * @category Search
 */
export interface StacSearchRequest {
    /** Collection ids to search in. Default: all collections of the API. */
    collections?: string[];
    /** Item ids to return. */
    ids?: string[];
    /** A bbox `[w, s, e, n]` or a (multi)polygon, in longitude/latitude. Items whose footprint intersects it match. */
    area?: Bbox | GeoJsonArea;
    /**
     * An instant or interval: `"2024"`, `"2024-06"`, `"2024-06-15"` (expanded to the whole period), full RFC 3339
     * values, `"2018/2026"`, or `[start, end]` with `null` for an open end.
     */
    datetime?: DateLike | [DateLike | null, DateLike | null];
    /** Portable property predicates, compiled to CQL2, the Query extension or a client-side check. */
    where?: Record<string, WhereComparison>;
    /** Raw CQL2-JSON (power users), ANDed with `where`. */
    filter?: Cql2Json;
    /** Raw Query extension object (power users). */
    query?: Record<string, Record<string, unknown>>;
    /** Free-text search terms. Dropped when the server does not support free-text search. */
    q?: string;
    /** Sort order, most significant first. Dropped (with a `sort-dropped` degradation) when the server cannot sort. */
    sortby?: {
        /** A property name (`datetime`, `eo:cloud_cover`); `properties.` is prefixed for the server unless the name is `id`, `collection` or already prefixed. */
        field: string;
        /** `"asc"` (smallest or oldest first) or `"desc"`. */
        direction: "asc" | "desc";
    }[];
    /** Fields extension: which item fields the server returns. Dropped when the server does not support it. */
    fields?: {
        /** Fields to include (`"properties.eo:cloud_cover"`, `"assets"`, ...). */
        include?: string[];
        /** Fields to leave out. */
        exclude?: string[];
    };
    /** Page size. Default: the client's pageSize (50), clamped to what the server was seen to accept. */
    limit?: number;
    /** Stop after this many items (client side, across pages). */
    maxItems?: number;
    /** Budget for client-side filtering: stop after scanning this many items. Default 2000. */
    maxScanned?: number;
    /** Vendor parameters, passed through unchanged. */
    extra?: Record<string, unknown>;
}

/**
 * How a request's predicates (`where`, `filter`, `query`) reach the server:
 *
 * - `"none"`: the request has no predicates.
 * - `"cql2-json"`: a CQL2-JSON `filter` in a POST body.
 * - `"cql2-text"`: a CQL2-text `filter` (also usable with GET).
 * - `"query"`: the older Query extension.
 * - `"client"`: nothing usable on the server; the client tests the returned items. Every search of a static catalog
 *   (no item search, see `StacCapabilities.staticCatalog`) has this encoding: the client tests every item it reads.
 *
 * @category Search
 */
export type FilterEncoding = "none" | "cql2-json" | "cql2-text" | "query" | "client";

/**
 * A difference between what was asked and what the server is sent, reported in {@link SearchPlan.degradations}.
 * `kind` tells which:
 *
 * - `filter-via-query`: predicates sent through the Query extension instead of CQL2.
 * - `filter-client-side`: predicates applied by the client to the returned items, up to `maxScanned` items.
 * - `operators-rewritten`: `in` / `between` rewritten as basic comparisons.
 * - `area-as-bbox`: a polygon sent as its bbox, then tested exactly on the client.
 * - `sort-dropped`, `fields-dropped`, `q-dropped`: a part the server does not support, left out.
 * - `limit-clamped`: the page size lowered to the largest the server was seen to accept.
 * - `datetime-normalised`: the datetime rewritten to the full RFC 3339 interval sent.
 * - `static-catalog`: the catalog has no item search; its `item` links are followed and each item is tested on the
 *   client, up to `maxScanned` items.
 *
 * @category Search
 */
export type Degradation =
    | {
        /** Predicates are sent through the Query extension. */
        kind: "filter-via-query";
        /** Why CQL2 is not used. */
        reason: string;
    }
    | {
        /** Predicates are applied by the client. */
        kind: "filter-client-side";
        /** Why the server cannot apply them. */
        reason: string;
        /** Items scanned at most before the search stops (the request's `maxScanned`, default 2000). */
        maxScanned: number;
    }
    | {
        /** Advanced comparison operators were rewritten. */
        kind: "operators-rewritten";
        /** What was rewritten and why. */
        reason: string;
    }
    | {
        /** A polygon area is sent as its bbox. */
        kind: "area-as-bbox";
        /** Why `intersects` is not used. */
        reason: string;
    }
    | {
        /** `sortby` was left out. */
        kind: "sort-dropped";
        /** Why the server cannot sort. */
        reason: string;
    }
    | {
        /** `fields` was left out: the server does not support the Fields extension. */
        kind: "fields-dropped";
    }
    | {
        /** `q` was left out: the server does not support free-text search. */
        kind: "q-dropped";
    }
    | {
        /** The page size was lowered. */
        kind: "limit-clamped";
        /** The page size asked for. */
        from: number;
        /** The page size sent. */
        to: number;
    }
    | {
        /**
         * An OGC API - Features server without STAC item search: the collection's `items` endpoint is read with
         * `bbox`, `datetime` and `limit`, and everything else is tested on the client.
         */
        kind: "collection-items";
        /** What happens instead of a STAC search. */
        reason: string;
        /** Items read at most before the search stops (the request's `maxScanned`, default 2000). */
        maxScanned: number;
    }
    | {
        /** A static catalog: items are found by following links and tested on the client. */
        kind: "static-catalog";
        /** What happens instead of a search. */
        reason: string;
        /** Items read at most before the search stops (the request's `maxScanned`, default 2000). */
        maxScanned: number;
    }
    | {
        /** The datetime was rewritten. */
        kind: "datetime-normalised";
        /** The datetime as given (arrays as JSON). */
        from: string;
        /** The `datetime` parameter sent. */
        to: string;
    };

/** One HTTP request, ready for `fetch`: what a {@link SearchPlan} sends for its first page.
 *
 * @category Search */
export interface HttpRequestSpec {
    /** POST (body as JSON) or GET (everything in the query string). */
    method: "GET" | "POST";
    /** The search URL; for GET it includes the query parameters. */
    url: string;
    /** Request headers: `Accept: application/geo+json`, plus `Content-Type: application/json` for POST. */
    headers: Record<string, string>;
    /** The JSON body (POST only). */
    body?: Record<string, unknown>;
}

/**
 * A request compiled for one server, with an explanation: the HTTP request sent, which parts the server applies,
 * which the client applies, and every degradation.
 *
 * @category Search
 */
export interface SearchPlan {
    /** The portable request the plan was made from. */
    request: StacSearchRequest;
    /** The HTTP request of the first page. */
    http: HttpRequestSpec;
    /** How the predicates are sent ({@link FilterEncoding}). */
    filterEncoding: FilterEncoding;
    /** Parts of the request the server applies. */
    serverApplies: string[];
    /** Parts the client applies to the returned items (they cost scanned items, bounded by maxScanned). */
    clientApplies: string[];
    /** Differences between the request and what is sent, in the order they were found. */
    degradations: Degradation[];
    /** The same request as shell and JavaScript code, for display and debugging. */
    code: {
        /** A `curl` command line. */
        curl: string;
        /** A JavaScript expression with `fetch` that resolves to the response JSON. */
        fetch: string;
    };
}

/** Options of {@link planSearch}.
 *
 * @category Search */
export interface PlanOptions {
    /** `"GET"` forces GET; `"auto"` and `"POST"` use POST unless the server profile says POST is rejected. Default `"auto"`. */
    method?: "auto" | "GET" | "POST";
    /** Page size when the request gives no `limit`. Default 50. */
    pageSize?: number;
    /** Encodings not to use (the search falls back through the list after verification). */
    exclude?: FilterEncoding[];
}

// ------------------------------------------------------------------------------------------------ datetime

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * One end of an interval in RFC 3339 with Z; partial dates expand to the start or end of their period.
 *
 * `"2024"`, `"2024-06"` and `"2024-06-15"` expand to the first instant (`T00:00:00Z`) or the last millisecond
 * (`T23:59:59.999Z`) of the year, month or day. A date-time without a zone gets `Z` (UTC). Other strings are
 * returned trimmed but otherwise unchanged.
 *
 * @param v The date: a `Date` (written with `toISOString()`) or a string.
 * @param end `true` for the end of an interval (expand to the end of the period), `false` for the start.
 * @returns The instant as an RFC 3339 string.
 *
 * @category Search
 */
export function normaliseInstant(v: DateLike, end: boolean): string {
    if (v instanceof Date) return v.toISOString();
    const s = v.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})$/.exec(s))) return end ? `${m[1]}-12-31T23:59:59.999Z` : `${m[1]}-01-01T00:00:00Z`;
    if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
        const y = Number(m[1]), mo = Number(m[2]);
        if (!end) return `${m[1]}-${m[2]}-01T00:00:00Z`;
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        return `${m[1]}-${m[2]}-${pad(last)}T23:59:59.999Z`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return end ? `${s}T23:59:59.999Z` : `${s}T00:00:00Z`;
    // Most servers reject times without a zone: assume UTC.
    if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return `${s}Z`;
    return s;
}

/**
 * STAC datetime parameter for a request value.
 *
 * A partial date is a whole period (`"2024"` is the year); a `"start/end"` string (an empty end or `".."` is open)
 * or a `[start, end]` pair (`null` is open) is an interval with each end expanded by `normaliseInstant`; a
 * full date-time or a `Date` is an instant (UTC when it has no zone).
 *
 * @param d The request's `datetime`, or `undefined`.
 * @returns The `datetime` parameter (`"start/end"` or a single instant), or `undefined` when `d` is undefined.
 * @example
 * ```ts
 * normaliseDatetime("2024-06");      // "2024-06-01T00:00:00Z/2024-06-30T23:59:59.999Z"
 * normaliseDatetime(["2018", null]); // "2018-01-01T00:00:00Z/.."
 * normaliseDatetime("2018/2026");    // "2018-01-01T00:00:00Z/2026-12-31T23:59:59.999Z"
 * ```
 *
 * @category Search
 */
export function normaliseDatetime(d: StacSearchRequest["datetime"]): string | undefined {
    if (d === undefined) return undefined;
    if (Array.isArray(d)) {
        const [a, b] = d;
        return `${a === null ? ".." : normaliseInstant(a, false)}/${b === null ? ".." : normaliseInstant(b, true)}`;
    }
    if (typeof d === "string" && d.includes("/")) {
        const [a, b] = d.split("/");
        return `${!a || a === ".." ? ".." : normaliseInstant(a, false)}/${!b || b === ".." ? ".." : normaliseInstant(b, true)}`;
    }
    if (d instanceof Date) return d.toISOString();
    // A partial date is a whole period.
    if (/^\d{4}(-\d{2}){0,2}$/.test(d.trim())) return `${normaliseInstant(d, false)}/${normaliseInstant(d, true)}`;
    return normaliseInstant(d, false);
}

function datetimeRange(dt: string | undefined): [number, number] | undefined {
    if (!dt) return undefined;
    const [a, b] = dt.includes("/") ? dt.split("/") : [dt, dt];
    return [a === ".." ? -Infinity : Date.parse(a), b === ".." ? Infinity : Date.parse(b)];
}

// ------------------------------------------------------------------------------------------------ plan

const sortField = (f: string) => (/^(id|collection|properties\.)/.test(f) ? f : `properties.${f}`);

/**
 * The predicates of a request as one CQL2-JSON expression (raw filter AND where).
 *
 * @param request The request; its `filter` and `where` are read (`query` is not).
 * @param advanced Whether `in` and `between` may be used (see {@link whereToCql2}). Default `true`.
 * @returns `filter`, the CQL2 of `where`, an `and` of both, or `undefined` when the request has neither.
 *
 * @category Search
 */
export function requestFilter(request: StacSearchRequest, advanced = true): Cql2Json | undefined {
    const fromWhere = request.where ? whereToCql2(request.where, advanced) : undefined;
    if (request.filter !== undefined && fromWhere) return {op: "and", args: [request.filter, fromWhere]};
    return request.filter ?? fromWhere;
}

/**
 * Compiles a request for a server.
 *
 * No network: the plan is made from what is known about the server (its advertised capabilities and the profile
 * learned from earlier responses). Predicates (`where`, `filter`) use the first encoding not excluded of: CQL2-JSON
 * (POST, CQL2 filter conformance with JSON), CQL2-text, the Query extension (only for `where` without `filter`,
 * or a raw `query`; `like` has no Query form), else client-side filtering of the returned items. CQL2 is skipped
 * when the profile found the server ignores filters; without advanced-comparison conformance `in` / `between` are
 * rewritten. A bbox area is sent as `bbox`; a polygon as `intersects` with POST, else as its bbox plus an exact
 * client-side test. `sortby`, `fields` and `q` are dropped when unsupported; the page size is clamped to the
 * profile's largest accepted limit. POST is used unless `options.method` is `"GET"` or the profile says the server
 * needs GET. Each departure from the request is listed in `degradations`.
 *
 * @param searchUrl Absolute URL of the API's search endpoint (usually `{api}/search`).
 * @param request The portable search request.
 * @param caps The server's capabilities (`StacClient.capabilities`, or `parseCapabilities` of its landing page).
 * @param profile What the server was seen to do (`StacClient.profile`, or `emptyProfile(url)` when nothing is
 *   known yet).
 * @param options Method, default page size and encodings to avoid (`PlanOptions`). Default `{}`.
 * @returns The plan: the first page's HTTP request, the filter encoding, the parts applied by server and client,
 *   the degradations, and equivalent `curl` / `fetch` code.
 * @throws `TypeError` (from `URL`) when a GET plan is made and `searchUrl` is not an absolute URL.
 * @example
 * ```ts
 * const api = "...";                              // the STAC API URL, configured by the application
 * const area: Bbox = [west, south, east, north];  // drawn by the user, in degrees
 * const client = await StacClient.connect(api);
 * const plan = planSearch(client.searchUrl!, {area, datetime: "2024", where: {"eo:cloud_cover": {lt: 20}}},
 *     client.capabilities, client.profile);
 * console.log(plan.filterEncoding, plan.degradations, plan.code.curl);
 * ```
 *
 * @category Search
 */
export function planSearch(
    searchUrl: string, request: StacSearchRequest, caps: StacCapabilities, profile: ServerProfile, options: PlanOptions = {},
): SearchPlan {
    const degradations: Degradation[] = [];
    const serverApplies: string[] = [];
    const clientApplies: string[] = [];
    const exclude = new Set(options.exclude ?? []);
    const postAllowed = options.method !== "GET" && !profile.postToGet;
    const body: Record<string, unknown> = {};

    if (request.collections?.length) { body.collections = request.collections; serverApplies.push("collections"); }
    if (request.ids?.length) { body.ids = request.ids; serverApplies.push("ids"); }

    const datetime = normaliseDatetime(request.datetime);
    if (datetime) {
        body.datetime = datetime;
        serverApplies.push("datetime");
        const given = Array.isArray(request.datetime) ? JSON.stringify(request.datetime) : String(request.datetime);
        if (given !== datetime) degradations.push({kind: "datetime-normalised", from: given, to: datetime});
    }

    // Filter encoding: CQL2-JSON (POST), CQL2-text (GET), the Query extension, else client-side.
    const hasPredicates = request.where !== undefined || request.filter !== undefined;
    let encoding: FilterEncoding = "none";
    if (hasPredicates || request.query) {
        const f = caps.filter;
        const filterTrusted = profile.filterApplied !== "ignored";
        const queryTrusted = profile.queryApplied !== "ignored";
        const whereQuery = request.where && request.filter === undefined ? whereToQuery(request.where) : undefined;
        const candidates: FilterEncoding[] = [];
        if (hasPredicates && f && filterTrusted && f.cql2Json && postAllowed) candidates.push("cql2-json");
        if (hasPredicates && f && filterTrusted && f.cql2Text) candidates.push("cql2-text");
        if (caps.query && queryTrusted && (request.query || whereQuery)) candidates.push("query");
        candidates.push("client");
        encoding = candidates.find((c) => !exclude.has(c)) ?? "client";
        const advanced = !!f?.advancedComparison;
        if (encoding === "cql2-json" || encoding === "cql2-text") {
            const expr = requestFilter(request, advanced)!;
            if (!advanced && JSON.stringify(expr) !== JSON.stringify(requestFilter(request, true))) {
                degradations.push({kind: "operators-rewritten", reason: "in/between as basic comparisons (no advanced-comparison conformance)"});
            }
            if (encoding === "cql2-json") {
                body.filter = expr;
                body["filter-lang"] = "cql2-json";
            } else {
                try {
                    body.filter = toCql2Text(expr);
                    body["filter-lang"] = "cql2-text";
                } catch {
                    encoding = caps.query && whereQuery ? "query" : "client";
                }
            }
            if (body.filter !== undefined) serverApplies.push(`filter (${encoding})`);
        }
        if (encoding === "query") {
            body.query = {...(whereQuery ?? {}), ...(request.query ?? {})};
            serverApplies.push("query extension");
            if (hasPredicates) degradations.push({kind: "filter-via-query", reason: f ? "CQL2 found ignored by this server" : "no CQL2 support"});
        }
        if (encoding === "client") {
            if (hasPredicates) {
                clientApplies.push("where/filter");
                degradations.push({kind: "filter-client-side", reason: "the server applies no usable filter", maxScanned: request.maxScanned ?? 2000});
            }
            if (request.query) {
                // A raw Query object cannot be evaluated on the client: send it and hope, as given.
                body.query = request.query;
            }
        }
    }

    // Area: bbox as bbox; a polygon as intersects (POST), else its bbox plus an exact client-side test.
    if (request.area) {
        if (isBbox(request.area)) {
            body.bbox = request.area;
            serverApplies.push("bbox");
        } else if (postAllowed && caps.itemSearch) {
            body.intersects = request.area;
            serverApplies.push("intersects");
        } else {
            body.bbox = bboxOf(request.area);
            serverApplies.push("bbox (of the polygon)");
            clientApplies.push("polygon");
            degradations.push({kind: "area-as-bbox", reason: "GET request: polygons are sent as their bbox and tested on the client"});
        }
    }

    if (request.sortby?.length) {
        if (caps.sort) {
            body.sortby = request.sortby.map((s) => ({field: sortField(s.field), direction: s.direction}));
            serverApplies.push("sortby");
        } else {
            degradations.push({kind: "sort-dropped", reason: "the server does not advertise sorting"});
        }
    }
    if (request.fields) {
        if (caps.fields) { body.fields = request.fields; serverApplies.push("fields"); }
        else degradations.push({kind: "fields-dropped"});
    }
    if (request.q) {
        if (caps.freeText) { body.q = request.q; serverApplies.push("q"); }
        else degradations.push({kind: "q-dropped"});
    }

    let limit = request.limit ?? options.pageSize ?? 50;
    if (profile.maxLimit && limit > profile.maxLimit) {
        degradations.push({kind: "limit-clamped", from: limit, to: profile.maxLimit});
        limit = profile.maxLimit;
    }
    body.limit = limit;
    Object.assign(body, request.extra ?? {});

    // POST by default (no URL length limits; every server tested accepts it); GET when asked or after a 405.
    const method: "GET" | "POST" = postAllowed ? "POST" : "GET";
    const http: HttpRequestSpec = method === "POST"
        ? {method, url: searchUrl, headers: {"Content-Type": "application/json", Accept: "application/geo+json"}, body}
        : {method, url: withQuery(searchUrl, getParams(body)), headers: {Accept: "application/geo+json"}};
    return {request, http, filterEncoding: encoding, serverApplies, clientApplies, degradations, code: codeOf(http)};
}

/**
 * GET query parameters of a search body.
 *
 * `sortby` becomes `"-field,field"` (a `-` for descending), `fields` becomes `"include,-exclude"`, arrays of plain
 * values are comma-joined (`bbox`, `collections`), other objects are JSON (`intersects`, `query`, a CQL2-JSON
 * `filter`), and the rest are converted with `String`. Undefined values are left out.
 *
 * @param body A search body as built for POST.
 * @returns Parameter name to string value, ready for a query string (not yet URL-encoded).
 *
 * @category Search
 */
export function getParams(body: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (k === "sortby" && Array.isArray(v)) {
            out.sortby = (v as { field: string; direction: string }[]).map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`).join(",");
        } else if (k === "fields" && typeof v === "object") {
            const f = v as { include?: string[]; exclude?: string[] };
            out.fields = [...(f.include ?? []), ...(f.exclude ?? []).map((x) => `-${x}`)].join(",");
        } else if (Array.isArray(v) && v.every((x) => typeof x !== "object")) {
            out[k] = v.join(",");
        } else if (typeof v === "object") {
            out[k] = JSON.stringify(v);
        } else {
            out[k] = String(v);
        }
    }
    return out;
}

/**
 * A URL with query parameters set (replacing parameters of the same name already in the URL).
 *
 * @param url An absolute URL.
 * @param params Parameter name to value; values are URL-encoded.
 * @returns The new URL as a string.
 * @throws `TypeError` (from `URL`) when `url` is not an absolute URL.
 *
 * @category Search
 */
export function withQuery(url: string, params: Record<string, string>): string {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
}

/**
 * The request as curl and fetch code. `secretHeaders` are the names of headers the client adds (their values show as
 * `<redacted>`); request parameters the client adds are never in the URL.
 *
 * @internal
 *
 * @category Search
 */
export function codeOf(http: HttpRequestSpec, secretHeaders: string[] = []): { curl: string; fetch: string } {
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const secret = Object.fromEntries(secretHeaders.map((h) => [h, "<redacted>"]));
    const curlHeaders = secretHeaders.map((h) => ` -H ${sq(`${h}: <redacted>`)}`).join("");
    if (http.method === "GET") {
        return {curl: `curl${curlHeaders} ${sq(http.url)}`, fetch: secretHeaders.length
            ? `await (await fetch(${JSON.stringify(http.url)}, {headers: ${JSON.stringify(secret)}})).json()`
            : `await (await fetch(${JSON.stringify(http.url)})).json()`};
    }
    const body = JSON.stringify(http.body);
    return {
        curl: `curl -X POST ${sq(http.url)} -H 'Content-Type: application/json'${curlHeaders} -d ${sq(body)}`,
        fetch: `await (await fetch(${JSON.stringify(http.url)}, {method: "POST", headers: ${JSON.stringify({"Content-Type": "application/json", ...secret})}, body: ${JSON.stringify(body)}})).json()`,
    };
}

// ------------------------------------------------------------------------------------------------ client checks

/**
 * Whether an item satisfies a request: collections, ids, datetime, area and predicates. Used to verify that a
 * server applied what it claims, and to filter on the client when it cannot.
 *
 * The item's time is its `start_datetime`/`end_datetime`, else its `datetime`; it matches when it overlaps the
 * request's interval, and never when it has no parsable time. An item without `collection` passes the collection
 * test. The area test is approximate (see {@link intersectsArea}); predicates are evaluated with
 * {@link evaluateCql2}. The request's `query`, `q`, `sortby` and `fields` are not checked.
 *
 * @param item The STAC item to test.
 * @param request The request it should satisfy.
 * @param parts Which tests to run; each defaults to `true`. Collections and ids are always tested.
 * @param parts.area Test the item's footprint against `request.area`.
 * @param parts.datetime Test the item's time against `request.datetime`.
 * @param parts.predicates Test `request.where` and `request.filter`.
 * @returns `true` when the item passes every test that was run.
 * @throws `Error` when a predicate uses a CQL2 operator {@link evaluateCql2} cannot evaluate.
 * @example
 * ```ts
 * const request: StacSearchRequest = {area, datetime: "2024", where: {"eo:cloud_cover": {lt: 20}}}; // area drawn by the user
 * const items: StacItemJson[] = page.features;  // items returned by a server
 * const kept = items.filter((item) => itemMatches(item, request, {area: false})); // skip the costly area test
 * ```
 *
 * @category Search
 */
export function itemMatches(item: StacItemJson, request: StacSearchRequest, parts: { area?: boolean; datetime?: boolean; predicates?: boolean } = {}): boolean {
    const {area = true, datetime = true, predicates = true} = parts;
    if (request.collections?.length && item.collection && !request.collections.includes(item.collection)) return false;
    if (request.ids?.length && !request.ids.includes(item.id)) return false;
    if (datetime) {
        const range = datetimeRange(normaliseDatetime(request.datetime));
        if (range) {
            const p = item.properties;
            const s = Date.parse(String(p.start_datetime ?? p.datetime ?? ""));
            const e = Date.parse(String(p.end_datetime ?? p.datetime ?? ""));
            if (Number.isNaN(s) || s > range[1] || (Number.isNaN(e) ? s : e) < range[0]) return false;
        }
    }
    if (area && request.area && !intersectsArea(item, request.area)) return false;
    if (predicates) {
        const expr = requestFilter(request);
        if (expr !== undefined && !evaluateCql2(expr, item)) return false;
    }
    return true;
}
