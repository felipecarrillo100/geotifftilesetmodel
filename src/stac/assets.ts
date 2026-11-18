/**
 * From STAC assets to readable URLs: https hrefs or https alternates, signing (Planetary Computer SAS tokens or
 * your own), and a verdict on whether a browser can read the asset at all.
 */
import {assetBands, type BandDescriptor} from "./bands.js";
import type {StacAssetJson, StacItemJson} from "./json.js";

/** Signs asset URLs that need it (tokens), for one provider.
 *
 * @category Assets and bands */
export interface AssetSigner {
    /** Identifier of a well-known signer, written to manifests (`"planetary-computer"`). Optional. */
    id?: string;
    /**
     * Whether this signer handles a URL.
     *
     * @param url An https asset URL.
     * @param item The STAC item the URL comes from, when known (asset URLs); undefined for plain input URLs.
     * @returns True when {@link AssetSigner.sign} should be used for the URL.
     */
    matches(url: string, item?: StacItemJson): boolean;
    /**
     * Signs a URL, for example by appending a token. A model calls it once when it opens the input, and again
     * when a read fails (it then reopens the file with the new URL and retries the read once). It is not called
     * for every range request, so tokens must stay valid for a while; return a cached token while it is valid.
     *
     * @param url An asset URL for which `matches` returned true.
     * @returns A promise of the signed URL.
     */
    sign(url: string): Promise<string>;
}

/** The result of {@link resolveAsset}: which URL to read for an asset, and whether a browser can read it.
 *
 * @category Assets and bands */
export interface ResolvedAsset {
    /** The asset key in the item's `assets`. */
    key: string;
    /**
     * URL to read: the first https URL, else the first http URL (signing happens through `sign` so expiring
     * tokens can be renewed).
     */
    href: string;
    /**
     * What to expect: `"yes"` readable as is, `"signed"` readable after `sign`, `"needs-auth"` the item declares an
     * authentication scheme no signer handles, `"no"` no http(s) URL (for example s3:// only, or requester-pays
     * storage), or only an `http://` URL on a page served over https (browsers block it as mixed content). For
     * `"no"` without any http(s) URL, `href` is the original href.
     */
    readable: "yes" | "signed" | "needs-auth" | "no";
    /** Why the asset is `"no"` or `"needs-auth"`, for display: `"mixed content"` for an http URL on an https page. */
    reason?: string;
    /** Signs `href` (or a URL derived from it) before a request; present when `readable` is `"signed"`. */
    sign?: (url: string) => Promise<string>;
    /** The asset's bands, from STAC 1.1 `bands`, `eo:bands` and `raster:bands`. */
    bands: BandDescriptor[];
}

/**
 * Whether a URL is an Azure blob URL without a SAS token, the kind of URL Planetary Computer items point to.
 *
 * Every Azure storage account has such URLs, so this alone does not mean the URL belongs to the Planetary Computer:
 * {@link planetaryComputerSigner} also requires the item to come from the Planetary Computer.
 *
 * @param url Any URL.
 * @returns True for `https://{account}.blob.core.windows.net/...` URLs that have no `sig` query parameter.
 *
 * @category Assets and bands
 */
export function isPlanetaryComputerUrl(url: string): boolean {
    return /^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\//.test(url) && !/[?&]sig=/.test(url);
}

/**
 * Whether a STAC item comes from the Microsoft Planetary Computer: one of its links points to
 * `planetarycomputer.microsoft.com`, or it has `msft:` properties.
 *
 * @param item The STAC item.
 * @returns True for Planetary Computer items.
 *
 * @category Assets and bands
 */
export function isPlanetaryComputerItem(item: StacItemJson): boolean {
    return (item.links ?? []).some((l) => /^https:\/\/planetarycomputer(-test)?\.microsoft\.com\//.test(l.href))
        || Object.keys(item.properties ?? {}).some((k) => k.startsWith("msft:"));
}

const tokens = new Map<string, Promise<{ token: string; expiry: number }>>();

/**
 * Signs Planetary Computer blob URLs with an anonymous SAS token, cached per storage account and container and
 * renewed 5 minutes before it expires (tokens last about 45 minutes).
 *
 * The result is both a function (`sign(url)`) and an {@link AssetSigner} (`id`, `matches`, `sign`), so it can be
 * passed wherever either is expected. As a signer it matches Azure blob URLs without a token of items that come
 * from the Planetary Computer ({@link isPlanetaryComputerItem}); without an item (plain input URLs) it matches
 * nothing: pass it as the input's `sign` for such URLs. Signing removes any existing SAS parameters from the URL before appending the new
 * token. URLs that are not Azure blob URLs are returned unchanged. The token cache is shared by all signers with
 * the same endpoint.
 *
 * @param endpoint Base URL of the SAS token service; `/{account}/{container}` is appended. Default
 *   `"https://planetarycomputer.microsoft.com/api/sas/v1/token"`.
 * @returns A signer; calling it returns a promise of the signed URL. That promise rejects with an `Error` when the
 *   token request fails (non-2xx response) and with the fetch error on network failure.
 * @example
 * ```ts
 * const assetHref = "https://example.blob.core.windows.net/container/scene.tif"; // an asset href from a STAC item
 * const signer = planetaryComputerSigner();
 * const signedUrl = await signer(assetHref);
 * ```
 *
 * @category Assets and bands
 */
export function planetaryComputerSigner(endpoint = "https://planetarycomputer.microsoft.com/api/sas/v1/token"): AssetSigner & ((url: string) => Promise<string>) {
    const sign = async (url: string): Promise<string> => {
        const match = /^https:\/\/([a-z0-9]+)\.blob\.core\.windows\.net\/([^/?]+)/.exec(url);
        if (!match) return url;
        const [, account, container] = match;
        const key = `${endpoint}/${account}/${container}`;
        let pending = tokens.get(key);
        const current = pending ? await pending.catch(() => null) : null;
        if (!current || current.expiry - Date.now() < 5 * 60 * 1000) {
            pending = (async () => {
                const response = await fetch(`${endpoint}/${account}/${container}`);
                if (!response.ok) throw new Error(`Planetary Computer token request failed: HTTP ${response.status}`);
                const body = await response.json() as { token: string; "msft:expiry"?: string };
                const expiry = body["msft:expiry"] ? Date.parse(body["msft:expiry"]) : Date.now() + 30 * 60 * 1000;
                return {token: body.token, expiry};
            })();
            tokens.set(key, pending);
        }
        const {token} = await pending!;
        const base = url.replace(/[?&](st|se|sp|sv|sr|skoid|sktid|skt|ske|sks|skv|sig)=[^&]*/g, "");
        return `${base}${base.includes("?") ? "&" : "?"}${token}`;
    };
    const matches = (url: string, item?: StacItemJson) => isPlanetaryComputerUrl(url) && item !== undefined && isPlanetaryComputerItem(item);
    return Object.assign(sign, {id: "planetary-computer", matches, sign});
}

/**
 * The default signers: Planetary Computer. Used by {@link resolveAsset} and `GeoTiffTileSetModel.create` when no
 * signers are given.
 *
 * @category Assets and bands
 */
export const DEFAULT_SIGNERS: AssetSigner[] = [planetaryComputerSigner()];

/**
 * A readable URL for an asset: its href when https, else an https alternate, else an http one; signed by the first
 * matching signer. `readable` says what to expect: "no" for s3:// without an http(s) alternate, for requester-pays
 * storage, and for an http-only asset when the page is served over https (`reason` `"mixed content"`: browsers
 * block such requests); "needs-auth" when the item declares an authentication scheme no signer handles.
 *
 * Among the href and the `alternate` hrefs, the first https URL is used, else the first http URL; a relative href
 * (static catalogs) is first resolved against the item's `self` link. An http URL is
 * readable when the page is not served over https (an http page, or no page at all, as in Node.js). Signers are
 * checked before `auth:refs` (on the asset, else on the item properties). No request is made: this only inspects
 * the JSON and `location.protocol`.
 *
 * @param item The STAC item.
 * @param key The asset key in `item.assets`.
 * @param signers Signers to try, in order. Default {@link DEFAULT_SIGNERS}; pass `[]` to disable signing.
 * @returns The resolved asset, with its bands.
 * @throws `RangeError` When the item has no asset with that key.
 * @example
 * ```ts
 * const [item] = await client.search({collections: [collectionId], maxItems: 1}).collect(); // collectionId chosen by the user
 * const assetKey = (await client.describeCollection(collectionId)).assets[0].key; // or an asset key chosen by the user
 * const resolved = resolveAsset(item, assetKey);
 * if (resolved.readable === "yes" || resolved.readable === "signed") {
 *     const url = resolved.sign ? await resolved.sign(resolved.href) : resolved.href;
 *     // read the GeoTIFF at url
 * } else {
 *     console.warn(`Cannot read ${resolved.key}: ${resolved.reason}`);
 * }
 * ```
 *
 * @category Assets and bands
 */
export function resolveAsset(item: StacItemJson, key: string, signers: AssetSigner[] = DEFAULT_SIGNERS): ResolvedAsset {
    const asset: StacAssetJson | undefined = item.assets[key];
    if (!asset) throw new RangeError(`Item ${item.id} has no asset "${key}"`);
    const bands = assetBands(asset);
    // Relative hrefs (static catalogs) resolve against the item's own URL, its self link.
    const self = item.links?.find((l) => l.rel === "self")?.href;
    const absolute = (h: string) => {
        if (!self || /^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
        try { return new URL(h, self).toString(); } catch { return h; }
    };
    const candidates = [asset.href, ...Object.values(asset.alternate ?? {}).map((a) => a.href)].filter((h) => typeof h === "string").map(absolute);
    const href = candidates.find((h) => /^https:\/\//i.test(h)) ?? candidates.find((h) => /^http:\/\//i.test(h));
    if (!href) {
        const reason = asset["storage:requester_pays"] || /requester/i.test(JSON.stringify(asset["storage:refs"] ?? "")) ? "requester-pays storage" : `no https URL (${asset.href.split(":")[0]})`;
        return {key, href: asset.href, readable: "no", reason, bands};
    }
    // An https page cannot read http URLs: browsers block them as mixed content.
    if (/^http:/i.test(href) && typeof location !== "undefined" && location.protocol === "https:") {
        return {key, href, readable: "no", reason: "mixed content", bands};
    }
    const signer = signers.find((s) => s.matches(href, item));
    if (signer) return {key, href, readable: "signed", sign: Object.assign((u: string) => signer.sign(u), {signer}), bands};
    const auth = asset["auth:refs"] ?? item.properties["auth:refs"];
    if (auth) return {key, href, readable: "needs-auth", reason: `authentication required (${JSON.stringify(auth)})`, bands};
    return {key, href, readable: "yes", bands};
}
