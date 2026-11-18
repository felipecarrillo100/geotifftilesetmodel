import type {HttpRequestHeaders, HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";
import {parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";

/** HTTP options shared by every request this library makes. */
export interface HttpAccessOptions {
    /** Send cookies / HTTP authentication with cross-origin requests too. Default false (same-origin only). */
    credentials?: boolean;
    /** Extra headers sent with every request. */
    requestHeaders?: null | HttpRequestHeaders;
    /** Extra query parameters appended to every request URL. */
    requestParameters?: null | HttpRequestParameters;
}

/** The fetch `credentials` mode for {@link HttpAccessOptions.credentials}. */
export function fetchCredentials(options: HttpAccessOptions): RequestCredentials {
    return options.credentials ? "include" : "same-origin";
}

/** `url` with `options.requestParameters` added to its query string. */
export function withRequestParameters(url: string, options: HttpAccessOptions): string {
    const params = options.requestParameters;
    if (!params || Object.keys(params).length === 0) return url;
    const [base, hash] = url.split("#", 2);
    const query = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
    return `${base}${base.includes("?") ? "&" : "?"}${query}${hash !== undefined ? `#${hash}` : ""}`;
}

/**
 * Reads the coordinate reference from a `.prj` file next to the GeoTIFF (same name, `.prj` extension).
 * @returns the LuciadRIA reference identifier, or null when there is no readable `.prj`
 */
export async function getReferenceFromPrjFile(url: string, options: HttpAccessOptions): Promise<string | null> {
    try {
        const [path, query] = url.split("?", 2);
        const dot = path.lastIndexOf(".");
        const prjUrl = (dot > path.lastIndexOf("/") ? path.slice(0, dot) : path) + ".prj" + (query ? `?${query}` : "");
        const response = await fetch(withRequestParameters(prjUrl, options), {
            headers: options.requestHeaders ?? undefined,
            credentials: fetchCredentials(options),
        });
        if (!response.ok) return null;
        return parseWellKnownText(await response.text()).identifier;
    } catch {
        return null;
    }
}
