/**
 * Optional ready-made ramps, imported from `ria-geotiff/ramps`. Plain data: copy one into a style, edit it, or
 * ignore this module and use your own (MapEvolution's ramp presets are the same format). Nothing in the library
 * refers to these by name.
 *
 * Colours follow the published definitions (matplotlib, ColorBrewer, Sentinel Hub), sampled as evenly spaced stops.
 *
 * ```ts
 * import {ramp} from "ria-geotiff/ramps";
 * const style = {render: {type: "pseudocolor", band: "elevation", stretch: {type: "minmax"}, colorMap: ramp("terrain")}};
 * ```
 *
 * @module ria-geotiff/ramps
 */
import {rampFromColors, rampFromValues, type ColorTableJSON, type RampJSON} from "./colormaps.js";

const h = (s: string) => s.split(" ");

const COLORS = {
    viridis: h("#440154 #482878 #3e4989 #31688e #26828e #1f9e89 #35b779 #6ece58 #b5de2b #fde725"),
    magma: h("#000004 #140e36 #3b0f70 #641a80 #8c2981 #b73779 #de4968 #f7705c #fe9f6d #fecf92 #fcfdbf"),
    inferno: h("#000004 #160b39 #420a68 #6a176e #932667 #bc3754 #dd513a #f37819 #fca50a #f6d746 #fcffa4"),
    plasma: h("#0d0887 #41049d #6a00a8 #8f0da4 #b12a90 #cc4778 #e16462 #f2844b #fca636 #fcce25 #f0f921"),
    cividis: h("#00224e #123570 #3b496c #575d6d #707173 #8a8678 #a59c74 #c3b369 #e1cc55 #fee838"),
    turbo: h("#30123b #4145ab #4675ed #39a2fc #1bcfd4 #24eca6 #61fc6c #a4fc3b #d1e834 #f3c63a #fe9b2d #f36315 #d93806 #b11901 #7a0403"),
    spectral: h("#9e0142 #d53e4f #f46d43 #fdae61 #fee08b #ffffbf #e6f598 #abdda4 #66c2a5 #3288bd #5e4fa2"),
    rdylgn: h("#a50026 #d73027 #f46d43 #fdae61 #fee08b #ffffbf #d9ef8b #a6d96a #66bd63 #1a9850 #006837"),
    rdylbu: h("#a50026 #d73027 #f46d43 #fdae61 #fee090 #ffffbf #e0f3f8 #abd9e9 #74add1 #4575b4 #313695"),
    rdbu: h("#67001f #b2182b #d6604d #f4a582 #fddbc7 #f7f7f7 #d1e5f0 #92c5de #4393c3 #2166ac #053061"),
    brbg: h("#543005 #8c510a #bf812d #dfc27d #f6e8c3 #f5f5f5 #c7eae5 #80cdc1 #35978f #01665e #003c30"),
    piyg: h("#8e0152 #c51b7d #de77ae #f1b6da #fde0ef #f7f7f7 #e6f5d0 #b8e186 #7fbc41 #4d9221 #276419"),
    coolwarm: h("#3b4cc0 #5a78e4 #7b9ff9 #9ebeff #c0d4f5 #dddcdc #f2cbb7 #f7ac8e #ee8468 #d65244 #b40426"),
    blues: h("#f7fbff #deebf7 #c6dbef #9ecae1 #6baed6 #4292c6 #2171b5 #08519c #08306b"),
    greens: h("#f7fcf5 #e5f5e0 #c7e9c0 #a1d99b #74c476 #41ab5d #238b45 #006d2c #00441b"),
    reds: h("#fff5f0 #fee0d2 #fcbba1 #fc9272 #fb6a4a #ef3b2c #cb181d #a50f15 #67000d"),
    oranges: h("#fff5eb #fee6ce #fdd0a2 #fdae6b #fd8d3c #f16913 #d94801 #a63603 #7f2704"),
    purples: h("#fcfbfd #efedf5 #dadaeb #bcbddc #9e9ac8 #807dba #6a51a3 #54278f #3f007d"),
    greys: h("#000000 #252525 #525252 #737373 #969696 #bdbdbd #d9d9d9 #f0f0f0 #ffffff"),
    ylgnbu: h("#ffffd9 #edf8b1 #c7e9b4 #7fcdbb #41b6c4 #1d91c0 #225ea8 #253494 #081d58"),
    ylorrd: h("#ffffcc #ffeda0 #fed976 #feb24c #fd8d3c #fc4e2a #e31a1c #bd0026 #800026"),
    hot: h("#0b0000 #4d0000 #8f0000 #d10000 #ff1400 #ff5600 #ff9800 #ffda00 #ffff38 #ffffff"),
    terrain: h("#333399 #0294fa #24d36d #fefe98 #a08b65 #fefefe"),
    elevation: h("#2b6c3b #4f9a46 #9cc463 #e5df8b #d4b46d #b27a4b #8c5a3c #a69a91 #ffffff"),
    thermal: h("#000028 #1e2a8c #2a6fdb #45b3e0 #9ee6c2 #f7f28c #f9b44a #ec5a2c #b5161b #5c0010"),
    water: h("#f7fbff #c6dbef #6baed6 #2171b5 #08306b"),
} as const;

/**
 * Names of the ready-made ramps: `viridis`, `magma`, `inferno`, `plasma`, `cividis`, `turbo`, `spectral`, `rdylgn`,
 * `rdylbu`, `rdbu`, `brbg`, `piyg`, `coolwarm`, `blues`, `greens`, `reds`, `oranges`, `purples`, `greys`, `ylgnbu`,
 * `ylorrd`, `hot`, `terrain`, `elevation`, `thermal`, `water`. All run from low to high values (for example `greys`
 * from black to white, `rdylgn` from red to green).
 *
 * @category Ramps
 */
export type RampName = keyof typeof COLORS;

/**
 * Ready-made ramps by name, each a {@link RampJSON} with `preset` set to its name.
 *
 * Each is smooth and equally spaced (built with {@link rampFromColors}). These objects are shared: use {@link ramp}
 * for a copy to edit.
 *
 * @category Ramps
 */
export const RAMPS: Record<RampName, RampJSON> = Object.fromEntries(
    Object.entries(COLORS).map(([name, colors]) => [name, rampFromColors([...colors], {preset: name})]),
) as Record<RampName, RampJSON>;

/**
 * A copy of a ready-made ramp (edit it freely).
 *
 * @param name - The ramp's name.
 * @returns A deep copy of `RAMPS[name]`: a smooth, equally spaced {@link RampJSON} with `preset` set to `name`. An
 *   unknown name (possible from untyped code or JSON) throws.
 * @throws `RangeError` when `name` is not a ramp of {@link RAMPS}; the message lists the names.
 *
 * @example
 * ```ts
 * const style: BandStyle = {render: {type: "pseudocolor", band: "b1", colorMap: ramp("viridis")}};
 * const reversed = reverseRamp(ramp("rdylgn")); // green to red (reverseRamp from "ria-geotiff")
 * ```
 *
 * @category Ramps
 */
export function ramp(name: RampName): RampJSON {
    if (!Object.prototype.hasOwnProperty.call(RAMPS, name)) {
        throw new RangeError(`Unknown ramp "${String(name)}". Available: ${Object.keys(RAMPS).join(", ")}`);
    }
    return structuredClone(RAMPS[name]);
}

/**
 * Groups for pickers: `sequential` (low to high), `diverging` (two hues around a neutral middle), `rainbow` and
 * `purpose` (terrain, elevation, thermal, water). Every {@link RampName} is in exactly one group.
 *
 * @category Ramps
 */
export const RAMP_GROUPS: Record<"sequential" | "diverging" | "rainbow" | "purpose", RampName[]> = {
    sequential: ["viridis", "cividis", "magma", "inferno", "plasma", "blues", "greens", "reds", "oranges", "purples", "greys", "ylgnbu", "ylorrd", "hot"],
    diverging: ["rdylgn", "rdylbu", "rdbu", "brbg", "piyg", "coolwarm", "spectral"],
    rainbow: ["turbo"],
    purpose: ["terrain", "elevation", "thermal", "water"],
};

/**
 * Sentinel Hub's NDVI look: colours at fixed NDVI values, with the stretch they need (-0.5..1).
 *
 * Use both parts together, so the colours land on their NDVI values:
 * ```ts
 * const style: BandStyle = {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)",
 *     colorMap: NDVI_SENTINEL_HUB.ramp, stretch: NDVI_SENTINEL_HUB.stretch}};
 * ```
 *
 * @category Ramps
 */
export const NDVI_SENTINEL_HUB = rampFromValues([
    {value: -0.5, color: "#0c0c0c"}, {value: -0.2, color: "#bfbfbf"}, {value: -0.1, color: "#dbdbdb"},
    {value: 0, color: "#eaeaea"}, {value: 0.025, color: "#fff9cc"}, {value: 0.05, color: "#ede8b5"},
    {value: 0.075, color: "#ddd89b"}, {value: 0.1, color: "#ccc682"}, {value: 0.125, color: "#bcb76b"},
    {value: 0.15, color: "#afc160"}, {value: 0.175, color: "#a3cc59"}, {value: 0.2, color: "#91bf51"},
    {value: 0.25, color: "#7fb247"}, {value: 0.3, color: "#70a33f"}, {value: 0.35, color: "#609635"},
    {value: 0.4, color: "#4f892d"}, {value: 0.45, color: "#3f7c23"}, {value: 0.5, color: "#306d1c"},
    {value: 0.55, color: "#216011"}, {value: 0.6, color: "#0f540a"}, {value: 1, color: "#004400"},
]);

/**
 * USGS burn severity for dNBR, as a stepped ramp over -0.5..1.3 (each value starts a class).
 *
 * Classes, with labels for legends: enhanced regrowth high (from -0.5) and low (-0.25), unburned (-0.1), low severity
 * (0.1), moderate-low (0.27), moderate-high (0.44) and high severity (0.66 and above). Use `ramp` as the colour map
 * and `stretch` as the stretch, as for {@link NDVI_SENTINEL_HUB}.
 *
 * @category Ramps
 */
export const DNBR_SEVERITY = rampFromValues([
    {value: -0.5, color: "#1a9850", label: "Enhanced regrowth, high"},
    {value: -0.25, color: "#91cf60", label: "Enhanced regrowth, low"},
    {value: -0.1, color: "#d9ef8b", label: "Unburned"},
    {value: 0.1, color: "#fee08b", label: "Low severity"},
    {value: 0.27, color: "#fc8d59", label: "Moderate-low severity"},
    {value: 0.44, color: "#e34a33", label: "Moderate-high severity"},
    {value: 0.66, color: "#7f0000", label: "High severity"},
], {blend: "stepped", range: [-0.5, 1.3]});

/**
 * Sentinel-2 Scene Classification (SCL) classes, values 1..11 with labels. Value 0 (no data) has no entry and is
 * drawn transparent.
 *
 * @category Ramps
 */
export const SCL_TABLE: ColorTableJSON = {type: "table", entries: [
    {value: 1, color: "#ff0000", label: "Saturated or defective"},
    {value: 2, color: "#2f2f2f", label: "Dark area / topographic shadow"},
    {value: 3, color: "#643200", label: "Cloud shadow"},
    {value: 4, color: "#00a000", label: "Vegetation"},
    {value: 5, color: "#ffe65a", label: "Not vegetated"},
    {value: 6, color: "#0000ff", label: "Water"},
    {value: 7, color: "#808080", label: "Unclassified"},
    {value: 8, color: "#c0c0c0", label: "Cloud, medium probability"},
    {value: 9, color: "#ffffff", label: "Cloud, high probability"},
    {value: 10, color: "#64c8ff", label: "Thin cirrus"},
    {value: 11, color: "#ff96ff", label: "Snow or ice"},
]};

/** ESA WorldCover 10 m classes, values 10..100 with labels. Values without an entry are drawn transparent.
 *
 * @category Ramps */
export const WORLDCOVER_TABLE: ColorTableJSON = {type: "table", entries: [
    {value: 10, color: "#006400", label: "Tree cover"},
    {value: 20, color: "#ffbb22", label: "Shrubland"},
    {value: 30, color: "#ffff4c", label: "Grassland"},
    {value: 40, color: "#f096ff", label: "Cropland"},
    {value: 50, color: "#fa0000", label: "Built-up"},
    {value: 60, color: "#b4b4b4", label: "Bare / sparse vegetation"},
    {value: 70, color: "#f0f0f0", label: "Snow and ice"},
    {value: 80, color: "#0064c8", label: "Permanent water"},
    {value: 90, color: "#0096a0", label: "Herbaceous wetland"},
    {value: 95, color: "#00cf75", label: "Mangroves"},
    {value: 100, color: "#fae6a0", label: "Moss and lichen"},
]};
