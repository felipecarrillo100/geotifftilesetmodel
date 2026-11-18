/**
 * Relative links and asset hrefs of STAC documents read from a URL (static catalogs write them relative to the
 * document), made absolute so that the documents can be used on their own.
 */
import type {StacLink} from "./json.js";

/**
 * Resolves the `links[].href` and `assets[*].href` (and their `alternate` hrefs) of a STAC document against the
 * URL it was read from, in place, and adds a `self` link when it has none (not to the features of a
 * FeatureCollection: their own URL is unknown). Hrefs that are already absolute are
 * kept; hrefs that cannot be resolved are left as they are.
 *
 * @internal
 *
 * @category STAC JSON
 */
export function absolutize<T>(doc: T, url: string, addSelf = true): T {
    if (!doc || typeof doc !== "object") return doc;
    const d = doc as { links?: StacLink[]; assets?: Record<string, { href?: string; alternate?: Record<string, { href?: string }> }>; features?: unknown[] };
    const resolve = (href: unknown) => {
        if (typeof href !== "string") return href;
        try {
            return new URL(href, url).toString();
        } catch {
            return href;
        }
    };
    if (Array.isArray(d.links)) {
        for (const link of d.links) if (link && typeof link === "object") link.href = resolve(link.href) as string;
        if (addSelf && !d.links.some((l) => l?.rel === "self")) d.links.push({rel: "self", href: url});
    } else if (addSelf && !Array.isArray(d.features)) {
        d.links = [{rel: "self", href: url}];
    }
    for (const asset of Object.values(d.assets ?? {})) {
        if (!asset || typeof asset !== "object") continue;
        asset.href = resolve(asset.href) as string;
        for (const alt of Object.values(asset.alternate ?? {})) if (alt && typeof alt === "object") alt.href = resolve(alt.href) as string;
    }
    if (Array.isArray(d.features)) for (const f of d.features) absolutize(f, url, false);
    return doc;
}

/**
 * The absolute href of the first link with a relation, resolved against `base` when it is relative.
 *
 * @internal
 *
 * @category STAC JSON
 */
export function linkHref(doc: { links?: StacLink[] } | null | undefined, rel: string, base?: string): string | undefined {
    const href = doc?.links?.find((l) => l?.rel === rel)?.href;
    if (typeof href !== "string") return undefined;
    try {
        return new URL(href, base).toString();
    } catch {
        return undefined;
    }
}
