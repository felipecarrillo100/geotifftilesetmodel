import {readFileSync} from "node:fs";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {inflateSync} from "node:zlib";
import {expect} from "vitest";
import {fromArrayBuffer, type GeoTIFF} from "geotiff";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {TileData} from "@luciad/ria/model/tileset/TileData.js";
import type {GeoTiffTileSetModel} from "../src/index.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixtureBytes(name: string): ArrayBuffer {
    const buf = readFileSync(join(FIXTURES, name));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function openFixture(name: string): Promise<GeoTIFF> {
    return fromArrayBuffer(fixtureBytes(name));
}

/** Promise wrapper around the callback style getTileData. */
export function tileData(model: GeoTiffTileSetModel, tile: TileCoordinate): Promise<TileData> {
    return new Promise((resolve, reject) => {
        model.getTileData(tile, (_t, data) => resolve(data), (_t, error) => reject(error), null);
    });
}

/**
 * Decodes a LuciadElev0 elevation PNG with a standard inflater (node:zlib), independently of the library's encoder,
 * checking every chunk CRC. Returns heights (row 0 = north) with NaN for nodata.
 */
export function decodeElevationPng(png: ArrayBuffer): { width: number; height: number; p: number; q: number; heights: Float64Array } {
    const bytes = new Uint8Array(png);
    const view = new DataView(png);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let i = 8, width = 0, height = 0, p = NaN, q = NaN;
    const idat: Uint8Array[] = [];
    const types: string[] = [];
    while (i < bytes.length) {
        const length = view.getUint32(i);
        const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
        types.push(type);
        expect(view.getUint32(i + 8 + length)).toBe(crc32(bytes.subarray(i + 4, i + 8 + length)));
        const body = bytes.subarray(i + 8, i + 8 + length);
        if (type === "IHDR") {
            width = view.getUint32(i + 8);
            height = view.getUint32(i + 12);
            expect([body[8], body[9], body[12]]).toEqual([16, 0, 0]); // 16-bit grayscale, not interlaced
        } else if (type === "IDAT") {
            idat.push(body);
        } else if (type === "biNy") {
            expect(String.fromCharCode(...body.subarray(0, 11))).toBe("LuciadElev0");
            p = view.getFloat64(i + 8 + 11);
            q = view.getFloat64(i + 8 + 19);
        }
        i += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "biNy", "IEND"]);
    const raw = inflateSync(Buffer.concat(idat));
    const stride = 1 + 2 * width;
    expect(raw.length).toBe(stride * height);
    const heights = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
        expect(raw[y * stride]).toBe(0); // filter type None
        for (let x = 0; x < width; x++) {
            const v = raw.readUInt16BE(y * stride + 1 + 2 * x);
            heights[y * width + x] = v === 0 ? NaN : p + (v * (q - p)) / 65535;
        }
    }
    return {width, height, p, q, heights};
}

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Heights of an elevation tile as delivered to LuciadRIA. */
export async function tileHeights(model: GeoTiffTileSetModel, tile: TileCoordinate): Promise<Float64Array> {
    const data = await tileData(model, tile);
    expect(data.mimeType).toBe("image/png");
    return decodeElevationPng(data.data as ArrayBuffer).heights;
}

/** Height quantisation of the LuciadElev0 encoding (0.4 m step): decoded heights are within half a step. */
export const QUANTISATION = 26213.6 / 65535 / 2 + 1e-6;

/** The analytic surface written by make-fixtures.py for elevation-3857-float32.tif. */
export const PLANE_ORIGIN = {x: 1000000, y: 6000000};
export function plane(x: number, y: number): number {
    return 100 + 0.01 * (x - PLANE_ORIGIN.x) - 0.02 * (y - PLANE_ORIGIN.y);
}

export interface RecordedRequest {
    url: string;
    range?: string;
    headers: Record<string, string | string[] | undefined>;
}

/** Minimal static server with HTTP Range support, recording the requests it receives. */
export async function startRangeServer(): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
    const requests: RecordedRequest[] = [];
    const server: Server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        requests.push({url: req.url ?? "", range: req.headers.range, headers: req.headers});
        let body: Buffer;
        try {
            body = readFileSync(join(FIXTURES, decodeURIComponent(path)));
        } catch {
            res.writeHead(404).end();
            return;
        }
        const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        if (match) {
            const start = Number(match[1]);
            const end = Math.min(match[2] ? Number(match[2]) : body.length - 1, body.length - 1);
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${body.length}`,
                "Content-Length": end - start + 1,
                "Accept-Ranges": "bytes",
            });
            res.end(body.subarray(start, end + 1));
        } else {
            res.writeHead(200, {"Content-Length": body.length, "Accept-Ranges": "bytes"});
            res.end(body);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const {port} = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
