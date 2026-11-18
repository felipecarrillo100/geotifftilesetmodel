import type {HttpRequestHeaders, HttpRequestOptions, HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";
import {parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {accessFetch, addParameters, credentialsMode, type RiaGeoTiffRequestListener} from "./http.js";

/**
 * HTTP options shared by every request this library makes (GeoTIFF range requests and `.prj` files). Part of the
 * options of {@link GeoTiffTileSetModel.create}, which apply them to files, manifests and STAC items.
 *
 * @category Protected data
 */
export interface HttpAccessOptions extends HttpRequestOptions {
    /**
     * Cookies and HTTP authentication, as LuciadRIA's option: `true` = `"include"`, `false` or unset =
     * `"same-origin"`, or a fetch credentials mode (`"omit"`, `"same-origin"`, `"include"`).
     */
    credentials?: boolean | RequestCredentials;
    /**
     * Headers sent with every request to the intended server (`{Authorization: "Bearer …"}`). Never written to
     * manifests or shown in messages.
     */
    requestHeaders?: null | HttpRequestHeaders;
    /**
     * Query parameters added to every request to the intended server (`{token: "…"}`). Never written to manifests
     * or shown in messages.
     */
    requestParameters?: null | HttpRequestParameters;
}

/**
 * The fetch `credentials` mode for {@link HttpAccessOptions.credentials}.
 *
 * @param options the HTTP options of a request
 * @returns `"include"` when `options.credentials` is true, `"same-origin"` when it is false or unset, else the
 *   mode it names
 *
 * @category Protected data
 */
export function fetchCredentials(options: HttpAccessOptions): RequestCredentials {
    return credentialsMode(options.credentials);
}

/**
 * Adds `options.requestParameters` to the query string of a URL.
 *
 * @param url the URL to extend; an existing query string and `#fragment` are kept
 * @param options the HTTP options whose `requestParameters` are added (URI-encoded)
 * @returns `url` with the parameters appended, or `url` unchanged when there are none
 *
 * @category Protected data
 */
export function withRequestParameters(url: string, options: HttpAccessOptions): string {
    return addParameters(url, options.requestParameters);
}

/**
 * Reads the coordinate reference from a `.prj` file next to the GeoTIFF (same name, `.prj` extension).
 *
 * The `.prj` URL is the GeoTIFF URL with its extension replaced by `.prj`; its query string is kept and a
 * `#fragment` is dropped (`scene.tif?v=2#x` gives `scene.prj?v=2`). `prepare` then turns it into the URL that is
 * requested, as the GeoTIFF's own URL was: `GeoTiffTileSetModel.create` signs it with the input's signer and passes
 * it through `rewriteUrl`, and requests it with the input's HTTP options. The text is parsed as Well-Known Text with
 * LuciadRIA's `parseWellKnownText`. This function never throws: every failure (no file, HTTP error, a failing
 * `prepare`, unparsable text) gives null.
 *
 * @param url URL of the GeoTIFF, unsigned and not rewritten
 * @param options HTTP options used for the request (the `.prj` file is on the GeoTIFF's origin), or null for none
 * @param prepare turns the `.prj` URL into the URL to request (signing, a CORS proxy). Default: none, the URL is
 *   requested as is.
 * @returns a promise for the LuciadRIA reference identifier, or for null when there is no readable `.prj`
 *
 * @example
 * ```ts
 * const url = ...;                         // URL of a GeoTIFF without EPSG code, provided by the application
 * const proxy = (u: string) => `/proxy?url=${encodeURIComponent(u)}`;
 * const identifier = await getReferenceFromPrjFile(url, null, proxy); // for example "EPSG:32633", or null
 * ```
 *
 * @category Protected data
 */
export async function getReferenceFromPrjFile(url: string, options: HttpAccessOptions | null,
    prepare?: (prjUrl: string) => string | Promise<string>, onRequest?: RiaGeoTiffRequestListener): Promise<string | null> {
    try {
        const prjUrl = prjUrlOf(url);
        const response = await accessFetch(prepare ? await prepare(prjUrl) : prjUrl, options, {}, fetch, {onRequest, kind: "file", url: prjUrl});
        if (!response.ok) return null;
        return parseWellKnownText(await response.text()).identifier;
    } catch {
        return null;
    }
}

/** The `.prj` URL next to a GeoTIFF URL: extension replaced, query kept, fragment dropped. */
function prjUrlOf(url: string): string {
    const hash = url.indexOf("#");
    const withoutHash = hash >= 0 ? url.slice(0, hash) : url;
    const q = withoutHash.indexOf("?");
    const path = q >= 0 ? withoutHash.slice(0, q) : withoutHash;
    const query = q >= 0 ? withoutHash.slice(q) : "";
    const dot = path.lastIndexOf(".");
    return (dot > path.lastIndexOf("/") ? path.slice(0, dot) : path) + ".prj" + query;
}
