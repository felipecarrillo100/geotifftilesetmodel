/**
 * Is a GeoTIFF cloud optimized? A look at its header only (the TIFF directories), never at the image data: tiled
 * images, directories before the data, overviews for images larger than a tile, and GDAL's layout note.
 */
import type {HttpRequestOptions} from "@luciad/ria/util/HttpRequestOptions.js";
import {accessFetch} from "../http.js";
import {DEFAULT_SIGNERS} from "../stac/assets.js";
import type {IdentifySourceOptions} from "./identify.js";

/** Bytes requested (and read) to identify a source or probe a GeoTIFF: `bytes=0-65535`.
 *
 * @category Sources */
export const IDENTIFY_PROBE_BYTES = 65536;

/** Options of {@link probeCog}: the same HTTP options, signers, `rewriteUrl` and abort signal as {@link identifySource}.
 *
 * @category Sources */
export type ProbeCogOptions = IdentifySourceOptions;

/** What {@link probeCog} found in a GeoTIFF's header.
 *
 * @category Sources */
export interface CogProbe {
    /** True when every required check passes: `tiff`, `tiled`, `headerFirst`, and `overviews`. */
    isCog: boolean;
    /** The checks one by one. */
    checks: {
        /** A TIFF or BigTIFF signature (required). */
        tiff: boolean;
        /** The full-resolution image and its overviews are tiled, not stored in strips (required). */
        tiled: boolean;
        /**
         * Every directory (full resolution, overviews, masks) comes before the first tile data, so the header is read in
         * one go from the start of the file (required).
         */
        headerFirst: boolean;
        /** Overviews are present, or not needed: the image fits in one tile (required). */
        overviews: boolean;
        /**
         * GDAL's structural metadata (the "ghost area" after the TIFF header) declares the COG layout: `LAYOUT=COG`, or
         * `LAYOUT=IFDS_BEFORE_DATA` as GDAL's COG driver writes it. Informative only: other writers make valid COGs too.
         */
        gdalLayout: boolean;
    };
    /** One sentence per failed required check, for display; empty when `isCog`. */
    reasons: string[];
    /** Bytes read to decide (requests or Blob slices), never image data. */
    bytesRead: number;
    /** Width of the full-resolution image in pixels (0 when not a TIFF). */
    width: number;
    /** Height of the full-resolution image in pixels (0 when not a TIFF). */
    height: number;
    /** Tile width of the full-resolution image; undefined for strips. */
    tileWidth?: number;
    /** Tile height of the full-resolution image; undefined for strips. */
    tileHeight?: number;
    /** Number of overviews (reduced-resolution images, masks not counted). */
    overviewCount: number;
    /** True for BigTIFF. */
    bigTiff: boolean;
}

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

/** Largest second read, in bytes: directories spread beyond this are reported, not read. */
const MAX_SECOND_READ = 4 * 1024 * 1024;

interface Directory {
    offset: number;
    end: number;
    width: number;
    height: number;
    tileWidth?: number;
    tileHeight?: number;
    subfileType: number;
    /** Smallest non-zero offset of the image data (tiles or strips), when the offsets could be read. */
    firstData?: number;
}

const fail = (reason: string, bytesRead: number, bigTiff = false, tiff = false): CogProbe => ({
    isCog: false, checks: {tiff, tiled: false, headerFirst: false, overviews: false, gdalLayout: false}, reasons: [reason], bytesRead,
    width: 0, height: 0, overviewCount: 0, bigTiff,
});

/**
 * The COG analysis of a TIFF header, from a reader of byte ranges: the first {@link IDENTIFY_PROBE_BYTES} bytes,
 * then at most one more read when the directories continue beyond them.
 *
 * @internal
 *
 * @category Sources
 */
export async function analyzeCog(read: Reader): Promise<CogProbe> {
    const segments: { start: number; bytes: Uint8Array }[] = [];
    let bytesRead = 0;
    const load = async (offset: number, length: number) => {
        const bytes = await read(offset, length);
        bytesRead += bytes.length;
        segments.push({start: offset, bytes});
    };
    await load(0, IDENTIFY_PROBE_BYTES);
    const head = segments[0].bytes;
    if (!head.length) return fail("the file is empty", bytesRead);
    const little = head[0] === 0x49 && head[1] === 0x49;
    if (!little && !(head[0] === 0x4d && head[1] === 0x4d)) {
        const c = String.fromCharCode(head.find((b) => b > 0x20) ?? 0);
        return fail(c === "{" || c === "[" ? "not a TIFF file: JSON (identifySource tells what it is)"
            : c === "<" ? "not a TIFF file: an HTML or XML document" : "not a TIFF file (no TIFF signature)", bytesRead);
    }
    if (head.length < 8) return fail("too short to be a TIFF file", bytesRead);
    const view0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const magic = view0.getUint16(2, little);
    if (magic !== 42 && magic !== 43) return fail("not a TIFF file (no TIFF signature)", bytesRead);
    const big = magic === 43;
    if (big && head.length < 16) return fail("too short to be a BigTIFF file", bytesRead, true);

    // Bytes at an absolute offset, or null when not read.
    const at = (offset: number, length: number): DataView | null => {
        for (const s of segments) {
            if (offset >= s.start && offset + length <= s.start + s.bytes.length) {
                return new DataView(s.bytes.buffer, s.bytes.byteOffset + offset - s.start, length);
            }
        }
        return null;
    };
    const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, little));
    const first = big ? u64(view0, 8) : view0.getUint32(4, little);
    const entrySize = big ? 20 : 12;
    const countSize = big ? 8 : 2;
    const typeSize: Record<number, number> = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8};

    /** Walks the directory chain with the bytes read so far; `missing` lists ranges that would be needed. */
    const walk = () => {
        const dirs: Directory[] = [];
        const missing: [number, number][] = [];
        const seen = new Set<number>();
        let offset = first;
        while (offset && !seen.has(offset) && dirs.length < 256) {
            seen.add(offset);
            const countView = at(offset, countSize);
            if (!countView) { missing.push([offset, offset + 64 * 1024]); break; }
            const count = big ? u64(countView, 0) : countView.getUint16(0, little);
            const size = countSize + count * entrySize + (big ? 8 : 4);
            const body = at(offset, size);
            if (!body) { missing.push([offset, offset + size]); break; }
            const dir: Directory = {offset, end: offset + size, width: 0, height: 0, subfileType: 0};
            let dataOffsets: { type: number; count: number; pointer: number; inline: DataView | null } | null = null;
            for (let i = 0; i < count; i++) {
                const e = countSize + i * entrySize;
                const tagId = body.getUint16(e, little);
                const type = body.getUint16(e + 2, little);
                const n = big ? u64(body, e + 4) : body.getUint32(e + 4, little);
                const valueAt = e + (big ? 12 : 8);
                const width = (typeSize[type] ?? 1) * n;
                const inline = width <= (big ? 8 : 4);
                const scalar = () => (type === 3 ? body.getUint16(valueAt, little) : type === 16 ? u64(body, valueAt) : body.getUint32(valueAt, little));
                if (tagId === 256) dir.width = scalar();
                else if (tagId === 257) dir.height = scalar();
                else if (tagId === 322) dir.tileWidth = scalar();
                else if (tagId === 323) dir.tileHeight = scalar();
                else if (tagId === 254) dir.subfileType = scalar();
                else if (tagId === 324 || (tagId === 273 && !dataOffsets)) {
                    const pointer = inline ? 0 : big ? u64(body, valueAt) : body.getUint32(valueAt, little);
                    dataOffsets = {type, count: n, pointer, inline: inline ? new DataView(body.buffer, body.byteOffset + valueAt, big ? 8 : 4) : null};
                }
                if (!inline) {
                    const pointer = big ? u64(body, valueAt) : body.getUint32(valueAt, little);
                    // Values stored outside the entry (offset and byte count arrays, GeoKeys, ...) are header too.
                    dir.end = Math.max(dir.end, pointer + width);
                }
            }
            if (dataOffsets) {
                const size1 = typeSize[dataOffsets.type] ?? 4;
                const arr = dataOffsets.inline ?? at(dataOffsets.pointer, size1 * dataOffsets.count);
                if (!arr) missing.push([dataOffsets.pointer, dataOffsets.pointer + size1 * dataOffsets.count]);
                else {
                    let min = Infinity;
                    for (let k = 0; k < dataOffsets.count; k++) {
                        const v = size1 === 2 ? arr.getUint16(k * 2, little) : size1 === 8 ? u64(arr, k * 8) : arr.getUint32(k * 4, little);
                        if (v > 0 && v < min) min = v;
                    }
                    if (min < Infinity) dir.firstData = min;
                }
            }
            dirs.push(dir);
            const nextView = at(offset + countSize + count * entrySize, big ? 8 : 4);
            offset = nextView ? (big ? u64(nextView, 0) : nextView.getUint32(0, little)) : 0;
        }
        return {dirs, missing};
    };

    let {dirs, missing} = walk();
    let incomplete = false;
    if (missing.length) {
        // One more read, covering what the directories need beyond the first bytes (bounded).
        const from = Math.min(...missing.map((m) => m[0]));
        const to = Math.max(...missing.map((m) => m[1]));
        await load(from, Math.min(Math.max(to - from, 1), MAX_SECOND_READ));
        ({dirs, missing} = walk());
        incomplete = missing.length > 0;
    }

    const text = new TextDecoder("latin1").decode(head.subarray(big ? 16 : 8, Math.min(head.length, 2048)));
    const gdalLayout = /GDAL_STRUCTURAL_METADATA_SIZE=[\s\S]*LAYOUT=(COG|IFDS_BEFORE_DATA)\b/.test(text);
    if (!dirs.length) return {...fail("the TIFF directory cannot be read", bytesRead, big, true), checks: {tiff: true, tiled: false, headerFirst: false, overviews: false, gdalLayout}};

    const main = dirs[0];
    const isMask = (d: Directory) => (d.subfileType & 4) !== 0;
    const images = dirs.filter((d) => !isMask(d));
    const overviewCount = images.filter((d) => d !== main && (d.subfileType & 1) !== 0).length;
    const tiled = images.every((d) => d.tileWidth !== undefined && d.tileHeight !== undefined);
    const dataStarts = dirs.map((d) => d.firstData).filter((v): v is number => v !== undefined);
    const firstData = dataStarts.length ? Math.min(...dataStarts) : undefined;
    const lastHeader = Math.max(...dirs.map((d) => d.end));
    const headerFirst = !incomplete && firstData !== undefined && lastHeader <= firstData && first < firstData;
    const tw = main.tileWidth ?? main.width, th = main.tileHeight ?? main.height;
    const needsOverviews = main.width > tw || main.height > th;
    const overviews = !needsOverviews || overviewCount > 0;

    const reasons: string[] = [];
    if (!tiled) reasons.push("stored in strips, not tiles: every zoomed-out view reads most of the file");
    if (!headerFirst) {
        reasons.push(firstData !== undefined && first > firstData
            ? "the directory is at the end of the file: opening it needs a read at the end first"
            : incomplete
                ? `the directories are spread through the file (beyond the first ${Math.round(bytesRead / 1024)} KiB read): opening it needs several reads`
                : "directories (overviews or masks) come after image data: opening it needs several reads");
    }
    if (!overviews) reasons.push("no overviews: zoomed-out views read the full resolution");
    return {
        isCog: reasons.length === 0, checks: {tiff: true, tiled, headerFirst, overviews, gdalLayout}, reasons, bytesRead,
        width: main.width, height: main.height, ...(main.tileWidth !== undefined ? {tileWidth: main.tileWidth, tileHeight: main.tileHeight} : {}),
        overviewCount, bigTiff: big,
    };
}

/**
 * Checks whether a GeoTIFF is a Cloud Optimized GeoTIFF, by reading its header only: one range request (or `Blob`
 * slice) for the first {@link IDENTIFY_PROBE_BYTES} bytes, plus at most one more read when the directories continue
 * beyond them (up to 4 MiB). The image data is never read; {@link CogProbe.bytesRead} says how much was.
 *
 * A COG here is: a TIFF or BigTIFF (`tiff`), tiled (`tiled`, strips are not), with every directory before the image
 * data so the header is read in one go (`headerFirst`), and with overviews when the image is larger than one tile
 * (`overviews`). GDAL's layout note (`LAYOUT=COG` or `LAYOUT=IFDS_BEFORE_DATA`) is reported (`gdalLayout`) but never required: other writers make valid
 * COGs. The file name or extension is not a criterion: URLs often have none, signed URLs end in a query, and names
 * can be wrong. A file that is not a COG still opens with `GeoTiffTileSetModel.create`, but zoomed-out views read
 * more data; convert it with `gdal_translate -of COG in.tif out.tif`.
 *
 * The HTTP options are those of {@link identifySource}, with the same origin rules (kind `"source"` for the
 * `access` hook). `GeoTiffTileSetModel.infoFromURL(...).isCog` and `getModelInfo().isCog` use the same analysis.
 *
 * @param source The GeoTIFF: a URL (absolute, or relative to the page), or a `Blob` / `File`.
 * @param options HTTP options and an abort signal, see {@link ProbeCogOptions}.
 * @returns A promise of the checks. Something that is not a TIFF (JSON, HTML, an HTTP error, a network failure)
 *   gives `isCog: false` with the reason, not an error.
 * @throws `RangeError` (rejection) when `source` is not a non-empty string, a `URL` or a `Blob`, or is a relative URL
 *   outside a browser page.
 * @throws The abort reason (rejection) when `options.signal` aborts.
 * @example
 * ```ts
 * const url = ...;   // what the user typed
 * const probe = await probeCog(url);
 * if (!probe.isCog) console.warn(`Opens, but slowly: ${probe.reasons.join("; ")}`);
 * const model = await GeoTiffTileSetModel.create({url});
 * ```
 *
 * @category Sources
 */
export async function probeCog(source: string | URL | Blob, options: ProbeCogOptions = {}): Promise<CogProbe> {
    const signal = options.signal;
    if (typeof Blob !== "undefined" && source instanceof Blob) {
        return analyzeCog(async (offset, length) => {
            if (signal?.aborted) throw signal.reason;
            return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
        });
    }
    if (!(source instanceof URL) && (typeof source !== "string" || !source.trim())) throw new RangeError("probeCog needs a URL (string or URL) or a Blob");
    let url: string;
    try {
        url = new URL(String(source).trim(), typeof location !== "undefined" ? location.href : undefined).toString();
    } catch {
        throw new RangeError(`Not a URL: ${String(source)}`);
    }
    const {reader, failed} = urlReader(url, options);
    try {
        return await analyzeCog(reader);
    } catch (e) {
        if (failed(e)) return e as CogProbe;
        throw e;
    }
}

/**
 * Range reads of a URL with the options of {@link probeCog}; a failed request throws a {@link CogProbe} describing it
 * (`failed(e)` recognises it).
 *
 * @internal
 *
 * @category Sources
 */
export function urlReader(url: string, options: ProbeCogOptions): { reader: Reader; failed: (e: unknown) => boolean } {
    const signal = options.signal;
    const signer = (options.signers ?? DEFAULT_SIGNERS).find((s) => s.matches(url));
    let target: string | undefined;
    let failure: CogProbe | undefined;
    const reader: Reader = async (offset, length) => {
        // Asked per request, as for every input: the hook can renew a token.
        const access: HttpRequestOptions | null = options.access ? options.access(new URL(url), "source") : options;
        if (target === undefined) {
            const signed = signer ? await signer.sign(url) : url;
            target = options.rewriteUrl ? options.rewriteUrl(signed) : signed;
        }
        let response: Response;
        try {
            response = await accessFetch(target, access, {headers: {Range: `bytes=${offset}-${offset + length - 1}`}, signal}, fetch,
                {onRequest: options.onRequest, kind: "source", url});
        } catch (e) {
            if (signal?.aborted) throw signal.reason;
            failure = fail(e instanceof TypeError ? "the server does not allow this page to read it (CORS), or it is unreachable"
                : `the request failed: ${(e as Error).message}`, 0);
            throw failure;
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            const s = response.status;
            failure = fail(s === 401 || s === 403 ? `HTTP ${s}: the server refused access; the URL may need credentials or a signed URL`
                : s === 416 ? "the file is empty" : `HTTP ${s} from the server`, 0);
            throw failure;
        }
        // A server that ignores Range answers 200 with the whole file: keep only the bytes asked for.
        const skip = response.status === 206 ? 0 : offset;
        const bytes = await readRange(response, skip, length, signal);
        return bytes;
    };
    return {reader, failed: (e) => failure !== undefined && e === failure};
}

/** Reads `length` bytes after skipping `skip`, then cancels the rest of the body. */
async function readRange(response: Response, skip: number, length: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(skip, skip + length);
    const out = new Uint8Array(length);
    let pos = 0, filled = 0;
    while (filled < length) {
        if (signal?.aborted) { await reader.cancel().catch(() => undefined); throw signal.reason; }
        const {done, value} = await reader.read();
        if (done) return out.subarray(0, filled);
        const from = Math.max(0, skip - pos);
        if (from < value.length) {
            const part = value.subarray(from, from + length - filled);
            out.set(part, filled);
            filled += part.length;
        }
        pos += value.length;
    }
    await reader.cancel().catch(() => undefined);
    return out;
}
