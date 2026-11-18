/**
 * Reason codes carried by {@link GeoTiffModelError.cause}.
 *
 * The string values are part of the public API: applications test them with `error.cause === "..."`.
 */
export type GeoTiffModelErrorCause =
    /** The file could not be fetched or is not a TIFF. */
    | "ERROR_LOADING_FILE"
    /** The TIFF is not tiled or not laid out as a Cloud Optimized GeoTIFF. */
    | "NOTCOG"
    /**
     * The coordinate reference of the GeoTIFF is not known to LuciadRIA.
     * `error.identifier` holds the identifier (for example `"EPSG:25832"`): load its definition with
     * `addReference` / `parseWellKnownText` and try again, or pass `options.reference`.
     */
    | "UnknownIdentifier"
    /** The GeoTIFF has no georeferencing and no `options.reference` was given. */
    | "BoundsMissing"
    /** Elevation was requested for data that cannot represent elevation (for example RGB imagery). */
    | "INVALIDELEVATION"
    /**
     * Data of an already opened file could not be read or decoded while serving tiles (a failed request, a damaged
     * block). Reported as a {@link GeoTiffReadError} to read error listeners; the model recovers where it can.
     */
    | "READ_FAILED";

/**
 * Error thrown (or passed to `onError`) by {@link GeoTiffTileSetModel}.
 */
export class GeoTiffModelError extends Error {
    /** Machine readable reason, see {@link GeoTiffModelErrorCause}. */
    override readonly cause: GeoTiffModelErrorCause;
    /** For `UnknownIdentifier`: the reference identifier LuciadRIA does not know. */
    readonly identifier?: string;
    /** For `INVALIDELEVATION`: a description of the pixel layout that was found. */
    readonly pixelFormat?: string;
    /** The lower-level error (network, geotiff.js, ...), when there is one. */
    readonly originalError?: unknown;

    constructor(message: string, cause: GeoTiffModelErrorCause, details: { identifier?: string; pixelFormat?: string; error?: unknown } = {}) {
        super(message);
        this.name = "GeoTiffModelError";
        this.cause = cause;
        this.identifier = details.identifier;
        this.pixelFormat = details.pixelFormat;
        this.originalError = details.error;
    }
}

/**
 * What the model did after a {@link GeoTiffReadError}:
 * - `"finerImage"`: the data was read from a more detailed image (overview) of the same file instead;
 * - `"nodata"`: no image of the file could be read for that area, which is shown as no data.
 */
export type GeoTiffReadRecovery = "finerImage" | "nodata";

/**
 * A problem reading data from a file while serving tiles. The tile is still delivered (see `recovery`), so this is
 * reported to read error listeners (`model.addReadErrorListener` / `options.onReadError`) rather than thrown.
 * Each combination of file and image is reported once per model.
 */
export class GeoTiffReadError extends GeoTiffModelError {
    /** URL of the file, or `"file <index>"` when the file was not opened from a URL. */
    readonly url: string;
    /** Index of the file in the model (0 for single-file models; the order of the URLs for `createFromURLs`). */
    readonly fileIndex: number;
    /** The image that failed: 0 = full resolution, higher = coarser overviews. */
    readonly image: number;
    /** What the model did instead, see {@link GeoTiffReadRecovery}. */
    readonly recovery: GeoTiffReadRecovery;

    constructor(details: { url: string; fileIndex: number; image: number; recovery: GeoTiffReadRecovery; error: unknown }) {
        const reason = (details.error as Error)?.message ?? String(details.error);
        super(
            `Cannot read image ${details.image} of ${details.url} (${reason}); `
            + (details.recovery === "finerImage" ? "using a more detailed image instead" : "its area is shown as no data"),
            "READ_FAILED",
            {error: details.error},
        );
        this.name = "GeoTiffReadError";
        this.url = details.url;
        this.fileIndex = details.fileIndex;
        this.image = details.image;
        this.recovery = details.recovery;
    }
}

/** Receives {@link GeoTiffReadError}s. */
export type GeoTiffReadErrorListener = (error: GeoTiffReadError) => void;
