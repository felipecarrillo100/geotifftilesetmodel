/**
 * Protected data: credentials, headers and parameters (LuciadRIA's HttpRequestOptions), sent only to the origin
 * they were given for, with redirects to another origin refused.
 */
import type {HttpRequestHeaders, HttpRequestParameters, HttpRequestOptions} from "@luciad/ria/util/HttpRequestOptions.js";
import {BaseClient, BaseResponse} from "geotiff";

/**
 * What a request is for, as passed to an {@link AccessHook}: `"file"` (a GeoTIFF or `.prj` file), `"manifest"`,
 * `"stac-api"` (STAC API, catalog and item documents), `"stac-asset"` (a STAC asset), or `"source"` (the requests
 * of {@link identifySource}, made before the kind of the URL is known).
 *
 * @category Protected data */
export type AccessKind = "file" | "manifest" | "stac-api" | "stac-asset" | "source";

/**
 * Decides per request which credentials, headers and parameters to send, replacing the library's rule (options only
 * to the origin of a URL the application gave for them).
 *
 * @param url The URL that is about to be requested (without added parameters).
 * @param kind What the request is for.
 * @returns The options for that request, or `null` to send none.
 *
 * @category Protected data
 */
export type AccessHook = (url: URL, kind: AccessKind) => HttpRequestOptions | null;

/**
 * The fetch `credentials` mode of LuciadRIA's `credentials` option.
 *
 * @internal
 *
 * @category Protected data
 */
export function credentialsMode(credentials: boolean | RequestCredentials | undefined): RequestCredentials {
    return credentials === true ? "include" : credentials === false || credentials === undefined ? "same-origin" : credentials;
}

/**
 * Adds request parameters to a URL (keeping its query string and fragment).
 *
 * @internal
 *
 * @category Protected data
 */
export function addParameters(url: string, params: HttpRequestParameters | null | undefined): string {
    if (!params) return url;
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return url;
    const [base, hash] = url.split("#", 2);
    const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    return `${base}${base.includes("?") ? "&" : "?"}${query}${hash !== undefined ? `#${hash}` : ""}`;
}

/**
 * The origin of a URL, or null when it is not absolute.
 *
 * @internal
 *
 * @category Protected data
 */
export function originOf(url: string | URL): string | null {
    try {
        return new URL(String(url)).origin;
    } catch {
        return null;
    }
}

const isEmpty = (o: object | null | undefined) => !o || Object.keys(o).length === 0;

/**
 * Error of a redirect to another origin, for a request that carried headers or parameters.
 *
 * @internal
 *
 * @category Protected data
 */
export class RedirectWithheldError extends Error {
    /**
     * Creates the error.
     *
     * @param host The host the credentials were withheld from.
     * @param url The URL that redirected (without added parameters).
     */
    constructor(readonly host: string, url: string) {
        super(`${url} redirects to ${host}: the request's credentials, headers and parameters were withheld from that host`);
        this.name = "RedirectWithheldError";
    }
}

/**
 * Fetches `url` with the given options. A request with headers or parameters uses `redirect: "manual"`: redirects on
 * the same origin are followed (at most 5), a redirect to another origin rejects with a
 * {@link RedirectWithheldError}. Browsers hide the target of a manual redirect: such a redirect is refused too.
 *
 * @internal
 *
 * @category Protected data
 */
export async function accessFetch(url: string, access: HttpRequestOptions | null, init: RequestInit = {}, fetchFn: typeof fetch = fetch,
    observe?: Observe): Promise<Response> {
    if (!observe?.onRequest) return accessFetchOnce(url, access, init, fetchFn);
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const range = new Headers(init.headers as HeadersInit | undefined).get("Range") ?? undefined;
    const report = (status: number | undefined, error?: unknown) => {
        const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
        try {
            observe.onRequest!({url: observe.url ?? url, kind: observe.kind, method: init.method ?? "GET", ...(range ? {range} : {}),
                ...(status !== undefined ? {status} : {}), ms, ...(error !== undefined ? {error: (error as Error)?.message ?? String(error)} : {})});
        } catch (e) {
            console.error("onRequest listener failed", e);
        }
    };
    try {
        const response = await accessFetchOnce(url, access, init, fetchFn);
        report(response.status);
        return response;
    } catch (e) {
        report(undefined, e);
        throw e;
    }
}

/**
 * A request the library made, as given to an `onRequest` listener (of `GeoTiffTileSetModel.create`,
 * `identifySource`, `probeCog`, `readManifest` and `StacClient`): for logs, request counters and progress.
 *
 * `url` is the URL as the application gave it or the library found it: without the added `requestParameters`, without
 * signing (Planetary Computer tokens) and before `rewriteUrl`. Headers and credentials are never reported.
 *
 * @category Protected data
 */
export interface RiaGeoTiffRequest {
    /** The URL, without secrets (see above). */
    url: string;
    /** What was requested: a GeoTIFF or `.prj` file, a manifest, a STAC API document, a STAC asset, or an identified source. */
    kind: AccessKind;
    /** `"GET"` or `"POST"`. */
    method: string;
    /** The `Range` header (`"bytes=0-65535"`), for range requests. */
    range?: string;
    /** The HTTP status; undefined when the request failed (network, CORS, abort, refused redirect). */
    status?: number;
    /** Time until the response headers arrived (or the failure), in milliseconds. */
    ms: number;
    /** Why the request failed, when it did. */
    error?: string;
}

/**
 * Receives every request a model, `identifySource`, `probeCog`, `readManifest` or `StacClient` makes; see
 * {@link RiaGeoTiffRequest}. Errors thrown by the listener are logged and ignored.
 *
 * @category Protected data
 */
export type RiaGeoTiffRequestListener = (request: RiaGeoTiffRequest) => void;

/** What {@link accessFetch} reports, and to whom. @internal */
export interface Observe {
    onRequest?: RiaGeoTiffRequestListener;
    kind: AccessKind;
    /** The URL to report (without signing or rewriting); default the URL requested. */
    url?: string;
}

async function accessFetchOnce(url: string, access: HttpRequestOptions | null, init: RequestInit, fetchFn: typeof fetch): Promise<Response> {
    const headers = {...(init.headers as Record<string, string> | undefined ?? {}), ...(access?.requestHeaders ?? {})};
    const params = access?.requestParameters;
    const credentials = credentialsMode(access?.credentials);
    const guarded = !isEmpty(access?.requestHeaders) || !isEmpty(params);
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
        const response = await fetchFn(addParameters(current, params), {...init, headers, credentials, ...(guarded ? {redirect: "manual"} : {})});
        if (!guarded || !(response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400 && response.status !== 304))) return response;
        const location = response.headers.get("Location");
        if (!location) throw new RedirectWithheldError("an undisclosed host", current);
        const next = new URL(location, current);
        if (next.origin !== new URL(current).origin) throw new RedirectWithheldError(next.host, current);
        // Same origin: follow, without parameters the server added (they are added again from the options).
        current = next.toString();
    }
    throw new Error(`Too many redirects from ${url}`);
}

class AccessResponse extends BaseResponse {
    constructor(private readonly response: Response) {
        super();
    }

    override get status(): number {
        return this.response.status;
    }

    override getHeader(name: string): string | undefined {
        return this.response.headers.get(name) ?? undefined;
    }

    override async getData(): Promise<ArrayBuffer> {
        return this.response.arrayBuffer();
    }
}

/**
 * A geotiff.js client whose options are read on every request (so renewed tokens are used at once), with the
 * redirect rule of {@link accessFetch}.
 *
 * @internal
 *
 * @category Protected data
 */
export class AccessClient extends BaseClient {
    constructor(url: string, private readonly accessOf: () => HttpRequestOptions | null, private readonly observe?: Observe) {
        super(url);
    }

    /** The last refused redirect (geotiff.js does not pass request errors on). */
    withheld: RedirectWithheldError | null = null;

    override async request(options: RequestInit = {}): Promise<BaseResponse> {
        try {
            return new AccessResponse(await accessFetch(this.url, this.accessOf(), {headers: options.headers, signal: options.signal}, fetch, this.observe));
        } catch (e) {
            if (e instanceof RedirectWithheldError) this.withheld = e;
            throw e;
        }
    }
}

/**
 * Header values replaced by `<redacted>`, for display.
 *
 * @internal
 *
 * @category Protected data
 */
export function redactHeaders(headers: HttpRequestHeaders | null | undefined): Record<string, string> {
    return Object.fromEntries(Object.keys(headers ?? {}).map((k) => [k, "<redacted>"]));
}

/**
 * How an input that the library found (not one the application gave) gets options: only on `origin` (a manifest's
 * own server), or through `hook` (STAC `assetAccess`); with neither, none.
 *
 * @internal
 *
 * @category Protected data
 */
export const discoveredInputs = new WeakMap<object, { kind: AccessKind; origin: string | null; hook?: AccessHook }>();
