import {GeoTiffTileSetModel, type BandStyle, type MaskRule} from "ria-geotiff";
import {
    bestPerPeriod, coverageOf, defaultScore, groupItems, itemsCovering,
    StacClient, type Bbox, type StacItemJson as StacItem, type StacSearchRequest,
} from "ria-geotiff/stac";
import {LANDSAT_QA_CLOUD_MASK, SCL_CLOUD_MASK, type StylePreset} from "ria-geotiff/presets";
import {NDVI_SENTINEL_HUB, ramp} from "ria-geotiff/ramps";
import {reverseRamp} from "ria-geotiff";
import {referenceWkt} from "../references.js";

/** GeoTiffTileSetModel.create, with the definitions of the references the sample data uses (UTM zones, LV95). */
const createModel = (options: Parameters<typeof GeoTiffTileSetModel.create>[0]) => GeoTiffTileSetModel.create({resolveReference: referenceWkt, ...options});

/** A place to look at: [west, south, east, north] in degrees, and an optional oblique 3D view. */
export interface SceneView {
    /** Default: the extent of the data. */
    bbox?: [number, number, number, number];
    /** Look at the centre of bbox from this direction (degrees) and pitch (negative = down) in 3D. */
    oblique?: { yaw: number; pitch: number; distance: number; height?: number };
}

export interface Scene {
    id: string;
    group: string;
    title: string;
    subtitle: string;
    story: string;
    credit: string;
    view: SceneView;
    /** Preset id or a style to start with. */
    start: string | BandStyle;
    /** Cloud / quality mask available for this scene. */
    mask?: MaskRule;
    /** Wavelengths (nm) per band, for the spectral profile. */
    wavelengths?: Record<string, number>;
    /**
     * Time series for the slider: its steps (months, years). Styles of the scene's presets write the current step as
     * `{T}` ("green_{T}"); a hand-written style has the current step's token replaced instead.
     */
    timeSeries?: { steps: string[]; unit?: string; initial?: number };
    /** Presets made for this scene (with `{T}` for the time step). */
    presets?: StylePreset[];
    create(): Promise<GeoTiffTileSetModel>;
    /** Filled in by create(): acquisition details. */
    details?: string;
}

// ------------------------------------------------------------------------------------------------ finding data

const EARTH_SEARCH = "https://earth-search.aws.element84.com/v1";
const PLANETARY_COMPUTER = "https://planetarycomputer.microsoft.com/api/stac/v1";
const INPE_BDC = "https://data.inpe.br/bdc/stac/v1";

const clients = new Map<string, Promise<StacClient>>();
/** One client per catalog, so what it learns (ignored filters, page limits) serves every scene. */
function catalog(url: string): Promise<StacClient> {
    if (!clients.has(url)) clients.set(url, StacClient.connect(url).catch((e) => { clients.delete(url); throw e; }));
    return clients.get(url)!;
}

/**
 * Searches a catalog for a place and returns the best item: among the items whose footprint contains the whole
 * place, the best by `score` (least cloud, then most recent); when none contains it, the best of those covering
 * the most of it.
 */
async function findBest(api: string, request: StacSearchRequest & { area: Bbox }, score = defaultScore) {
    const client = await catalog(api);
    const search = client.search({limit: 100, maxItems: 300, ...request});
    const found = await search.collect();
    let candidates = itemsCovering(found, request.area);
    if (!candidates.length && found.length) {
        const coverage = new Map(found.map((i) => [i, coverageOf(i, request.area)]));
        const best = Math.max(...coverage.values());
        candidates = found.filter((i) => coverage.get(i)! >= best - 0.05);
    }
    const item = [...candidates].sort((a, b) => score(a) - score(b))[0];
    if (!item) throw new Error(`No ${request.collections?.join(", ")} item found for this place`);
    const note = `STAC search on ${new URL(api).host}: ${found.length} found, ${candidates.length} covering (filter: ${search.plan.filterEncoding})`;
    return {item, found, note};
}

const newestFirst = (i: StacItem) => -Date.parse(String(i.properties.datetime ?? i.properties.start_datetime ?? ""));
const dateOf = (i: StacItem) => String(i.properties.datetime ?? i.properties.start_datetime ?? "").slice(0, 10);
const S2_ASSETS = ["coastal", "blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08", "nir09", "swir16", "swir22", "scl"];
export const S2_WAVELENGTHS: Record<string, number> = {
    coastal: 443, blue: 490, green: 560, red: 665, rededge1: 705, rededge2: 740, rededge3: 783, nir: 842, nir08: 865,
    nir09: 945, swir16: 1610, swir22: 2190,
};
const LANDSAT_WAVELENGTHS: Record<string, number> = {
    coastal: 443, blue: 482, green: 561, red: 655, nir: 865, swir16: 1609, swir22: 2201,
};

function describeItem(item: StacItem): string {
    const p = item.properties ?? {};
    const date = String(p.datetime ?? "").slice(0, 10);
    const cloud = typeof p["eo:cloud_cover"] === "number" ? `, ${(p["eo:cloud_cover"] as number).toFixed(2)} % cloud` : "";
    const platform = String(p.platform ?? item.collection ?? "");
    return `${platform} ${date}${cloud} · ${item.id}`;
}

/**
 * A Sentinel-2 place: the clearest scene of `datetime` (default 2025) whose footprint contains the place, found by
 * search when the scene opens.
 */
function sentinel2(id: string, title: string, place: string, story: string, view: SceneView & { bbox: Bbox }, start: string,
    datetime: StacSearchRequest["datetime"] = "2025"): Scene {
    const scene: Scene = {
        id, group: "Sentinel-2 L2A (Earth Search, 10 m, 13 bands in separate COGs)", title, subtitle: place, story, view, start,
        credit: "Contains modified Copernicus Sentinel data, processed by ESA; Collection 1 COGs by Element 84 on AWS.",
        mask: SCL_CLOUD_MASK, wavelengths: S2_WAVELENGTHS,
        async create() {
            const {item, note} = await findBest(EARTH_SEARCH, {collections: ["sentinel-2-c1-l2a"], area: view.bbox, datetime,
                where: {"eo:cloud_cover": {lt: 5}}});
            scene.subtitle = `${place} · ${dateOf(item)}`;
            scene.details = `${describeItem(item)} · ${note}`;
            return createModel({stac: {items: [item], assets: S2_ASSETS},
                style: {render: {type: "rgb", red: "red", green: "green", blue: "blue"}}});
        },
    };
    return scene;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const temperature: BandStyle = {render: {type: "pseudocolor", band: "{T}", stretch: [-35, 35], colorMap: ramp("turbo")}};

/** A style with its time placeholder filled in. */
export function fillStep<T>(value: T, step: string): T {
    return JSON.parse(JSON.stringify(value).replaceAll("{T}", step)) as T;
}

/** Vale / Águas Claras mine: the area the scene searches. */
const MINE: [number, number, number, number] = [-43.927, -19.99, -43.861, -19.946];
const VALE_BANDS = ["blue", "green", "red", "nir", "swir16"];
const ndvi = (y: string) => `((nir_${y} - red_${y}) / (nir_${y} + red_${y}))`;
const mndwi = (y: string) => `((green_${y} - swir16_${y}) / (green_${y} + swir16_${y}))`;
const valePreset = (id: string, name: string, description: string, style: BandStyle): StylePreset =>
    ({id, name, description, group: "composite", requires: [], style});
const valePresets = (base: string): StylePreset[] => [
    valePreset("vale-true", "True colour (year on slider)", "The mine as seen in the selected year.",
        {render: {type: "rgb", red: "red_{T}", green: "green_{T}", blue: "blue_{T}", stretch: {type: "percentile", low: 1, high: 99}, gamma: 1.25}}),
    valePreset("vale-cir", "Colour infrared (year on slider)", "Vegetation in red: revegetated benches stand out from bare rock.",
        {render: {type: "rgb", red: "nir_{T}", green: "red_{T}", blue: "green_{T}", stretch: {type: "percentile", low: 1, high: 99}}}),
    valePreset("vale-ndvi", "NDVI (year on slider)", "Vegetation vigour in the selected year.",
        {render: {type: "pseudocolor", expression: ndvi("{T}"), stretch: NDVI_SENTINEL_HUB.stretch, colorMap: NDVI_SENTINEL_HUB.ramp}}),
    valePreset("vale-water", "Water, MNDWI (year on slider)", "Open water > 0: the flooded pit lake and the reservoirs.",
        {render: {type: "pseudocolor", expression: mndwi("{T}"), stretch: [-0.6, 0.6], colorMap: ramp("rdbu")}}),
    valePreset("vale-ndvi-change", `NDVI change since ${base}`, `Green: more vegetation than in ${base} (revegetation); brown: less.`,
        {render: {type: "pseudocolor", expression: `${ndvi("{T}")} - ${ndvi(base)}`, stretch: [-0.4, 0.4], colorMap: ramp("brbg")}}),
    valePreset("vale-water-change", `Water change since ${base}`, `Blue: wetter than in ${base}; red: drier.`,
        {render: {type: "pseudocolor", expression: `${mndwi("{T}")} - ${mndwi(base)}`, stretch: [-0.5, 0.5], colorMap: ramp("rdbu")}}),
];

const vale: Scene = {
    id: "vale", group: "Vale Águas Claras mine: one scene per year",
    title: "Vale Águas Claras mine, 10 m", subtitle: "Belo Horizonte, Brazil · Sentinel-2, one scene per year 2018–2026",
    story: "Found by a STAC search at load time: Earth Search is asked for low-cloud Sentinel-2 scenes over the mine, the client keeps those covering the whole mine in the dry season (June to September) and picks the clearest per year. Bands are named by year (green_2024 …); slide through the years, or compare with the first.",
    credit: "Contains modified Copernicus Sentinel data 2018–2026, processed by ESA; COGs by Element 84 on AWS.",
    view: {bbox: [-43.927, -19.99, -43.861, -19.946], oblique: {yaw: 330, pitch: -32, distance: 9500, height: 1100}},
    start: "vale-true", wavelengths: undefined,
    timeSeries: {steps: [], unit: ""},
    async create() {
        // 1. Connect, 2. search the mine, 3. keep full, dry-season coverage, 4. best scene per year, 5. one model.
        const client = await StacClient.connect("https://earth-search.aws.element84.com/v1");
        const search = client.search({
            collections: ["sentinel-2-c1-l2a"], area: MINE, datetime: ["2018", null],
            where: {"eo:cloud_cover": {lt: 3}}, limit: 100, maxItems: 600,
        });
        const found = await search.collect();
        const dry = itemsCovering(found, MINE).filter((i) => {
            const month = new Date(String(i.properties.datetime)).getUTCMonth() + 1;
            return month >= 6 && month <= 9;
        });
        // One coordinate reference per model: keep the largest group (the mine lies in UTM zone 23S).
        const byCrs = [...groupItems(dry, "crs").values()].sort((a, b) => b.length - a.length)[0] ?? [];
        const yearly = bestPerPeriod(byCrs, {period: "year"});
        if (!yearly.length) throw new Error("No cloud-free scene covers the mine");
        const steps = yearly.map((y) => y.period);
        vale.timeSeries = {steps, unit: "", initial: steps.length - 1};
        vale.presets = valePresets(steps[0]);
        vale.details = `STAC search: ${found.length} scenes < 3 % cloud (filter: ${search.plan.filterEncoding}), `
            + `${dry.length} cover the mine in the dry season · ${yearly.map((y) => String(y.items[0].properties.datetime).slice(0, 10)).join(", ")}`;
        const last = steps[steps.length - 1];
        // Earth Search names the assets by role: the asset keys are the band names.
        return createModel({stac: {items: yearly.map((y) => y.items[0]), per: "year", assets: VALE_BANDS},
            style: {render: {type: "rgb", red: `red_${last}`, green: `green_${last}`, blue: `blue_${last}`}}});
    },
};

/**
 * INPE's catalog gives no cloud cover for CBERS-4A, so "clearest" cannot be read from it: the scene per year closest
 * to mid-July (the dry season) is taken instead.
 */
const closestToMidJuly = (i: StacItem) => {
    const d = new Date(dateOf(i));
    return Math.abs(d.getTime() - Date.UTC(d.getUTCFullYear(), 6, 15));
};
/** INPE's API sends CORS headers, its data files do not: they go through the dev server's relay (demo/vite.config.ts). */
const inpeRelay = (url: string) => url.replace(/^https:\/\/data\.inpe\.br\//, "/inpe/");
const brightness = (y: string) => `mean(red_${y}, green_${y}, blue_${y})`;

const valeCbers: Scene = {
    id: "vale-cbers", group: vale.group,
    title: "Vale Águas Claras mine, 2 m", subtitle: "Belo Horizonte, Brazil · CBERS-4A WPM pansharpened 2 m, 2023–2026",
    story: "Brazil's own CBERS-4A satellite: 2 m colour, five times sharper than Sentinel-2. One clear scene per year, each a 4.6 GB COG of which only the blocks in view are read. Benches, haul roads and new excavations are visible; compare a year with 2023.",
    credit: "CBERS-4A WPM imagery courtesy of INPE, Brazil Data Cube (CB4A-WPM-PCA-FUSED), streamed through the dev server's CORS relay.",
    // Closer than the 10 m scene: the 2 m detail shows from the first view.
    view: {bbox: [-43.915, -19.975, -43.88, -19.95], oblique: {yaw: 335, pitch: -38, distance: 4200, height: 1100}}, start: "cbers-true",
    timeSeries: {steps: [], unit: ""},
    presets: [
        valePreset("cbers-true", "True colour 2 m (year on slider)", "Pansharpened colour of the selected year.",
            {render: {type: "rgb", red: "red_{T}", green: "green_{T}", blue: "blue_{T}", stretch: {type: "percentile", low: 0.5, high: 99.5}, gamma: 1.3, saturation: 1.15}}),
        valePreset("cbers-change", "Brightness change since 2023", "Red: brighter than in 2023 (new bare ground, excavation); blue: darker (regrowth, water).",
            {render: {type: "pseudocolor", expression: `${brightness("{T}")} - ${brightness("2023")}`, stretch: [-50, 50], colorMap: reverseRamp(ramp("rdbu"))}}),
    ],
    async create() {
        const client = await catalog(INPE_BDC);
        const found = await client.search({collections: ["CB4A-WPM-PCA-FUSED-1"], area: MINE, limit: 100, maxItems: 300}).collect();
        const yearly = bestPerPeriod(itemsCovering(found, MINE), {period: "year", score: closestToMidJuly});
        if (!yearly.length) throw new Error("No CBERS-4A scene covers the mine");
        const steps = yearly.map((y) => y.period);
        valeCbers.timeSeries = {steps, unit: "", initial: steps.length - 1};
        valeCbers.details = `STAC search on data.inpe.br: ${found.length} scenes over the mine · ${yearly.map((y) => dateOf(y.items[0])).join(", ")}`;
        const last = steps[steps.length - 1];
        return createModel({
            // INPE describes no bands for this product: they are R, G, B (WPM bands 3, 2, 1, "RGB321" in the name).
            stac: {items: yearly.map((y) => y.items[0]), per: "year", assets: ["tci"], bandNames: {tci: ["red", "green", "blue"]}},
            rewriteUrl: inpeRelay,
            style: {render: {type: "rgb", red: `red_${last}`, green: `green_${last}`, blue: `blue_${last}`}},
        });
    },
};

export const SCENES: Scene[] = [
    vale,
    valeCbers,
    sentinel2("grand-canyon", "Grand Canyon", "Arizona, USA",
        "Two billion years of rock layers exposed by the Colorado River. The geology composite (SWIR2, SWIR1, blue) separates the red sandstones from the limestone rims.",
        {bbox: [-112.3, 35.95, -112.0, 36.12], oblique: {yaw: 200, pitch: -26, distance: 26000, height: 1800}}, "geology"),
    sentinel2("everest", "Mount Everest", "Himalaya, Nepal / Tibet",
        "The roof of the world. NDSI lights up snow and glaciers; switch on 3D terrain and swipe against true colour.",
        {bbox: [86.84, 27.95, 87.02, 28.08], oblique: {yaw: 195, pitch: -20, distance: 34000, height: 6000}}, "ndsi"),
    sentinel2("nile-delta", "Nile Delta", "Egypt",
        "One of the most intensively farmed places on Earth, squeezed between two deserts. NDVI shows every field.",
        {bbox: [30.95, 30.7, 31.95, 31.55]}, "ndvi"),
    sentinel2("dubai", "Dubai", "United Arab Emirates",
        "Palm Jumeirah and a city grown out of the desert. Try the urban false colour, NDBI, or MNDWI for the coastline.",
        {bbox: [55.04, 25.0, 55.36, 25.3]}, "urban"),
    sentinel2("etna", "Mount Etna", "Sicily, Italy",
        "Europe's most active volcano: fresh lava flows are black in true colour and glow in the SWIR composite.",
        {bbox: [14.9, 37.62, 15.25, 37.85], oblique: {yaw: 260, pitch: -22, distance: 32000, height: 2000}}, "swir"),
    sentinel2("iguazu", "Iguazú Falls", "Argentina / Brazil",
        "Rainforest against farmland on the Paraná plateau. Compare NDVI with the red-edge index NDRE.",
        {bbox: [-54.62, -25.78, -54.3, -25.55]}, "color-infrared"),
    {
        id: "landsat-thermal", group: "Landsat 9 / 8 Collection 2 (Planetary Computer, signed URLs)",
        title: "Arizona surface temperature", subtitle: "Landsat 8/9 · the clearest 2025 scene",
        story: "Thermal infrared turned into °C with an expression (lwir − 273.15). The QA_PIXEL bit mask hides clouds; tokens for Planetary Computer are fetched and renewed automatically.",
        credit: "Landsat imagery courtesy of the U.S. Geological Survey, via Microsoft Planetary Computer.",
        view: {bbox: [-112.3, 35.85, -111.5, 36.3]}, start: "lst", mask: LANDSAT_QA_CLOUD_MASK, wavelengths: LANDSAT_WAVELENGTHS,
        async create() {
            const {item, note} = await findBest(PLANETARY_COMPUTER, {collections: ["landsat-c2-l2"], area: [-112.3, 35.85, -111.5, 36.3],
                datetime: "2025", where: {"eo:cloud_cover": {lt: 10}, platform: {in: ["landsat-8", "landsat-9"]}}});
            this.subtitle = `${String(item.properties.platform)} · ${dateOf(item)}`;
            this.details = `${describeItem(item)} · ${note}`;
            return createModel({
                stac: {items: [item], assets: ["coastal", "blue", "green", "red", "nir08", "swir16", "swir22", "lwir11", "qa_pixel"]},
                style: {render: {type: "rgb", red: "red", green: "green", blue: "blue"}},
            });
        },
    },
    {
        id: "naip", group: "Single-file multiband",
        title: "NAIP 60 cm, Santa Cruz", subtitle: "USDA NAIP · the newest flight · one 4-band COG (R, G, B, NIR)",
        story: "Four bands in one 460 MB file, streamed by range requests: name the bands and NDVI or colour infrared work as for satellites.",
        credit: "USDA Farm Service Agency, National Agriculture Imagery Program, via Microsoft Planetary Computer.",
        view: {bbox: [-122.04, 36.96, -122.0, 36.99]}, start: "color-infrared",
        wavelengths: {blue: 470, green: 560, red: 635, nir: 860},
        async create() {
            const {item, note} = await findBest(PLANETARY_COMPUTER, {collections: ["naip"], area: [-122.04, 36.96, -122.0, 36.99]}, newestFirst);
            this.subtitle = `USDA NAIP · ${dateOf(item)} · one 4-band COG (R, G, B, NIR)`;
            this.details = `${item.id} · ${note}`;
            // The 4-band image asset declares its bands' common names in the catalog: red, green, blue, nir.
            return createModel({stac: {items: [item], assets: ["image"]},
                style: {render: {type: "rgb", red: "red", green: "green", blue: "blue"}}});
        },
    },
    {
        id: "worldcover", group: "Classification",
        title: "ESA WorldCover, Alps", subtitle: "ESA WorldCover 10 m 2021 · 11 land cover classes",
        story: "A single-band class raster rendered with an exact-value colour map and legend: Lake Geneva, Mont Blanc's glaciers, cities and forests.",
        credit: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium.",
        view: {bbox: [6.1, 45.75, 7.1, 46.5]},
        start: "worldcover",
        async create() {
            const {item, note} = await findBest(PLANETARY_COMPUTER, {collections: ["esa-worldcover"], area: [6.1, 45.75, 7.1, 46.5]}, newestFirst);
            this.subtitle = `ESA WorldCover 10 m ${dateOf(item).slice(0, 4)} · 11 land cover classes`;
            this.details = `${item.id} · ${note}`;
            return createModel({stac: {items: [item], assets: ["map"], bandNames: {map: "landcover"}},
                style: {render: {type: "pseudocolor", band: "landcover"}}});
        },
    },
    {
        id: "worldclim", group: "Time series (one band per month)",
        title: "World temperature by month", subtitle: "WorldClim 2.1 · monthly mean 1970–2000 · 12 bands Jan..Dec",
        story: "Each band is a month. Press play to watch the seasons sweep across the planet, or try expressions such as Jul - Jan (seasonal swing) or mean(Jan, Feb, Mar).",
        credit: "WorldClim 2.1: Fick & Hijmans 2017, Int. J. Climatology 37(12). Prepared locally with demo/prepare-worldclim.sh.",
        view: {bbox: [-170, -58, 180, 80]}, start: "worldclim-temperature",
        timeSeries: {steps: MONTHS, unit: "°C"},
        presets: [valePreset("worldclim-temperature", "Temperature (month on slider)", "Monthly mean temperature, −35 to 35 °C.", temperature)],
        async create() {
            this.details = "worldclim-tavg-10m.tif · 2160 x 1080 px · 12 bands · local COG";
            return createModel({url: "/data/worldclim-tavg-10m.tif", style: fillStep(temperature, "Jan")});
        },
    },
];
