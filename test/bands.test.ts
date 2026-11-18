import {describe, expect, it, vi} from "vitest";
import {PixelFormat} from "@luciad/ria/model/tileset/PixelFormat.js";
import type {TileCoordinate} from "@luciad/ria/model/tileset/TileCoordinate.js";
import type {TileData} from "@luciad/ria/model/tileset/TileData.js";
import {
    buildRampLut, cssGradient, packRGBA, rampFromValues, resolveRamp, reverseRamp, sampleRamp,
} from "../src/rs/colormaps.js";
import {ramp, RAMPS} from "../src/rs/ramps.js";
import {STYLE_PRESETS} from "../src/rs/presets.js";
import {compileExpression, ExpressionError, formatExpression, parseExpression, toExpressionNode} from "../src/rs/expression.js";
import {
    compileStyle, computeStatistics, GeoTiffTileSetModel, percentile, resolveStretch,
    legendOf, StyleError, type BandStyle,
} from "../src/index.js";
import {addReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {openFixture} from "./helpers.js";

// UTM zone 33N is not built into LuciadRIA: register it as an application would.
addReference(parseWellKnownText(`PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],
UNIT["metre",1],AUTHORITY["EPSG","32633"]]`), "EPSG:32633");

const evaluate = (src: string, bands: Record<string, number[]>, mode: "compiled" | "vectorised" = "compiled") => {
    const names = Object.keys(bands);
    const n = names.length ? bands[names[0]].length : 1;
    const arrays = Object.fromEntries(names.map((k) => [k, Float32Array.from(bands[k])]));
    const out = new Float32Array(n);
    compileExpression(src, names, mode)(arrays, n, out);
    return Array.from(out);
};

describe("expressions", () => {
    it("follows the usual precedence and associativity", () => {
        expect(evaluate("1 + 2 * 3", {})).toEqual([7]);
        expect(evaluate("(1 + 2) * 3", {})).toEqual([9]);
        expect(evaluate("2 ^ 3 ^ 2", {})).toEqual([512]);  // right-associative
        expect(evaluate("2 ** 3", {})).toEqual([8]);
        expect(evaluate("-2 ^ 2", {})).toEqual([-4]);       // unary minus binds looser than ^
        expect(evaluate("10 - 4 - 3", {})).toEqual([3]);    // left-associative
        expect(evaluate("1 < 2 && 3 >= 3 || 0", {})).toEqual([1]);
        expect(evaluate("!(1 == 1)", {})).toEqual([0]);
    });

    it("computes NDVI over bands, with NaN where the result is not finite", () => {
        const bands = {nir: [0.5, 0.3, 0, NaN], red: [0.1, 0.3, 0, 0.2]};
        const expected = [(0.5 - 0.1) / 0.6, 0, NaN, NaN];
        for (const mode of ["compiled", "vectorised"] as const) {
            const out = evaluate("(nir - red) / (nir + red)", bands, mode);
            out.forEach((v, i) => (Number.isNaN(expected[i]) ? expect(v).toBeNaN() : expect(v).toBeCloseTo(expected[i], 6)));
        }
    });

    it("gives the same results compiled and vectorised", () => {
        const n = 500;
        let seed = 42;
        const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
        const rand = () => Array.from({length: n}, () => random() * 2 - 0.5);
        const bands = {a: rand(), b: rand(), c: rand()};
        for (const src of [
            "where(a > b, sqrt(abs(a)), log(abs(b) + 1))", "clamp(a * 3, -1, 1)", "mean(a, b, c) - min(a, b, c)",
            "pow(abs(c), 0.5) + atan2(a, b)", "2.5 * (a - b) / (a + 6 * b - 7.5 * c + 1)", "isnan(a / 0 * 0)",
        ]) {
            const compiled = evaluate(src, bands, "compiled");
            const vectorised = evaluate(src, bands, "vectorised");
            compiled.forEach((v, i) => (Number.isNaN(v)
                ? expect(vectorised[i]).toBeNaN()
                : expect(Math.abs(vectorised[i] - v)).toBeLessThan(1e-5 * Math.max(1, Math.abs(v)))));
        }
    });

    it("accepts JSON-array expressions", () => {
        const node = toExpressionNode(["/", ["-", ["band", "nir"], ["band", "red"]], ["+", "nir", "red"]]);
        expect(formatExpression(node)).toBe("((nir - red) / (nir + red))");
        expect(evaluate(JSON.stringify(["clamp", ["*", 2, "x"], 0, 1]), {x: [0.2, 0.9]})).toEqual([0.4000000059604645, 1]);
        expect(formatExpression(toExpressionNode(["band", 4]))).toBe("b4");
    });

    it("rejects anything that is not band math, with the position", () => {
        expect(() => parseExpression("alert(1)")).toThrow(/Unknown function "alert"/);
        expect(() => parseExpression("nir; fetch()")).toThrow(ExpressionError);
        expect(() => parseExpression("a.constructor")).toThrow(/character 2/);
        expect(() => parseExpression("(a + b")).toThrow(/Expected "\)"/);
        expect(() => parseExpression("clamp(a, 1)")).toThrow(/takes 3 argument/);
        expect(() => compileExpression("nir - swir", ["nir", "red"])).toThrow(/Unknown band "swir". Available: nir, red/);
        // Band names cannot smuggle code into the generated function.
        expect(() => compileExpression("x", ["x\"]; alert(1); //"])).toThrow(/Unknown band "x"/);
    });
});

describe("colour maps and statistics", () => {
    it("draws any ramp: custom positions, opacity in the colour, smooth or stepped", () => {
        const smooth = resolveRamp({stops: [{position: 0, color: "#000000"}, {position: 1, color: "rgba(255,255,255,0.5)"}]});
        const lut = buildRampLut(smooth);
        expect(lut[0]).toBe(packRGBA(0, 0, 0, 255));
        expect(lut[lut.length - 1]).toBe(packRGBA(255, 255, 255, 128));

        const stepped = resolveRamp({blend: "stepped", spacing: "custom", stops: [
            {position: 0.3, color: "#ff0000"}, {position: 0.6, color: "#00ff00"}, {position: 0.9, color: "#0000ff"}]});
        expect(stepped.stops[0].position).toBe(0);                     // the first interval starts at 0
        expect(sampleRamp(stepped, 0.1)).toMatchObject({r: 255, g: 0});
        expect(sampleRamp(stepped, 0.7)).toMatchObject({g: 255});
        expect(sampleRamp(stepped, 0.95)).toMatchObject({b: 255});
        expect(cssGradient({blend: "stepped", spacing: "equal", stops: [{position: 0, color: "#f00"}, {position: 0, color: "#00f"}]}))
            .toBe("linear-gradient(to right, #ff0000 0%, #ff0000 50%, #0000ff 50%, #0000ff 100%)");

        // Equal spacing ignores stored positions.
        expect(resolveRamp({spacing: "equal", stops: [0, 0, 0].map(() => ({position: 0.9, color: "#000"}))}).stops.map((s) => s.position))
            .toEqual([0, 0.5, 1]);
        expect(() => resolveRamp({stops: [{position: 0, color: "red"}, {position: 1, color: "#fff"}]})).toThrow(/stops\[0\].color/);
        expect(() => resolveRamp({stops: [{position: 0, color: "#000"}]})).toThrow(/at least two/);
        expect(() => resolveRamp({stops: [{position: 0, color: "#000"}, {position: 1.5, color: "#fff"}]})).toThrow(/0..1/);
    });

    it("helps build ramps: reverse, data-unit stops, ready-made copies", () => {
        const viridis = ramp("viridis");
        expect(viridis.preset).toBe("viridis");
        viridis.stops[0].color = "#123456";                            // a copy: editing it leaves the preset alone
        expect(RAMPS.viridis.stops[0].color).toBe("#440154");
        const reversed = reverseRamp(RAMPS.viridis);
        expect(resolveRamp(reversed).stops[0].css).toBe("#fde725");
        expect(reversed.reversed).toBe(true);
        const {ramp: fromValues, stretch} = rampFromValues([{value: -1, color: "#000"}, {value: 0, color: "#888"}, {value: 3, color: "#fff"}]);
        expect(stretch).toEqual([-1, 3]);
        expect(fromValues.stops.map((s) => s.position)).toEqual([0, 0.25, 1]);
    });

    it("computes histograms, percentiles and stretches, ignoring NaN", () => {
        const values = Float32Array.from([...Array.from({length: 1000}, (_, i) => i / 10), NaN, NaN]);
        const stats = computeStatistics(values)!;
        expect(stats.count).toBe(1000);
        expect(stats.min).toBe(0);
        expect(stats.max).toBeCloseTo(99.9, 4);
        expect(stats.mean).toBeCloseTo(49.95, 3);
        expect(percentile(stats, 2)).toBeCloseTo(2, 0);
        expect(percentile(stats, 98)).toBeCloseTo(97.9, 0);
        expect(resolveStretch({type: "stddev", n: 1}, stats).min).toBeCloseTo(49.95 - stats.std, 3);
        expect(resolveStretch([3, 4], stats)).toEqual({min: 3, max: 4, fromStatistics: false});
        expect(resolveStretch({type: "percentile"}, null)).toEqual({min: 0, max: 1, fromStatistics: false});
        expect(computeStatistics(Float32Array.of(NaN))).toBeNull();
    });
});

describe("render", () => {
    const px = (rgba: Uint8ClampedArray, i: number) => Array.from(rgba.subarray(i * 4, i * 4 + 4));

    it("renders RGB composites with per-channel stretch and gamma", () => {
        const style = compileStyle({render: {type: "rgb", red: "a", green: "b", blue: {band: "a", stretch: [0, 2]}, stretch: [0, 1]}}, ["a", "b"]);
        const rgba = style.render({a: Float32Array.of(0, 1, 0.5), b: Float32Array.of(1, 0, NaN)}, 3, []);
        expect(px(rgba, 0)).toEqual([0, 255, 0, 255]);
        expect(px(rgba, 1)).toEqual([255, 0, 128, 255]); // 1 of [0, 2] -> half of the range: 127.5, rounded
        expect(px(rgba, 2)).toEqual([0, 0, 0, 0]); // missing data is transparent
    });

    it("renders class tables, stepped ramps over the stretch, and masks", () => {
        const classes = compileStyle({render: {type: "pseudocolor", band: "c", colorMap: {type: "table", entries: [
            {value: 1, color: "#ff0000"}, {value: 2, color: "rgba(0,255,0,0.5)"}], default: "#0000ff"}}}, ["c"]);
        expect(classes.needsStatistics).toBe(false);
        const rgba = classes.render({c: Float32Array.of(1, 2, 3, NaN)}, 4, []);
        expect(px(rgba, 0)).toEqual([255, 0, 0, 255]);
        expect(px(rgba, 1)).toEqual([0, 255, 0, 128]);
        expect(px(rgba, 2)).toEqual([0, 0, 255, 255]);   // the table's default
        expect(px(rgba, 3)).toEqual([0, 0, 0, 0]);       // missing data

        // Class breaks in data units: a stepped ramp over a fixed stretch.
        const breaks = rampFromValues([{value: -10, color: "#0000ff"}, {value: 0, color: "#ff0000"}], {blend: "stepped", range: [-10, 10]});
        const stepped = compileStyle({render: {type: "pseudocolor", band: "v", stretch: breaks.stretch, colorMap: breaks.ramp},
            mask: [{band: "qa", bits: [3]}, {band: "v", range: [-5, 100]}]}, ["v", "qa"]);
        const out = stepped.render({v: Float32Array.of(-1, 5, 11, 5, -10), qa: Float32Array.of(0, 0, 0, 8, 0)}, 5, []);
        expect(px(out, 0)).toEqual([0, 0, 255, 255]);   // below 0
        expect(px(out, 1)).toEqual([255, 0, 0, 255]);   // from 0
        expect(px(out, 2)).toEqual([255, 0, 0, 255]);   // above the range: clamped to the last class
        expect(px(out, 3)[3]).toBe(0);                  // QA bit 3 set
        expect(px(out, 4)[3]).toBe(0);                  // outside the mask range
        expect(stepped.requiredBands.sort()).toEqual(["qa", "v"]);
        const legend = legendOf(stepped, []);
        expect(legend).toMatchObject({kind: "ramp", blend: "stepped", min: -10, max: 10});
        expect(legend.kind === "ramp" && legend.stops.map((s) => s.value)).toEqual([-10, 0]);
    });

    it("gives power users full control: colour functions and custom paint", () => {
        const fn = compileStyle({render: {type: "pseudocolor", band: "v", stretch: [0, 100],
            colorMap: (t, value) => (value > 50 ? [255, 0, 0] : [0, 0, Math.round(255 * t), 128])}}, ["v"]);
        const a = fn.render({v: Float32Array.of(0, 100, 49)}, 3, []);
        expect(px(a, 0)).toEqual([0, 0, 0, 128]);
        expect(px(a, 1)).toEqual([255, 0, 0, 255]);
        expect(px(a, 2)[2]).toBeGreaterThan(120);
        expect(legendOf(fn, [])).toEqual({kind: "custom", min: 0, max: 100, title: "v"});

        const custom = compileStyle({render: {type: "custom", sources: ["a", "a - b"], stretch: [0, 1],
            paint: ({values, n, ranges, out}) => {
                expect(ranges).toEqual([{min: 0, max: 1, fromStatistics: false}, {min: 0, max: 1, fromStatistics: false}]);
                for (let i = 0; i < n; i++) out.set([values[0][i] * 255, values[1][i] > 0 ? 255 : 0, 7, 255], i * 4);
            }}, mask: [{band: "b", values: [9]}]}, ["a", "b"]);
        const b = custom.render({a: Float32Array.of(1, 0.5), b: Float32Array.of(0.2, 9)}, 2, []);
        expect(px(b, 0)).toEqual([255, 255, 7, 255]);
        expect(px(b, 1)).toEqual([0, 0, 0, 0]);         // masked after paint
        expect(custom.requiredBands.sort()).toEqual(["a", "b"]);
    });

    it("reports invalid styles with the path of the property", () => {
        expect(() => compileStyle({render: {type: "rgb", red: "nir", green: "red", blue: "blue"}}, ["red", "blue"]))
            .toThrow(/render.red: unknown band "nir"/);
        expect(() => compileStyle({render: {type: "pseudocolor", expression: "nir -"}}, ["nir"])).toThrow(StyleError);
        expect(() => compileStyle({render: {type: "heatmap"}} as unknown as BandStyle, [])).toThrow(/render.type/);
        expect(() => compileStyle({render: {type: "pseudocolor", band: "a"}, mask: [{band: "a"}]}, ["a"])).toThrow(/mask\[0\]/);
        expect(() => compileStyle({render: {type: "pseudocolor", band: "a", colorMap: {stops: [{position: 0, color: "#000"}, {position: 1, color: "blue"}]}}}, ["a"]))
            .toThrow(/render.colorMap.stops\[1\].color: invalid colour "blue"/);
    });

    it("compiles every preset against Sentinel-2 and Landsat band names", () => {
        const s2 = ["coastal", "blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir09", "swir16", "swir22", "scl"];
        const landsat = ["coastal", "blue", "green", "red", "nir", "swir16", "swir22", "lwir", "qa_pixel"];
        for (const preset of STYLE_PRESETS) {
            const bands = [s2, landsat, ["landcover"]].find((set) => preset.requires.every((b) => set.includes(b)))!;
            expect(() => compileStyle(preset.style, bands), preset.id).not.toThrow();
        }
    });
});

function tile(model: GeoTiffTileSetModel, t: TileCoordinate): Promise<TileData> {
    return new Promise((resolve, reject) => model.getTileData(t, (_t, d) => resolve(d), (_t, e) => reject(e), null));
}

async function sentinelModel(style: BandStyle) {
    return GeoTiffTileSetModel.create({
        inputs: [
            {file: await openFixture("s2-red-10m.tif"), bands: "red"},
            {file: await openFixture("s2-nir-10m.tif"), bands: "nir"},
            {file: await openFixture("s2-scl-20m.tif"), bands: "scl", resampling: "nearest"},
        ],
        style, tileSize: 64, pool: null,
    });
}

describe("GeoTiffTileSetModel: bands, styles, statistics", () => {
    const ndvi: BandStyle = {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-1, 1], colorMap: RAMPS.rdylgn}};

    it("combines bands from separate files at different resolutions, with scale and offset applied", async () => {
        const model = await sentinelModel(ndvi);
        expect(model.getBandNames()).toEqual(["red", "nir", "scl"]);
        expect(model.levelCount).toBe(2);
        expect(model.getBands()[0]).toMatchObject({scale: 0.0001, offset: -0.1, resolution: 10});
        // Pixel (column 20, row 30): red DN 1200, NIR DN 3300; SCL pixel (10, 15) = 4.
        const values = (await model.getValuesAt(500000 + 205, 5000000 - 305))!;
        expect(values.bands.red).toBeCloseTo(1200 * 0.0001 - 0.1, 5);
        expect(values.bands.nir).toBeCloseTo(3300 * 0.0001 - 0.1, 5);
        expect(values.bands.scl).toBe(4);
        expect(values.sources["(nir - red) / (nir + red)"]).toBeCloseTo((0.23 - 0.02) / (0.23 + 0.02), 5);
        // East half: cloud class 9 (nearest resampling keeps classes intact).
        expect((await model.getValuesAt(500000 + 1001, 5000000 - 305))!.bands.scl).toBe(9);
        expect(await model.getValuesAt(0, 0)).toBeNull();
    });

    it("serves RGBA tiles, masks clouds with SCL and treats nodata as transparent", async () => {
        const model = await sentinelModel({...ndvi, mask: [{band: "scl", values: [8, 9, 10]}]});
        const west = new Uint8Array((await tile(model, {level: 1, x: 0, y: 1})).data as ArrayBuffer);
        const east = await tile(model, {level: 1, x: 1, y: 1});
        expect(east.pixelFormat).toBe(PixelFormat.RGBA_8888);
        expect(west[(10 * 64 + 10) * 4 + 3]).toBe(255);   // vegetation: visible
        expect(west[3]).toBe(0);                          // red nodata corner
        expect(new Uint8Array(east.data as ArrayBuffer).every((v, i) => i % 4 !== 3 || v === 0)).toBe(true); // all cloud
    });

    it("restyles from the decoded tile cache without reading again", async () => {
        const model = await sentinelModel(ndvi);
        await tile(model, {level: 1, x: 0, y: 1});
        const spy = vi.spyOn(model as unknown as { sampleBands: () => unknown }, "sampleBands");
        await model.setStyle({render: {type: "rgb", red: "nir", green: "red", blue: "red", stretch: [0, 0.5]}});
        await tile(model, {level: 1, x: 0, y: 1});
        expect(spy).not.toHaveBeenCalled();
        expect(model.getPerformance().cacheHits).toBe(1);
    });

    it("makes twins with another style that share the decoded tiles", async () => {
        const model = await sentinelModel(ndvi);
        await tile(model, {level: 1, x: 0, y: 1});
        const twin = await model.withStyle({render: {type: "rgb", red: "nir", green: "red", blue: "red", stretch: [0, 0.5]}});
        const spy = vi.spyOn(twin as unknown as { sampleBands: () => unknown }, "sampleBands");
        await tile(twin, {level: 1, x: 0, y: 1});
        expect(spy).not.toHaveBeenCalled();
        expect(model.getStyle()!.render.type).toBe("pseudocolor");
        expect(twin.getStyle()!.render.type).toBe("rgb");
    });

    it("computes statistics for percentile stretches, without masked pixels, for the whole image or a region", async () => {
        const model = await sentinelModel({render: {type: "pseudocolor", band: "red", colorMap: RAMPS.greys}});
        const [stats] = model.getStatistics();
        // red reflectance = 0.0 + 0.001 * column (0 .. 0.127) minus the nodata corner.
        expect(stats!.min).toBeCloseTo(0.0, 2);
        expect(stats!.max).toBeCloseTo(0.127, 2);
        const [{min, max}] = model.getResolvedStretches();
        expect(min).toBeCloseTo(0.0025, 2);
        expect(max).toBeCloseTo(0.1245, 2);

        await model.setStyle({render: {type: "pseudocolor", band: "red", colorMap: RAMPS.greys}, mask: [{band: "scl", values: [9]}]});
        expect(model.getStatistics()[0]!.max).toBeLessThan(0.065);  // the cloudy east half is left out

        await model.setStyle({render: {type: "pseudocolor", band: "nir", stretch: [0, 1]}});
        expect(model.getStatistics()).toEqual([null]);              // a fixed stretch needs none
        expect((await model.requestStatistics())[0]!.max).toBeCloseTo(0.327, 2);  // but a UI may ask (DN 4270)

        await model.setStyle({render: {type: "pseudocolor", band: "red", colorMap: RAMPS.greys}});
        const [region] = await model.computeStatistics([500000, 5000000 - 1280, 500000 + 320, 5000000]);
        expect(region!.max).toBeLessThan(0.033);
    });

    it("never draws with a fallback stretch while statistics are computed (regression: white tiles)", async () => {
        const model = await sentinelModel({render: {type: "pseudocolor", band: "red", colorMap: RAMPS.greys}});
        const at = {level: 1, x: 1, y: 1};
        const before = new Uint8Array((await tile(model, at)).data as ArrayBuffer).slice();
        model.clearCache();
        // A region change racing tile requests (a slow server): the statistics read is held open while a tile
        // renders, which must keep the current statistics.
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const internals = model as unknown as { sampleBands: (...a: unknown[]) => Promise<unknown> };
        const original = internals.sampleBands.bind(model);
        let first = true;
        vi.spyOn(internals, "sampleBands").mockImplementation(async (...a: unknown[]) => {
            if (first) { first = false; await gate; }
            return original(...a);
        });
        const region = model.computeStatistics([500000, 5000000 - 320, 500000 + 320, 5000000]);
        const during = new Uint8Array((await tile(model, at)).data as ArrayBuffer);
        expect(Array.from(during)).toEqual(Array.from(before));
        release();
        await region;
        vi.restoreAllMocks();
        const after = new Uint8Array((await tile(model, at)).data as ArrayBuffer);
        expect(Array.from(after)).not.toEqual(Array.from(before));   // the new, regional stretch

        const restyle = model.setStyle({render: {type: "pseudocolor", band: "nir", colorMap: RAMPS.greys}});
        expect(model.getStyle()!.render).toMatchObject({band: "red"});  // applied once its statistics exist
        await restyle;
        expect(model.getStyle()!.render).toMatchObject({band: "nir"});
        expect(model.getStatistics()[0]).not.toBeNull();
    });

    it("names bands from GDAL descriptions, for time series", async () => {
        const model = await GeoTiffTileSetModel.create({
            inputs: [{file: await openFixture("monthly-4326-float32.tif")}],
            style: {render: {type: "pseudocolor", expression: "Jul - Jan", stretch: [0, 10], colorMap: RAMPS.coolwarm}},
            pool: null,
        });
        expect(model.getBandNames()).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
        const v = (await model.getValuesAt(10.05, 49.95))!;
        expect(v.bands.Jul).toBeCloseTo(7, 5);
        expect(v.sources["Jul - Jan"]).toBeCloseTo(6, 5);
    });

    it("names bands once, by location, at creation; only those bands exist", async () => {
        const tiff = await openFixture("monthly-4326-float32.tif");
        const model = await GeoTiffTileSetModel.create({
            inputs: [{file: tiff}], bands: {winter: "b1", summer: "b7"}, pool: null,
            style: {render: {type: "pseudocolor", expression: "summer - winter", stretch: [0, 10]}},
        });
        expect(model.getBandNames()).toEqual(["winter", "summer"]);
        expect(model.getBands().map((b) => b.sample)).toEqual([0, 6]);
        expect((await model.getValuesAt(10.05, 49.95))!.sources["summer - winter"]).toBeCloseTo(6, 5);

        const two = await GeoTiffTileSetModel.create({
            inputs: [{file: await openFixture("s2-red-10m.tif")}, {file: await openFixture("s2-nir-10m.tif")}],
            bands: {red: "f1_b1", nir: "f2_b1"}, pool: null,
            style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-1, 1]}},
        });
        expect(two.getBands().map((b) => [b.name, b.input, b.sample])).toEqual([["red", 0, 0], ["nir", 1, 0]]);

        const fail = async (bands: Record<string, string>) => GeoTiffTileSetModel.create({
            inputs: [{file: await openFixture("s2-red-10m.tif")}, {file: await openFixture("s2-nir-10m.tif")}], bands, pool: null,
            style: {render: {type: "pseudocolor", band: Object.keys(bands)[0]}},
        });
        await expect(fail({red: "b1"})).rejects.toThrow(/ambiguous with 2 inputs/);
        await expect(fail({red: "f3_b1"})).rejects.toThrow(/no input 3/);
        await expect(fail({red: "f1_b2"})).rejects.toThrow(/has 1 band\(s\), not 2/);
        await expect(fail({red: "band one"})).rejects.toThrow(/not a band reference/);
    });

        it("rejects inputs in different references", async () => {
        await expect(GeoTiffTileSetModel.create({
            inputs: [{file: await openFixture("s2-red-10m.tif"), bands: "red"}, {file: await openFixture("monthly-4326-float32.tif")}],
            style: ndvi, pool: null,
        })).rejects.toMatchObject({cause: "REFERENCE_MISMATCH"});
    });
});

describe("fixes", () => {
    it("leaves infinite values out of statistics", () => {
        const stats = computeStatistics(Float32Array.of(1, 2, Infinity, -Infinity, NaN, 3))!;
        expect([stats.count, stats.min, stats.max, stats.mean]).toEqual([3, 1, 3, 2]);
        expect(computeStatistics(Float32Array.of(Infinity))).toBeNull();
    });

    it("rejects unknown ramp names instead of returning undefined", () => {
        expect(() => ramp("nope" as never)).toThrow(RangeError);
    });

    it("reports invalid JSON expressions as ExpressionError", () => {
        expect(() => toExpressionNode("[\"+\", 1,")).toThrow(ExpressionError);
        expect(() => toExpressionNode([1, 2] as never)).toThrow(ExpressionError);
        expect(() => compileStyle({render: {type: "pseudocolor", expression: "[1, 2]"}}, ["a"])).toThrow(StyleError);
    });

    it("samples a ramp at +Infinity as its end, at -Infinity and NaN as its start", () => {
        const r = resolveRamp({stops: [{position: 0, color: "#000000"}, {position: 1, color: "#ffffff"}]});
        expect(sampleRamp(r, Infinity)).toMatchObject({r: 255});
        expect(sampleRamp(r, -Infinity)).toMatchObject({r: 0});
        expect(sampleRamp(r, NaN)).toMatchObject({r: 0});
    });

    it("rounds to the nearest ramp entry (regression: truncation)", () => {
        // A colour function that writes the entry number: 1024 entries over a stretch of 0..1023.
        const entry = (t: number): [number, number, number] => { const k = Math.round(t * 1023); return [k % 256, Math.floor(k / 256), 0]; };
        const style = compileStyle({render: {type: "pseudocolor", band: "v", stretch: [0, 1023], colorMap: entry}}, ["v"]);
        const rgba = style.render({v: Float32Array.of(5.9, 5.4, 1022.6)}, 3, []);
        const k = (i: number) => rgba[i * 4] + 256 * rgba[i * 4 + 1];
        expect([k(0), k(1), k(2)]).toEqual([6, 5, 1023]);
    });

    it("draws 8-bit RGB through the fast path with the pixels of the general path", async () => {
        const rgb = {render: {type: "rgb" as const, red: "b1", green: "b2", blue: "b3", stretch: [0, 255] as [number, number]}};
        const fast = await GeoTiffTileSetModel.create({file: await openFixture("rgb-3857-uint8.tif"), tileSize: 64, pool: null, style: rgb});
        // A mask that hides nothing takes the general path (resampling, the decoded tile cache).
        const general = await fast.withStyle({...rgb, mask: [{band: "b1", range: [-1, 1000]}]});
        for (const t of [{level: 1, x: 1, y: 1}, {level: 1, x: 0, y: 0}, {level: 0, x: 0, y: 0}]) {
            expect(Array.from(new Uint8Array((await tile(fast, t)).data as ArrayBuffer)))
                .toEqual(Array.from(new Uint8Array((await tile(general, t)).data as ArrayBuffer)));
        }
        expect(fast.getPerformance().cacheBytes).toBeGreaterThan(0);   // filled by the general twin only
    });
});
