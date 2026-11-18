/**
 * The elevation tile encoding of LuciadFusion's LTS service, which LuciadRIA's terrain decodes natively:
 *
 * - a standard PNG, 16-bit grayscale (colour type 0), one sample per height;
 * - a private ancillary chunk `biNy` holding the ASCII tag `LuciadElev0` followed by two big-endian float64
 *   values `p` and `q`;
 * - `height = p + v * (q - p) / 65535` for a sample value `v`, and `v = 0` means "no data".
 *
 * LuciadFusion uses `q - p = 26213.6` (a 0.4 m step) whenever the tile's heights fit, and a wider range otherwise.
 * The lowest height of a tile is stored as `v = 1`.
 *
 * Tiles are built in the browser and never sent over the network, so the PNG data is stored uncompressed
 * (deflate "stored" blocks): encoding is a copy, and LuciadRIA decodes it like any other PNG.
 */

const TAG = [0x4c, 0x75, 0x63, 0x69, 0x61, 0x64, 0x45, 0x6c, 0x65, 0x76, 0x30]; // "LuciadElev0"
const DEFAULT_RANGE = 26213.6;
const MAX_VALUE = 65535;

/** Encoding parameters of a tile: `height = p + v * (q - p) / 65535`. */
export interface ElevationEncoding {
    p: number;
    q: number;
}

/**
 * Chooses `p` and `q` for heights between `min` and `max` as LuciadFusion does: a 0.4 m step when the range fits,
 * a wider step otherwise. The lowest height maps to 1 (0 is reserved for nodata).
 */
export function elevationEncoding(min: number, max: number): ElevationEncoding {
    let step = DEFAULT_RANGE / MAX_VALUE;
    let p = min - step;
    if (max - p > DEFAULT_RANGE) {
        step = (max - min) / (MAX_VALUE - 1);
        p = min - step;
    }
    return {p, q: p + MAX_VALUE * step};
}

/**
 * Encodes heights (row-major, row 0 = north) as a LuciadElev0 PNG. NaN heights become nodata (`v = 0`).
 */
export function encodeLuciadElevationPng(heights: Float32Array | Float64Array, width: number, height: number): ArrayBuffer {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h < min) min = h;
        if (h > max) max = h;
    }
    const {p, q} = min <= max ? elevationEncoding(min, max) : {p: 0, q: DEFAULT_RANGE};
    const scale = MAX_VALUE / (q - p);

    // Raw scanlines: filter byte 0 + big-endian 16-bit samples.
    const stride = 1 + width * 2;
    const raw = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        let o = y * stride + 1;
        for (let x = 0; x < width; x++) {
            const h = heights[y * width + x];
            const v = h === h ? Math.min(MAX_VALUE, Math.max(1, Math.round((h - p) * scale))) : 0; // h !== h: NaN
            raw[o++] = v >> 8;
            raw[o++] = v & 0xff;
        }
    }

    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr.set([16, 0, 0, 0, 0], 8); // bit depth 16, grayscale, deflate, adaptive filtering, no interlace

    const biny = new Uint8Array(TAG.length + 16);
    biny.set(TAG, 0);
    const binyView = new DataView(biny.buffer);
    binyView.setFloat64(TAG.length, p);
    binyView.setFloat64(TAG.length + 8, q);

    const chunks = [
        chunk("IHDR", ihdr),
        chunk("IDAT", zlibStored(raw)),
        chunk("biNy", biny),
        chunk("IEND", new Uint8Array(0)),
    ];
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const out = new Uint8Array(signature.length + chunks.reduce((n, c) => n + c.length, 0));
    out.set(signature, 0);
    let offset = signature.length;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out.buffer;
}

/** Reads the `LuciadElev0` parameters from a PNG, or null when it has none. */
export function readElevationEncoding(png: ArrayBuffer): ElevationEncoding | null {
    const view = new DataView(png);
    let i = 8;
    while (i + 8 <= view.byteLength) {
        const length = view.getUint32(i);
        const type = String.fromCharCode(view.getUint8(i + 4), view.getUint8(i + 5), view.getUint8(i + 6), view.getUint8(i + 7));
        if (type === "biNy" && length >= TAG.length + 16) {
            return {p: view.getFloat64(i + 8 + TAG.length), q: view.getFloat64(i + 8 + TAG.length + 8)};
        }
        i += 12 + length;
    }
    return null;
}

// ------------------------------------------------------------------------------------------------- PNG plumbing

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
}

/** zlib stream made of uncompressed ("stored") deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
    const blockSize = 65535;
    const blocks = Math.max(1, Math.ceil(data.length / blockSize));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    out[0] = 0x78; // deflate, 32 KiB window
    out[1] = 0x01; // no preset dictionary, fastest; (0x78 << 8 | 0x01) % 31 === 0
    let o = 2;
    for (let b = 0; b < blocks; b++) {
        const start = b * blockSize;
        const length = Math.min(blockSize, data.length - start);
        out[o++] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE = 00 (stored)
        out[o++] = length & 0xff;
        out[o++] = length >> 8;
        out[o++] = ~length & 0xff;
        out[o++] = (~length >> 8) & 0xff;
        out.set(data.subarray(start, start + length), o);
        o += length;
    }
    new DataView(out.buffer).setUint32(o, adler32(data));
    return out;
}

function adler32(data: Uint8Array): number {
    let a = 1, b = 0;
    for (let i = 0; i < data.length;) {
        const end = Math.min(i + 5552, data.length); // largest run without uint32 overflow
        for (; i < end; i++) {
            a += data[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array, start: number, end: number): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
