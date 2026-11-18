import type {GeoTIFFImage} from "geotiff";

/**
 * A bounded cache of decoded file blocks for geotiff.js.
 *
 * geotiff.js can keep decoded blocks per image (`image.tiles`, enabled with `cache: true`) but never evicts them.
 * Models that serve tiles smaller than the file's blocks (Sentinel-2 uses 1024 x 1024 blocks) decode the same block
 * for several tiles; this cache keeps the most recently used `maxBlocks` decoded blocks across all images given to
 * {@link attach}, so a block is decoded once while its neighbourhood is being viewed.
 */
export class DecodedBlockCache {
    private readonly entries = new Map<string, unknown>();
    private nextId = 0;

    constructor(readonly maxBlocks = 96) {}

    /** Makes geotiff.js use this cache for an image's decoded blocks. */
    attach(image: GeoTIFFImage): void {
        const prefix = `${this.nextId++}/`;
        const entries = this.entries;
        const max = this.maxBlocks;
        // geotiff.js reads and writes `tiles[index]` (and tests `tiles === null`): a Proxy maps that onto the LRU.
        const tiles = new Proxy([] as unknown[], {
            get(target, property) {
                if (typeof property === "string" && /^\d+$/.test(property)) {
                    const key = prefix + property;
                    const value = entries.get(key);
                    if (value !== undefined) {
                        entries.delete(key);
                        entries.set(key, value);
                    }
                    return value;
                }
                return Reflect.get(target, property);
            },
            set(target, property, value) {
                if (typeof property === "string" && /^\d+$/.test(property)) {
                    const key = prefix + property;
                    entries.delete(key);
                    entries.set(key, value);
                    // Failed decodes must not stay cached.
                    Promise.resolve(value).catch(() => { if (entries.get(key) === value) entries.delete(key); });
                    while (entries.size > max) entries.delete(entries.keys().next().value!);
                    return true;
                }
                return Reflect.set(target, property, value);
            },
        });
        (image as unknown as { tiles: unknown }).tiles = tiles;
    }

    get size(): number {
        return this.entries.size;
    }

    clear(): void {
        this.entries.clear();
    }
}
