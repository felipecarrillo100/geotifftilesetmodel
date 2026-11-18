/**
 * Reason codes carried by {@link GeoTiffModelError.cause}.
 *
 * The string values are part of the public API: applications test them with `error.cause === "..."`.
 *
 * @category Errors
 */
export type GeoTiffModelErrorCause =
    /**
     * The file could not be fetched or is not a TIFF: a network or CORS error, an HTTP error status, a redirect to
     * another origin that was refused, or bytes geotiff.js cannot parse. `originalError` holds the lower-level
     * error.
     */
    | "ERROR_LOADING_FILE"
    /**
     * The coordinate reference of the GeoTIFF is not known to LuciadRIA.
     * `error.identifier` holds the identifier (for example `"EPSG:25832"`): load its definition with
     * `addReference` / `parseWellKnownText` and try again, or pass `options.reference`.
     */
    | "UnknownIdentifier"
    /**
     * The GeoTIFF has no georeferencing, or declares no EPSG reference, and no `options.reference` was given.
     */
    | "BoundsMissing"
    /** Elevation was requested for data that cannot represent elevation (for example RGB imagery). */
    | "INVALIDELEVATION"
    /**
     * Data of an already opened file could not be read or decoded while serving tiles (a failed request, a damaged
     * block). Reported as a {@link GeoTiffReadError} to read error listeners; the model recovers where it can.
     */
    | "READ_FAILED"
    /**
     * The inputs of a {@link GeoTiffTileSetModel} declare different coordinate references (and no
     * `options.reference` was given).
     */
    | "REFERENCE_MISMATCH";

/**
 * One problem found in what the application passed: a manifest, a STAC selection, a style.
 *
 * Every error of this library carries a list of these in {@link RiaGeoTiffError.problems}, so a user interface shows
 * them all the same way.
 *
 * @category Errors
 */
export interface RiaGeoTiffProblem {
    /**
     * Where the problem is, as a JSON path into what was passed: `"inputs[0].url"` (manifest), `"datetime"` or
     * `"where.eo:cloud_cover"` (STAC selection), `"render.red"` (style); `""` for the whole value.
     */
    path: string;
    /** `"error"`: it cannot work as given; `"warning"`: it works, but perhaps not as expected. */
    severity: "error" | "warning";
    /** What is wrong, in English, for display. */
    message: string;
}

/**
 * The base class of every error this library throws or rejects with: {@link GeoTiffModelError} (and
 * {@link GeoTiffReadError}), `StacError` (from `ria-geotiff/stac`), `ManifestError`, `StyleError`,
 * `ColorMapError` and `ExpressionError`. Built-in errors (`RangeError` for invalid options, the
 * signal's reason when a request is aborted) are not of this class.
 *
 * One shape for display and logging: `message`, `name` (the class), {@link RiaGeoTiffError.problems} (possibly
 * empty) and {@link RiaGeoTiffError.details} (the fields of the subclass, such as `status`, `url`, `cause` or
 * `path`). `JSON.stringify(error)` gives all of it, see {@link RiaGeoTiffError.toJSON}.
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;          // your LuciadRIA WebGLMap
 * const url = ...;          // what the user typed
 * const errorBox = ...;     // an element of your page
 * try {
 *     const model = await GeoTiffTileSetModel.create({url});
 *     map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
 * } catch (e) {
 *     if (!(e instanceof RiaGeoTiffError)) throw e;
 *     errorBox.textContent = [e.message, ...e.problems.map((p) => `${p.severity} ${p.path}: ${p.message}`)].join("\n");
 *     console.table(e.details());
 * }
 * ```
 *
 * @category Errors
 */
export class RiaGeoTiffError extends Error {
    /** The problems one by one (path, severity, message); empty when the error is not about a value passed. */
    readonly problems: RiaGeoTiffProblem[];

    /**
     * Creates an error. Applications normally only catch these errors; the library creates them.
     *
     * @param message human readable description, available as `error.message`
     * @param problems the problems one by one; default none
     */
    constructor(message: string, problems: RiaGeoTiffProblem[] = []) {
        super(message);
        this.name = "RiaGeoTiffError";
        this.problems = problems;
    }

    /**
     * The fields of the subclass that are set, for display: for example `{status: 404, url: "..."}` for a
     * `StacError`, `{cause: "UnknownIdentifier", identifier: "EPSG:25832"}` for a {@link GeoTiffModelError},
     * `{path: "render.red"}` for a `StyleError`. A lower-level error (`originalError`) is given as its message.
     * `name`, `message`, `stack` and `problems` are not included.
     *
     * @returns a new object with every field that is not undefined
     */
    details(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(this)) {
            if (value === undefined || key === "name" || key === "message" || key === "stack" || key === "problems") continue;
            out[key] = value instanceof Error ? value.message : value;
        }
        return out;
    }

    /**
     * The error as JSON, for logs: `JSON.stringify(error)` calls it.
     *
     * @returns `{name, message, problems, ...details()}`
     */
    toJSON(): Record<string, unknown> {
        return {name: this.name, message: this.message, problems: this.problems, ...this.details()};
    }
}

/**
 * Error with which {@link GeoTiffTileSetModel.create} and {@link GeoTiffTileSetModel.infoFromURL} reject when a
 * file cannot be used.
 *
 * Test {@link GeoTiffModelError.cause} to react to a specific problem.
 *
 * @example
 * ```ts
 * import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
 *
 * const map = ...;                         // your LuciadRIA WebGLMap
 * const url = ...;                         // URL of a COG, provided by the application
 * try {
 *   const model = await GeoTiffTileSetModel.create({url});
 *   map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
 * } catch (error) {
 *   if (error instanceof GeoTiffModelError && error.cause === "UnknownIdentifier") {
 *     console.log(`Load the definition of ${error.identifier} first`);
 *   }
 * }
 * ```
 *
 * @category Errors
 */
export class GeoTiffModelError extends RiaGeoTiffError {
    /** Machine readable reason, see {@link GeoTiffModelErrorCause}. */
    override readonly cause: GeoTiffModelErrorCause;
    /** For `UnknownIdentifier`: the reference identifier LuciadRIA does not know. */
    readonly identifier?: string;
    /** For `INVALIDELEVATION`: a description of the pixel layout that was found. */
    readonly pixelFormat?: string;
    /** The lower-level error (network, geotiff.js, ...), when there is one. */
    readonly originalError?: unknown;

    /**
     * Creates an error. Applications normally only catch these errors; the library creates them.
     *
     * @param message human readable description, available as `error.message`
     * @param cause machine readable reason, see {@link GeoTiffModelErrorCause}
     * @param details optional extra information: `identifier` (for `UnknownIdentifier`), `pixelFormat` (for
     *   `INVALIDELEVATION`) and `error`, the lower-level error, stored as {@link GeoTiffModelError.originalError}
     */
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
 *
 * @category Errors
 */
export type GeoTiffReadRecovery = "finerImage" | "nodata";

/**
 * A problem reading data from a file while serving tiles. The tile is still delivered (see `recovery`), so this is
 * reported to read error listeners (`model.addReadErrorListener` / `options.onReadError`) rather than thrown.
 * Each combination of file and image is reported once per model.
 *
 * @category Errors
 */
export class GeoTiffReadError extends GeoTiffModelError {
    /** URL of the file, or `"file <index>"` when the file was not opened from a URL. */
    readonly url: string;
    /** Index of the file in the model (0 for single-file models; the order of the inputs for `GeoTiffTileSetModel.create`). */
    readonly fileIndex: number;
    /** The image that failed: 0 = full resolution, higher = coarser overviews. */
    readonly image: number;
    /** What the model did instead, see {@link GeoTiffReadRecovery}. */
    readonly recovery: GeoTiffReadRecovery;

    /**
     * Creates a read error with cause `READ_FAILED` and a message naming the file, the image and the recovery.
     * Applications normally only receive these errors in read error listeners; the library creates them.
     *
     * @param details what failed: `url` (or `"file <index>"`), `fileIndex`, `image` (0 = full resolution),
     *   `recovery` (see {@link GeoTiffReadRecovery}) and `error`, the lower-level error, stored as
     *   {@link GeoTiffModelError.originalError}
     */
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

/**
 * Receives {@link GeoTiffReadError}s, see `addReadErrorListener` of {@link GeoTiffTileSetModel} and its
 * `onReadError` option. Errors thrown by a listener are caught and logged with `console.error`.
 *
 * @category Errors
 */
export type GeoTiffReadErrorListener = (error: GeoTiffReadError) => void;
