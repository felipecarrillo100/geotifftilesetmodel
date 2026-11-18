/**
 * Optional ready-made styles, imported from `ria-geotiff/presets`: band composites, spectral indices, class legends
 * and cloud masks. Each is an ordinary {@link BandStyle} built from the public API, so it can be used as is, copied
 * and edited, or ignored.
 *
 * Presets use the common band names of the STAC electro-optical extension, which Earth Search (Sentinel-2) and
 * Planetary Computer (Landsat) use as asset keys: coastal, blue, green, red, rededge1..3, nir, nir09, swir16,
 * swir22, lwir. Landsat's `nir08` is exposed as `nir` by the STAC helpers so that one preset serves both sensors.
 * Band values are expected as surface reflectance (0..1), which the STAC helpers ensure by applying scale/offset.
 *
 * ```ts
 * import {presetsFor, presetStyle, SCL_CLOUD_MASK} from "ria-geotiff/presets";
 * const choices = presetsFor(["red", "green", "blue", "nir", "scl"]);
 * const style = presetStyle("ndvi", SCL_CLOUD_MASK);
 * ```
 *
 * @module ria-geotiff/presets
 */
import {reverseRamp, type ColorMapSpec} from "./colormaps.js";
import {NDVI_SENTINEL_HUB, ramp, SCL_TABLE, WORLDCOVER_TABLE, type RampName} from "./ramps.js";
import type {StretchSpec} from "./stats.js";
import type {BandStyle, MaskRule} from "./style.js";

/**
 * The kind of a preset: `"composite"` (an RGB band combination), `"index"` (a spectral index through a colour ramp)
 * or `"classes"` (a class raster through a class table).
 *
 * @category Presets
 */
export type PresetGroup = "composite" | "index" | "classes";

/**
 * A ready-made style with what a user interface needs to offer it.
 *
 * @example
 * ```json
 * { "id": "color-infrared", "name": "Colour infrared", "group": "composite",
 *   "description": "Vegetation in bright red; the classic false-colour view (S2 B8/B4/B3).",
 *   "requires": ["nir", "red", "green"],
 *   "style": { "render": { "type": "rgb", "red": "nir", "green": "red", "blue": "green",
 *                          "stretch": { "type": "percentile", "low": 1, "high": 99 }, "gamma": 1.1 } } }
 * ```
 *
 * @category Presets
 */
export interface StylePreset {
    /** Stable identifier, for {@link presetStyle} (for example `"ndvi"`, `"true-color"`). */
    id: string;
    /** Display name (for example `"NDVI"`, `"True colour"`). */
    name: string;
    /** The kind of preset, for grouping in pickers. */
    group: PresetGroup;
    /** One-sentence explanation for users. */
    description: string;
    /** Bands the preset needs (STAC common names), each once. */
    requires: string[];
    /** The style. Shared: use {@link presetStyle} for a copy to edit. */
    style: BandStyle;
}

/** Reflectance stretch that suits most land scenes for composites. */
const REFLECTANCE: StretchSpec = {type: "percentile", low: 1, high: 99};

function composite(id: string, name: string, bands: [string, string, string], description: string, gamma = 1.1): StylePreset {
    return {
        id, name, group: "composite", description, requires: [...new Set(bands)],
        style: {render: {type: "rgb", red: bands[0], green: bands[1], blue: bands[2], stretch: REFLECTANCE, gamma}},
    };
}

function index(id: string, name: string, expression: string, requires: string[], description: string,
    colorMap: ColorMapSpec | RampName, stretch: StretchSpec): StylePreset {
    return {id, name, group: "index", description, requires, style: {render: {
        type: "pseudocolor", expression, stretch, colorMap: typeof colorMap === "string" ? ramp(colorMap) : colorMap,
    }}};
}

/**
 * RGB band combinations: `true-color`, `color-infrared`, `agriculture`, `swir`, `geology`, `urban`, `land-water`,
 * `atmospheric`, `bathymetric`. Each stretches with a 1–99 % percentile clip and gamma 1.1 (1.3 for true colour).
 *
 * @category Presets
 */
export const COMPOSITES: StylePreset[] = [
    composite("true-color", "True colour", ["red", "green", "blue"], "What the eye sees (S2 B4/B3/B2, Landsat B4/B3/B2).", 1.3),
    composite("color-infrared", "Colour infrared", ["nir", "red", "green"], "Vegetation in bright red; the classic false-colour view (S2 B8/B4/B3)."),
    composite("agriculture", "Agriculture", ["swir16", "nir", "blue"], "Healthy crops in vivid green, bare fields in brown (S2 B11/B8/B2)."),
    composite("swir", "Short-wave infrared", ["swir22", "nir", "red"], "Burn scars and moisture; sees through haze (S2 B12/B8/B4)."),
    composite("geology", "Geology", ["swir22", "swir16", "blue"], "Rock and mineral types stand out (S2 B12/B11/B2)."),
    composite("urban", "False colour (urban)", ["swir22", "swir16", "red"], "Built-up areas in magenta and grey (S2 B12/B11/B4)."),
    composite("land-water", "Land / water", ["nir", "swir16", "red"], "Sharp shorelines; water is dark blue (S2 B8/B11/B4)."),
    composite("atmospheric", "Atmospheric penetration", ["swir22", "swir16", "nir"], "Cuts through smoke and haze (S2 B12/B11/B8)."),
    composite("bathymetric", "Bathymetric", ["red", "green", "coastal"], "Shallow water features (S2 B4/B3/B1)."),
];

/**
 * Spectral indices drawn through a ramp over a fixed range (in index units): `ndvi`, `evi`, `savi`, `ndre`, `ndwi`,
 * `mndwi`, `ndmi`, `nbr`, `ndbi`, `ndsi`, `bai` and `lst` (surface temperature in °C from a `lwir` band in kelvin).
 *
 * @category Presets
 */
export const INDICES: StylePreset[] = [
    index("ndvi", "NDVI", "(nir - red) / (nir + red)", ["nir", "red"],
        "Normalised Difference Vegetation Index: plant vigour, -1..1 (dense vegetation > 0.6).",
        NDVI_SENTINEL_HUB.ramp, NDVI_SENTINEL_HUB.stretch),
    index("evi", "EVI", "2.5 * (nir - red) / (nir + 6 * red - 7.5 * blue + 1)", ["nir", "red", "blue"],
        "Enhanced Vegetation Index: like NDVI without saturating over dense canopies.", "greens", [-0.2, 1]),
    index("savi", "SAVI", "1.5 * (nir - red) / (nir + red + 0.5)", ["nir", "red"],
        "Soil Adjusted Vegetation Index: NDVI corrected for bright soil (arid regions).", "rdylgn", [-0.5, 1]),
    index("ndre", "NDRE", "(nir - rededge1) / (nir + rededge1)", ["nir", "rededge1"],
        "Red-edge index: chlorophyll content, sensitive late in the season (Sentinel-2 only).", "viridis", [-0.2, 0.7]),
    index("ndwi", "NDWI", "(green - nir) / (green + nir)", ["green", "nir"],
        "McFeeters' water index: open water > 0.", "rdbu", [-0.8, 0.8]),
    index("mndwi", "MNDWI", "(green - swir16) / (green + swir16)", ["green", "swir16"],
        "Modified water index: separates water from built-up areas better than NDWI.", "rdbu", [-0.8, 0.8]),
    index("ndmi", "NDMI", "(nir - swir16) / (nir + swir16)", ["nir", "swir16"],
        "Moisture index: water stress in vegetation.", "brbg", [-0.6, 0.6]),
    index("nbr", "NBR", "(nir - swir22) / (nir + swir22)", ["nir", "swir22"],
        "Normalised Burn Ratio: burn scars are strongly negative.", "rdylgn", [-0.6, 0.8]),
    index("ndbi", "NDBI", "(swir16 - nir) / (swir16 + nir)", ["swir16", "nir"],
        "Built-up index: urban surfaces > 0.", "magma", [-0.5, 0.4]),
    index("ndsi", "NDSI", "(green - swir16) / (green + swir16)", ["green", "swir16"],
        "Snow index: snow and ice > 0.4.", reverseRamp(ramp("blues")), [-0.2, 1]),
    index("bai", "BAI", "1 / ((0.1 - red) ^ 2 + (0.06 - nir) ^ 2)", ["red", "nir"],
        "Burned Area Index: recently burned land is bright.", "inferno", [0, 400]),
    index("lst", "Surface temperature", "lwir - 273.15", ["lwir"],
        "Land surface temperature in °C from the Landsat thermal band (Collection 2 ST, kelvin).", "thermal", [0, 60]),
];

/**
 * Class legends: `scl` (Sentinel-2 Scene Classification, band `scl`, {@link SCL_TABLE}) and `worldcover` (ESA
 * WorldCover, band `landcover`, {@link WORLDCOVER_TABLE}).
 *
 * @category Presets
 */
export const CLASS_PRESETS: StylePreset[] = [
    {id: "scl", name: "Scene classification", group: "classes", requires: ["scl"],
        description: "Sentinel-2 L2A per-pixel classes: clouds, shadows, water, vegetation, snow.",
        style: {render: {type: "pseudocolor", band: "scl", colorMap: SCL_TABLE}}},
    {id: "worldcover", name: "ESA WorldCover", group: "classes", requires: ["landcover"],
        description: "ESA WorldCover 10 m land cover classes (band named landcover).",
        style: {render: {type: "pseudocolor", band: "landcover", colorMap: WORLDCOVER_TABLE}}},
];

/**
 * Hides clouds, cloud shadows, cirrus, saturated and no-data pixels using the Sentinel-2 SCL band.
 *
 * SCL values hidden: 0 (no data), 1 (saturated or defective), 3 (cloud shadow), 8 and 9 (cloud, medium and high
 * probability) and 10 (thin cirrus). Needs a band named `scl`.
 *
 * @category Presets
 */
export const SCL_CLOUD_MASK: MaskRule = {band: "scl", values: [0, 1, 3, 8, 9, 10]};

/**
 * Hides fill, dilated cloud, cirrus, cloud and cloud shadow using Landsat Collection 2 QA_PIXEL bits.
 *
 * QA_PIXEL bits 0 to 4. Needs a band named `qa_pixel`.
 *
 * @category Presets
 */
export const LANDSAT_QA_CLOUD_MASK: MaskRule = {band: "qa_pixel", bits: [0, 1, 2, 3, 4]};

/** All presets: {@link COMPOSITES}, then {@link INDICES}, then {@link CLASS_PRESETS}.
 *
 * @category Presets */
export const STYLE_PRESETS: StylePreset[] = [...COMPOSITES, ...INDICES, ...CLASS_PRESETS];

/**
 * Presets whose bands are all available.
 *
 * @param bandNames - The band names of the data (STAC common names, as the STAC helpers expose them).
 * @returns The presets of {@link STYLE_PRESETS} whose `requires` are all in `bandNames`, in that order. The presets
 *   are shared, not copied.
 *
 * @example
 * ```ts
 * presetsFor(["red", "green", "blue", "nir"]).map((p) => p.id);
 * // ["true-color", "color-infrared", "ndvi", "evi", "savi", "ndwi", "bai"]
 * ```
 *
 * @category Presets
 */
export function presetsFor(bandNames: string[]): StylePreset[] {
    const available = new Set(bandNames);
    return STYLE_PRESETS.filter((p) => p.requires.every((b) => available.has(b)));
}

/**
 * A copy of a preset's style, with mask rules added (for example {@link SCL_CLOUD_MASK}).
 *
 * @param id - The preset's {@link StylePreset.id}.
 * @param mask - One mask rule or several, appended to the style's own (no preset has any).
 * @returns A deep copy of the preset's style, safe to edit, with `mask` added when given.
 * @throws `RangeError` when no preset has this id; the message lists the ids.
 *
 * @example
 * ```ts
 * const style = presetStyle("true-color", SCL_CLOUD_MASK);
 * // {render: {type: "rgb", red: "red", green: "green", blue: "blue", ...}, mask: [{band: "scl", values: [0, 1, 3, 8, 9, 10]}]}
 * ```
 *
 * @category Presets
 */
export function presetStyle(id: string, mask?: MaskRule | MaskRule[]): BandStyle {
    const preset = STYLE_PRESETS.find((p) => p.id === id);
    if (!preset) throw new RangeError(`Unknown preset "${id}". Available: ${STYLE_PRESETS.map((p) => p.id).join(", ")}`);
    const style = structuredClone(preset.style);
    if (mask) style.mask = [...(style.mask ?? []), ...(Array.isArray(mask) ? mask : [mask])];
    return style;
}
