/**
 * What a URL or a file is: a GeoTIFF, a ria-geotiff manifest, or one of the STAC documents (item, item collection,
 * collection, static catalog, API), found with one range request, so that an application can offer a single box
 * for any source.
 */
import type {HttpRequestOptions} from "@luciad/ria/util/HttpRequestOptions.js";
import type {HttpAccessOptions} from "../fileutils.js";
import {accessFetch, RedirectWithheldError, type AccessHook, type RiaGeoTiffRequest, type RiaGeoTiffRequestListener} from "../http.js";
import {DEFAULT_SIGNERS, type AssetSigner} from "../stac/assets.js";
import {parseCapabilities} from "../stac/capabilities.js";
import type {StacCatalogJson, StacCollectionJson, StacItemJson, StacLink} from "../stac/json.js";
import {absolutize, linkHref} from "../stac/links.js";
import type {RiaGeoTiffProblem} from "../errors.js";
import {analyzeCog, IDENTIFY_PROBE_BYTES, urlReader, type CogProbe} from "./cog.js";
import {MANIFEST_TYPE, validateManifest, type StackManifest} from "./manifest.js";

export {IDENTIFY_PROBE_BYTES};

/** Largest JSON document {@link identifySource} reads, in bytes (32 MiB); a larger one is reported as unknown.
 *
 * @category Sources */
export const IDENTIFY_MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Options of {@link identifySource}: the HTTP options of `GeoTiffTileSetModel.create`, applied with the same rules
 * (credentials, headers and parameters only to the origin of the URL given, redirects to another origin refused),
 * and an abort signal.
 *
 * @category Sources
 */
export interface IdentifySourceOptions extends HttpAccessOptions {
    /** Decides the options of the requests instead (kind `"source"`), see {@link AccessHook}. */
    access?: AccessHook;
    /** Rewrites the URL before it is requested (a CORS proxy), as for GeoTIFF inputs. The result shows the URL as given. */
    rewriteUrl?: (url: string) => string;
    /** Signers tried on the URL, as for GeoTIFF inputs. Default {@link DEFAULT_SIGNERS}; `[]` signs nothing. */
    signers?: AssetSigner[];
    /** Aborts the requests: the promise then rejects with the signal's reason. */
    signal?: AbortSignal;
    /** Called after every request (kind `"source"`), for logs and request counters; see {@link RiaGeoTiffRequest}. */
    onRequest?: RiaGeoTiffRequestListener;
}

/** The kinds {@link identifySource} recognises, the `kind` of an {@link IdentifiedSource}.
 *
 * @category Sources */
export type SourceKind = IdentifiedSource["kind"];

/** Fields of every {@link IdentifiedSource}.
 *
 * @category Sources */
export interface IdentifiedBase {
    /**
     * The absolute URL that was identified, as given (relative URLs resolved against the page), without signing,
     * rewriting or added request parameters. Undefined for a `Blob` or `File`.
     */
    url?: string;
    /** The `Blob` or `File` that was identified; undefined for a URL. */
    file?: Blob;
}

/**
 * A TIFF (classic or BigTIFF): open it with `GeoTiffTileSetModel.create({url})` or `({file})`, whether it is a COG
 * or not (`cog` says how efficiently it will stream).
 *
 * @category Sources */
export interface IdentifiedGeoTiff extends IdentifiedBase {
    /** A TIFF file. */
    kind: "geotiff";
    /** True for BigTIFF (`II+` / `MM+`). */
    bigTiff: boolean;
    /**
     * Whether it is a Cloud Optimized GeoTIFF, and why not: the same analysis as {@link probeCog}, made from the
     * bytes already read (plus one more read when the directories continue beyond them).
     */
    cog: CogProbe;
}

/** A ria-geotiff manifest: open it with `GeoTiffTileSetModel.create({manifest, base: url})`.
 *
 * @category Sources */
export interface IdentifiedManifest extends IdentifiedBase {
    /** A manifest (`type: "ria-geotiff/stack"`). */
    kind: "manifest";
    /** The manifest as read (not changed). */
    manifest: StackManifest;
    /** The problems of {@link validateManifest}; empty when it is valid. `GeoTiffTileSetModel.create` rejects an invalid one. */
    problems: RiaGeoTiffProblem[];
    /** The document read (the same object as `manifest`). */
    document: unknown;
}

/** A STAC API landing page with item search: connect with `StacClient.connect(url)`.
 *
 * @category Sources */
export interface IdentifiedStacApi extends IdentifiedBase {
    /** A STAC API with item search. */
    kind: "stac-api";
    /** The API URL. */
    url: string;
    /** The landing page's title. */
    title?: string;
    /** The landing page's description. */
    description?: string;
    /** The landing page read. */
    document: StacCatalogJson;
}

/**
 * A STAC catalog without item search: a static catalog, or an OGC API - Features server. Connect with
 * `StacClient.connect(url)`: it searches it as `search` says (the same rule as `StacCapabilities.search`).
 *
 * @category Sources */
export interface IdentifiedStacCatalog extends IdentifiedBase {
    /** A catalog without item search. */
    kind: "stac-catalog";
    /**
     * How `StacClient` searches it: `"crawl"` (a static catalog: `child` and `item` links are followed) or
     * `"collection-items"` (an API with a collections endpoint: each collection's `items` endpoint). Both can be searched.
     */
    search: "crawl" | "collection-items";
    /** The catalog's title. */
    title?: string;
    /** The catalog's description. */
    description?: string;
    /** The catalog read, with links resolved against its URL. */
    document: StacCatalogJson;
}

/** A STAC collection: connect to `apiUrl` when it has one, else to the collection's own URL (a static collection).
 *
 * @category Sources */
export interface IdentifiedStacCollection extends IdentifiedBase {
    /** A collection. */
    kind: "stac-collection";
    /** The collection, with links resolved against its URL. */
    collection: StacCollectionJson;
    /**
     * The API serving the collection: its `root` link (else `parent`), when the collection is served by an API (it
     * has an `items` link, as OGC API - Features and STAC APIs give). No request is made to check it: whether the
     * API has item search is known after `StacClient.connect(apiUrl)`.
     */
    apiUrl?: string;
    /** The document read (the same object as `collection`). */
    document: unknown;
}

/** One STAC item: open it with `GeoTiffTileSetModel.create({stac: {items: [item]}})`.
 *
 * @category Sources */
export interface IdentifiedStacItem extends IdentifiedBase {
    /** An item. */
    kind: "stac-item";
    /** The item, with relative asset hrefs and links resolved against its URL. */
    item: StacItemJson;
    /** The document read (the same object as `item`). */
    document: unknown;
}

/** A GeoJSON FeatureCollection of STAC items (a search result, an exported list).
 *
 * @category Sources */
export interface IdentifiedStacItemCollection extends IdentifiedBase {
    /** An item collection. */
    kind: "stac-item-collection";
    /** The items, with relative asset hrefs and links resolved against the document's URL. */
    items: StacItemJson[];
    /** The `next` link, when the document is a page of a longer result. */
    next?: StacLink;
    /** The document read. */
    document: unknown;
}

/** Not a source this library opens, with the reason.
 *
 * @category Sources */
export interface IdentifiedUnknown extends IdentifiedBase {
    /** Not recognised. */
    kind: "unknown";
    /**
     * Why, in English, for display: the HTTP status (401 and 403 mention credentials), an HTML page, CORS or network
     * failure, JSON that is neither STAC nor a manifest, an empty body, ...
     */
    reason: string;
    /** The HTTP status, when the server answered with an error. */
    status?: number;
    /** The parsed JSON, when the body was JSON. */
    document?: unknown;
}

/** The result of {@link identifySource}: one variant per {@link SourceKind}.
 *
 * @category Sources */
export type IdentifiedSource = IdentifiedGeoTiff | IdentifiedManifest | IdentifiedStacApi | IdentifiedStacCatalog
    | IdentifiedStacCollection | IdentifiedStacItem | IdentifiedStacItemCollection | IdentifiedUnknown;

const CORS = "the server does not allow this page to read it (CORS), or it is unreachable";

/**
 * Finds out what a URL or a file is, so that one input box can open anything: a GeoTIFF, a ria-geotiff manifest, a
 * STAC item, item collection, collection, static catalog or STAC API.
 *
 * One request: a range request for the first {@link IDENTIFY_PROBE_BYTES} bytes (`Range: bytes=0-65535`, a
 * CORS-safelisted header, so no preflight). A server that ignores Range and answers 200 works too: only what is
 * needed is read and the rest of the body is cancelled. A JSON document longer than the probe costs a second plain
 * GET (or, after a 200, the rest of the same body), up to {@link IDENTIFY_MAX_JSON_BYTES}. A `Blob` or `File` is read
 * the same way, without requests.
 *
 * - TIFF magic (`II*\0`, `MM\0*`, BigTIFF `II+\0`, `MM\0+`): `"geotiff"`, with `cog`, the analysis of
 *   {@link probeCog} made from the same bytes. When the directories continue beyond the first bytes (large files
 *   with many tiles), that costs one more range request. The georeferencing is not checked here:
 *   `GeoTiffTileSetModel.infoFromURL` or `create` does that.
 * - JSON with `type: "ria-geotiff/stack"`: `"manifest"`, validated (problems are reported, not thrown).
 * - A STAC `Catalog` whose conformance (or `search` link) gives item search: `"stac-api"`; other catalogs:
 *   `"stac-catalog"`. A `Collection`: `"stac-collection"`. A `Feature` with `stac_version`: `"stac-item"`. A
 *   `FeatureCollection` of STAC items: `"stac-item-collection"`.
 * - Anything else: `"unknown"`, with a reason.
 *
 * Relative hrefs of STAC documents (links and assets) are resolved against the URL, so the documents can be passed on
 * as they are. The options are the HTTP options of `GeoTiffTileSetModel.create`, with the same rules: credentials,
 * headers and parameters go to the URL's origin only (or as the `access` hook decides, kind `"source"`), a matching
 * signer signs the URL and `rewriteUrl` rewrites it; the result shows the URL without any of that.
 *
 * @param source What the user gave: a URL (absolute, or relative to the page), or a `Blob` / `File`.
 * @param options HTTP options and an abort signal, see {@link IdentifySourceOptions}.
 * @returns A promise of what the source is, with the document read (so it need not be fetched again).
 * @throws `RangeError` (rejection) when `source` is not a non-empty string, a `URL` or a `Blob`, or is a relative URL
 *   outside a browser page.
 * @throws The abort reason (rejection) when `options.signal` aborts. HTTP errors, CORS failures and unrecognised
 *   content are not thrown: they give `kind: "unknown"` with a reason.
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 * import {StacClient} from "ria-geotiff/stac";
 *
 * const map = ...;   // your LuciadRIA WebGLMap
 * const url = ...;   // what the user typed
 * const found = await identifySource(url);
 * let model: GeoTiffTileSetModel | null = null;
 * switch (found.kind) {
 *     case "geotiff":
 *         if (!found.cog.isCog) console.warn(`Not a COG, opens slowly: ${found.cog.reasons.join("; ")}`);
 *         model = await GeoTiffTileSetModel.create({url: found.url});
 *         break;
 *     case "manifest": model = await GeoTiffTileSetModel.create({manifest: found.manifest, base: found.url}); break;
 *     case "stac-item": model = await GeoTiffTileSetModel.create({stac: {items: [found.item]}}); break;
 *     case "stac-item-collection": model = await GeoTiffTileSetModel.create({stac: {items: found.items}}); break;
 *     case "stac-api":
 *     case "stac-catalog":
 *     case "stac-collection": {
 *         const catalog = await StacClient.connect(found.kind === "stac-collection" ? found.apiUrl ?? found.url! : found.url!);
 *         const area = ...;   // [west, south, east, north] of the view
 *         const collection = found.kind === "stac-collection" ? found.collection.id : (await catalog.collections({area}))[0].id;
 *         const picked = await catalog.select({collection, area, pick: {coverage: "best"}});
 *         model = await GeoTiffTileSetModel.create({stac: {items: picked.items}});
 *         break;
 *     }
 *     case "unknown": console.log(found.reason); break;
 * }
 * if (model) map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Opened"}));
 * ```
 *
 * @category Sources
 */
export async function identifySource(source: string | URL | Blob, options: IdentifySourceOptions = {}): Promise<IdentifiedSource> {
    if (typeof Blob !== "undefined" && source instanceof Blob) return identifyBlob(source, options.signal);
    if (!(source instanceof URL) && (typeof source !== "string" || !source.trim())) {
        throw new RangeError("identifySource needs a URL (string or URL) or a Blob");
    }
    let url: string;
    try {
        url = new URL(String(source).trim(), typeof location !== "undefined" ? location.href : undefined).toString();
    } catch {
        throw new RangeError(`Not a URL: ${String(source)}`);
    }
    const signal = options.signal;
    const access: HttpRequestOptions | null = options.access ? options.access(new URL(url), "source") : options;
    const signer = (options.signers ?? DEFAULT_SIGNERS).find((s) => s.matches(url));
    const target = async () => {
        const signed = signer ? await signer.sign(url) : url;
        return options.rewriteUrl ? options.rewriteUrl(signed) : signed;
    };
    let response: Response;
    try {
        response = await accessFetch(await target(), access, {headers: {Range: `bytes=0-${IDENTIFY_PROBE_BYTES - 1}`}, signal}, fetch,
            {onRequest: options.onRequest, kind: "source", url});
    } catch (e) {
        if (signal?.aborted) throw signal.reason;
        return {kind: "unknown", url, reason: requestFailure(e)};
    }
    if (!response.ok) return statusFailure(url, response);
    const partial = response.status === 206;
    const reader = response.body?.getReader();
    const first = await readUpTo(response, reader, IDENTIFY_PROBE_BYTES, signal);
    const tiff = tiffMagic(first.bytes);
    if (tiff !== null) {
        if (!first.done) await reader?.cancel().catch(() => undefined);
        // The COG analysis from the bytes read; directories beyond them cost one more range request.
        const more = urlReader(url, options);
        const head = first.bytes.subarray(0, IDENTIFY_PROBE_BYTES);
        let cog: CogProbe;
        try {
            cog = await analyzeCog(async (offset, length) => (offset === 0 ? head.subarray(0, length) : more.reader(offset, length)));
        } catch (e) {
            if (!more.failed(e)) throw e;
            cog = e as CogProbe;
        }
        return {kind: "geotiff", url, bigTiff: tiff, cog};
    }
    let bytes = first.bytes;
    if (looksLikeJson(bytes)) {
        const total = Number(/\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "")?.[1]);
        const complete = partial ? (Number.isFinite(total) ? bytes.length >= total : bytes.length < IDENTIFY_PROBE_BYTES) : first.done;
        if (!complete) {
            if (partial) {
                // A larger document than the probe: read it with a plain GET.
                try {
                    const full = await accessFetch(await target(), access, {signal}, fetch, {onRequest: options.onRequest, kind: "source", url});
                    if (!full.ok) return statusFailure(url, full);
                    const rest = await readUpTo(full, full.body?.getReader(), IDENTIFY_MAX_JSON_BYTES + 1, signal);
                    bytes = rest.bytes;
                } catch (e) {
                    if (signal?.aborted) throw signal.reason;
                    return {kind: "unknown", url, reason: requestFailure(e)};
                }
            } else {
                const rest = await readUpTo(response, reader, IDENTIFY_MAX_JSON_BYTES + 1 - bytes.length, signal);
                bytes = concat([bytes, rest.bytes]);
            }
            if (bytes.length > IDENTIFY_MAX_JSON_BYTES) {
                return {kind: "unknown", url, reason: `a JSON document larger than ${IDENTIFY_MAX_JSON_BYTES / 1048576} MiB`};
            }
        }
    } else if (!first.done) {
        await reader?.cancel().catch(() => undefined);
    }
    return classify(bytes, {url}, response.headers.get("Content-Type"));
}

async function identifyBlob(file: Blob, signal: AbortSignal | undefined): Promise<IdentifiedSource> {
    const head = new Uint8Array(await file.slice(0, IDENTIFY_PROBE_BYTES).arrayBuffer());
    if (signal?.aborted) throw signal.reason;
    const tiff = tiffMagic(head);
    if (tiff !== null) {
        const cog = await analyzeCog(async (offset, length) => {
            if (offset === 0) return head.subarray(0, length);
            if (signal?.aborted) throw signal.reason;
            return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        });
        return {kind: "geotiff", file, bigTiff: tiff, cog};
    }
    if (looksLikeJson(head) && file.size > head.length) {
        if (file.size > IDENTIFY_MAX_JSON_BYTES) return {kind: "unknown", file, reason: `a JSON document larger than ${IDENTIFY_MAX_JSON_BYTES / 1048576} MiB`};
        return classify(new Uint8Array(await file.arrayBuffer()), {file}, file.type);
    }
    return classify(head, {file}, file.type);
}

/** Reads a body until `max` bytes or its end. */
async function readUpTo(response: Response, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, max: number,
    signal: AbortSignal | undefined): Promise<{ bytes: Uint8Array; done: boolean }> {
    if (!reader) return {bytes: new Uint8Array(await response.arrayBuffer()), done: true};
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < max) {
        if (signal?.aborted) {
            await reader.cancel().catch(() => undefined);
            throw signal.reason;
        }
        const {done, value} = await reader.read();
        if (done) return {bytes: concat(chunks), done: true};
        chunks.push(value);
        total += value.length;
    }
    return {bytes: concat(chunks), done: false};
}

function concat(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

/** False for classic TIFF, true for BigTIFF, null when not a TIFF. */
function tiffMagic(b: Uint8Array): boolean | null {
    if (b.length < 4) return null;
    if (b[0] === 0x49 && b[1] === 0x49 && b[3] === 0) return b[2] === 42 ? false : b[2] === 43 ? true : null;
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0) return b[3] === 42 ? false : b[3] === 43 ? true : null;
    return null;
}

function firstChar(b: Uint8Array): string {
    let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
    while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
    return i < b.length ? String.fromCharCode(b[i]) : "";
}

const looksLikeJson = (b: Uint8Array) => firstChar(b) === "{" || firstChar(b) === "[";

function requestFailure(e: unknown): string {
    if (e instanceof RedirectWithheldError) return e.message;
    if (e instanceof TypeError) return CORS;
    return `the request failed: ${(e as Error)?.message ?? String(e)}`;
}

async function statusFailure(url: string, response: Response): Promise<IdentifiedUnknown> {
    await response.body?.cancel().catch(() => undefined);
    const s = response.status;
    const reason = s === 401 || s === 403
        ? `HTTP ${s}: the server refused access; the URL may need credentials (credentials, requestHeaders or requestParameters) or a signed URL`
        : s === 404 ? "HTTP 404: nothing at this URL"
            : s === 416 ? "HTTP 416: the file is empty"
                : `HTTP ${s}${response.statusText ? ` ${response.statusText}` : ""} from the server`;
    return {kind: "unknown", url, reason, status: s};
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function classify(bytes: Uint8Array, where: { url?: string; file?: Blob }, contentType: string | null): IdentifiedSource {
    const unknown = (reason: string, document?: unknown): IdentifiedUnknown => ({kind: "unknown", ...where, reason, ...(document !== undefined ? {document} : {})});
    if (bytes.length === 0 || !firstChar(bytes)) return unknown("the response is empty");
    const text = new TextDecoder().decode(bytes);
    if (!looksLikeJson(bytes)) {
        const head = text.slice(0, 1024).toLowerCase();
        if (/<!doctype html|<html[\s>]/.test(head) || /text\/html/i.test(contentType ?? "")) {
            return unknown("an HTML page, not data: the URL may point at a web page about the data rather than at the file or the API");
        }
        if (head.trimStart().startsWith("<")) return unknown("an XML document: neither a GeoTIFF nor JSON (STAC or a manifest)");
        return unknown(`neither a TIFF nor JSON (starts with "${text.slice(0, 16).replace(/[^\x20-\x7e]/g, "·")}")`);
    }
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        return unknown(`JSON that cannot be parsed: ${(e as Error).message}`);
    }
    if (!isObject(doc)) return unknown("JSON that is not an object: neither a STAC document nor a ria-geotiff manifest", doc);
    const type = doc.type;
    if (type === MANIFEST_TYPE) return {kind: "manifest", ...where, manifest: doc as unknown as StackManifest, problems: validateManifest(doc), document: doc};
    const base = where.url;
    const fix = <T>(d: T) => (base ? absolutize(d, base) : d);
    const stac = typeof doc.stac_version === "string";
    if (type === "Feature") {
        if (!stac) return unknown("a GeoJSON Feature without stac_version: not a STAC item", doc);
        return {kind: "stac-item", ...where, item: fix(doc as unknown as StacItemJson), document: doc};
    }
    if (type === "FeatureCollection") {
        const features = Array.isArray(doc.features) ? doc.features : [];
        const items = features.filter((f) => isObject(f) && typeof f.stac_version === "string") as unknown as StacItemJson[];
        if (!items.length) {
            return unknown(features.length ? "a GeoJSON FeatureCollection without STAC items (no stac_version)" : "an empty FeatureCollection: no items", doc);
        }
        fix(doc);
        const next = Array.isArray(doc.links) ? (doc.links as StacLink[]).find((l) => l?.rel === "next") : undefined;
        return {kind: "stac-item-collection", ...where, items, ...(next ? {next} : {}), document: doc};
    }
    if (type === "Collection" || (stac && type === undefined && isObject(doc.extent))) {
        const collection = fix(doc as unknown as StacCollectionJson);
        let apiUrl: string | undefined;
        if (collection.links?.some((l) => l.rel === "items")) apiUrl = linkHref(collection, "root", base) ?? linkHref(collection, "parent", base);
        return {kind: "stac-collection", ...where, collection, ...(apiUrl ? {apiUrl} : {}), document: doc};
    }
    if (type === "Catalog" || (stac && type === undefined && Array.isArray(doc.links))) {
        const catalog = doc as unknown as StacCatalogJson;
        const title = typeof doc.title === "string" ? doc.title : undefined;
        const description = typeof doc.description === "string" ? doc.description : undefined;
        if (parseCapabilities(catalog).itemSearch && base) return {kind: "stac-api", url: base, ...(where.file ? {file: where.file} : {}), title, description, document: catalog};
        const search = parseCapabilities(catalog).search === "collection-items" ? "collection-items" : "crawl";
        return {kind: "stac-catalog", ...where, title, description, search, document: fix(catalog)};
    }
    if (stac) return unknown(`a STAC document of type ${JSON.stringify(type)}, which this library does not open`, doc);
    if (isObject(doc.properties) || type === "Polygon" || type === "MultiPolygon") return unknown("GeoJSON, but not a STAC document", doc);
    return unknown(`JSON that is neither a STAC document nor a ria-geotiff manifest${typeof type === "string" ? ` (type "${type}")` : ""}`, doc);
}
