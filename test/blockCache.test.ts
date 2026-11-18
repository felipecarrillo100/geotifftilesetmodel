import {describe, expect, it} from "vitest";
import {DecodedBlockCache} from "../src/blockCache.js";
import {openFixture} from "./helpers.js";

describe("DecodedBlockCache", () => {
    it("keeps the most recently used decoded blocks across images and evicts the oldest", () => {
        const cache = new DecodedBlockCache(2);
        const a = {} as never, b = {} as never;
        cache.attach(a);
        cache.attach(b);
        const tiles = (image: unknown) => (image as { tiles: unknown[] }).tiles;
        tiles(a)[0] = "a0";
        tiles(b)[0] = "b0";
        expect(tiles(a)[0]).toBe("a0");   // touch: a0 is now the most recent
        tiles(a)[5] = "a5";               // evicts b0
        expect(tiles(b)[0]).toBeUndefined();
        expect(tiles(a)[0]).toBe("a0");
        expect(tiles(a)[5]).toBe("a5");
        expect(tiles(a) === null).toBe(false);
        expect(cache.size).toBe(2);
    });

    it("is used by geotiff.js: a block is decoded once for repeated reads", async () => {
        const tiff = await openFixture("s2-red-10m.tif");
        const image = await tiff.getImage(0);
        const cache = new DecodedBlockCache(8);
        cache.attach(image);
        const first = await image.readRasters({window: [0, 0, 10, 10]});
        expect(cache.size).toBe(1);
        const again = await image.readRasters({window: [5, 5, 20, 20]});
        expect(cache.size).toBe(1);
        expect((first[0] as Uint16Array)[5 * 10 + 5]).toBe((again[0] as Uint16Array)[0]); // pixel (5, 5)
    });
});
