import type {CoordinateReference} from "@luciad/ria/reference/CoordinateReference.js";
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import type {HttpRequestOptions} from "@luciad/ria/util/HttpRequestOptions.js";
import {fromCustomClient, Pool, type GeoTIFF, type GeoTIFFImage} from "geotiff";
import {GeoTiffModelError} from "./errors.js";
import {AccessClient, RedirectWithheldError, type Observe} from "./http.js";

/** Helpers shared by the models: opening files, the decoder pool, references. */

let sharedPool: Pool | null | undefined;

/** A shared decoder pool in browsers (web workers), none elsewhere. */
export function defaultPool(): Pool | null {
    if (sharedPool === undefined) {
        sharedPool = typeof window !== "undefined" && typeof Worker !== "undefined" ? new Pool() : null;
    }
    return sharedPool;
}

/**
 * Opens a GeoTIFF over HTTP. `access` gives the credentials, headers and parameters of each request (read again for
 * every request, so renewed tokens apply at once). `cacheSize` is the number of 64 KiB blocks of fetched bytes
 * geotiff.js keeps per file (its default is 100). `displayUrl` is the URL shown in errors (without tokens).
 */
export async function openURL(url: string, access: () => HttpRequestOptions | null, cacheSize?: number, displayUrl = url,
    observe?: Observe): Promise<GeoTIFF> {
    const client = new AccessClient(url, access, observe && {...observe, url: displayUrl});
    try {
        const sourceOptions = {
            allowFullFile: true,
            // Explicit on purpose: reads are then grouped into cached 64 KiB blocks. geotiff.js 3.0.4/3.0.5 dropped
            // this default for fromUrl() (geotiff.js #516, fixed by #530 in 3.1), which floods the server with small
            // range requests.
            blockSize: 65536,
            ...(cacheSize ? {cacheSize} : {}),
        } as Parameters<typeof fromCustomClient>[1];
        // geotiff.js' decoded-tile cache (`tiff.cache = true`) is not enabled: fetched bytes are already cached by its
        // block source, so re-reading a block costs a decode, not a request. Keep the explicit blockSize when moving
        // to geotiff.js 3.1 (which restores the default itself): it costs nothing and guards against such changes.
        return await fromCustomClient(client, sourceOptions);
    } catch (error) {
        // A refused cross-origin redirect is buried in geotiff.js' aggregate error: name the withheld host.
        const withheld = client.withheld ?? findWithheld(error);
        throw new GeoTiffModelError(`Error loading GeoTIFF file from URL: ${displayUrl}${withheld ? ` (${withheld.message})` : ""}`,
            "ERROR_LOADING_FILE", {error: withheld ?? error});
    }
}

function findWithheld(error: unknown, depth = 0): RedirectWithheldError | null {
    if (error instanceof RedirectWithheldError) return error;
    if (!error || typeof error !== "object" || depth > 4) return null;
    const e = error as { errors?: unknown[]; cause?: unknown; reason?: unknown };
    for (const inner of [...(Array.isArray(e.errors) ? e.errors : []), e.cause, e.reason]) {
        const found = findWithheld(inner, depth + 1);
        if (found) return found;
    }
    return null;
}

/** Maps `items` with at most `limit` calls of `fn` in flight; rejects with the first error. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return results;
}

export async function readImages(tiff: GeoTIFF): Promise<GeoTIFFImage[]> {
    try {
        const count = await tiff.getImageCount();
        const images: GeoTIFFImage[] = [];
        for (let i = 0; i < count; i++) images.push(await tiff.getImage(i));
        return images;
    } catch (error) {
        throw new GeoTiffModelError("Error reading the GeoTIFF image directories", "ERROR_LOADING_FILE", {error});
    }
}

export function resolveReference(identifier: string | null): CoordinateReference {
    if (!identifier) {
        throw new GeoTiffModelError(
            "The GeoTIFF declares no EPSG coordinate reference (and no .prj file was found next to it): give the input's crsName (\"EPSG:2056\"), or options.reference",
            "BoundsMissing",
        );
    }
    try {
        return getReference(identifier);
    } catch (error) {
        throw new GeoTiffModelError(`Unknown coordinate reference ${identifier}`, "UnknownIdentifier", {identifier, error});
    }
}
