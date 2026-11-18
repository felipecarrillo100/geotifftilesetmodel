import {WebGLMap} from "@luciad/ria/view/WebGLMap.js";
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import {createBounds, createPoint} from "@luciad/ria/shape/ShapeFactory.js";
import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
import {LocationMode} from "@luciad/ria/transformation/LocationMode.js";
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {LayerType} from "@luciad/ria/view/LayerType.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {FusionTileSetModel} from "@luciad/ria/model/tileset/FusionTileSetModel.js";
import {UrlTileSetModel} from "@luciad/ria/model/tileset/UrlTileSetModel.js";
import type {LayerTreeNode} from "@luciad/ria/view/LayerTreeNode.js";
import type {Bounds} from "@luciad/ria/shape/Bounds.js";
import type {PerspectiveCamera} from "@luciad/ria/view/camera/PerspectiveCamera.js";
import {GeoTiffTileSetModel} from "ria-geotiff";
import {referenceWkt} from "./references.js";
import {createLayerControl, isElevation, layerBounds} from "./layerControl.js";
import {loadSwissArea} from "./swisstopo.js";

/** Esri World Imagery basemap (free for development and demos with attribution; see Esri's terms of use). */
const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{-y}/{x}";
const FUSION_URL = "https://sampleservices.luciad.com/lts";
const FUSION_COVERAGE = "world_elevation_6714a770-860b-4878-90c9-ab386a4bae0f";
const SWISSTOPO = "https://data.geo.admin.ch";
const SAMPLE_ELEVATION = `${SWISSTOPO}/ch.swisstopo.swissalti3d/swissalti3d_2019_2617-1091/swissalti3d_2019_2617-1091_0.5_2056_5728.tif`;
const SAMPLE_IMAGERY = `${SWISSTOPO}/ch.swisstopo.swissimage-dop10/swissimage-dop10_2017_2617-1091/swissimage-dop10_2017_2617-1091_0.1_2056.tif`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLDivElement>("log");
const probeEl = $<HTMLDivElement>("probe");

function log(message: string, error = false) {
    const line = document.createElement("div");
    line.textContent = message;
    if (error) line.className = "error";
    logEl.prepend(line);
    (error ? console.error : console.log)("[demo]", message);
}

function describe(error: unknown): string {
    const e = error as Error & { cause?: unknown; identifier?: string };
    const cause = typeof e.cause === "string" ? ` (${e.cause}${e.identifier ? ` ${e.identifier}` : ""})` : "";
    return `${e.message ?? String(error)}${cause}`;
}

const map = new WebGLMap("map", {reference: getReference("EPSG:4978")});
const wgs84 = getReference("EPSG:4979"); // lon, lat, ellipsoidal height
const toWgs84 = createTransformation(map.reference, wgs84);

// ------------------------------------------------------------------------------------------- always present layers

/** Web Mercator XYZ basemap (row 0 at the top: the {-y} placeholder converts from LuciadRIA's bottom-up rows). */
function addBasemap() {
    const webMercator = getReference("EPSG:3857");
    const r = 20037508.342789244;
    const model = new UrlTileSetModel({
        baseURL: ESRI_IMAGERY,
        structure: {
            reference: webMercator,
            bounds: createBounds(webMercator, [-r, 2 * r, -r, 2 * r]),
            level0Columns: 1, level0Rows: 1, tileWidth: 256, tileHeight: 256, levelCount: 20,
        },
    });
    map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Esri World Imagery", layerType: LayerType.BASE}), "bottom");
}

/** LuciadFusion's world elevation, for comparison: always in the layer list, switched off. */
async function addFusionElevation() {
    try {
        const model = await FusionTileSetModel.createFromURL(FUSION_URL, FUSION_COVERAGE);
        map.layerTree.addChild(new RasterTileSetLayer(model, {label: "LuciadFusion world elevation", visible: false}));
    } catch (e) {
        log(`LuciadFusion elevation: ${describe(e)}`, true);
    }
}

// ------------------------------------------------------------------------------------------- terrain probe and camera

/** Height of the terrain RIA renders under a view pixel (what the user sees). */
function terrainAt(viewX: number, viewY: number) {
    const world = map.getViewToMapTransformation(LocationMode.TERRAIN).transform(createPoint(null, [viewX, viewY]));
    const p = toWgs84.transform(world);
    return {lon: p.x, lat: p.y, height: p.z};
}

/** Resolves when RIA has nothing left to load or paint. */
function idle(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { handle.remove(); resolve(); }, timeoutMs);
        const handle = map.on("idle", () => { clearTimeout(timer); handle.remove(); resolve(); });
    });
}

/**
 * Heights RIA renders at geographic points: for each point the camera looks straight down at it from
 * `altitude` metres, waits until the terrain is loaded and reads the terrain under the centre pixel.
 * The camera is restored afterwards. Used by the automated checks.
 */
async function probeTerrain(points: [number, number][], altitude = 6000): Promise<{ lon: number; lat: number; height: number | null }[]> {
    const saved = map.camera;
    const toMap = createTransformation(wgs84, map.reference);
    const results: { lon: number; lat: number; height: number | null }[] = [];
    try {
        for (const [lon, lat] of points) {
            const eye = toMap.transform(createPoint(wgs84, [lon, lat, altitude]));
            map.camera = (map.camera as PerspectiveCamera).lookFrom({eye, yaw: 0, pitch: -89.99, roll: 0});
            await idle();
            try {
                const hit = terrainAt(map.viewSize[0] / 2, map.viewSize[1] / 2);
                results.push({lon: hit.lon, lat: hit.lat, height: hit.height});
            } catch {
                results.push({lon, lat, height: null});
            }
        }
    } finally {
        map.camera = saved;
    }
    return results;
}

/** Terrain height at the centre of the view, when terrain is loaded. */
function terrainHeightNear(): number | null {
    try {
        return terrainAt(map.viewSize[0] / 2, map.viewSize[1] / 2).height;
    } catch {
        return null;
    }
}

/**
 * Fits bounds. Local extents (up to ~200 km) are then looked at obliquely from a distance proportional to their
 * size, aimed at the actual terrain height so mountains are not cut by the camera; larger ones stay top-down.
 */
async function fitBounds(bounds: Bounds) {
    await map.mapNavigator.fit({bounds, animate: false});
    const geographic = bounds.reference!.identifier === "EPSG:4326" || bounds.reference!.identifier === "CRS:84";
    const size = Math.max(bounds.width, bounds.height) * (geographic ? 111000 : 1);
    if (size > 200000) return;
    await idle();
    const centre = bounds.focusPoint;
    const ground = toWgs84.transform(createTransformation(centre.reference!, map.reference).transform(centre));
    const height = terrainHeightNear() ?? 0;
    const target = createTransformation(wgs84, map.reference).transform(createPoint(wgs84, [ground.x, ground.y, height]));
    map.camera = (map.camera as PerspectiveCamera).lookAt({ref: target, distance: size * 1.2, yaw: 225, pitch: -22, roll: 0});
}

map.domNode.addEventListener("click", (event) => {
    const rect = map.domNode.getBoundingClientRect();
    try {
        const {lon, lat, height} = terrainAt(event.clientX - rect.left, event.clientY - rect.top);
        probeEl.textContent = `lon ${lon.toFixed(6)}  lat ${lat.toFixed(6)}\nterrain height ${height.toFixed(2)} m`;
    } catch {
        probeEl.textContent = "No terrain under the cursor.";
    }
});

// ------------------------------------------------------------------------------------------- adding data

/** Adds a layer; an elevation layer switches the other elevation layers off (LuciadRIA shows only one). */
function addLayer(node: LayerTreeNode) {
    if (isElevation(node)) {
        for (const other of map.layerTree.children) if (isElevation(other)) other.visible = false;
    }
    map.layerTree.addChild(node);
}

function fileName(url: string): string {
    const path = url.split("?")[0];
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || url;
}

async function addElevationUrl(url: string) {
    const t = performance.now();
    const model = await GeoTiffTileSetModel.create({
        url,
        dataType: RasterDataType.ELEVATION,
        resolveReference: referenceWkt,
        onReadError: (error) => log(`${fileName(url)}: ${error.message}`, true),
    });
    const layer = new RasterTileSetLayer(model, {label: fileName(url)});
    addLayer(layer);
    const info = model.getModelInfo();
    log(`Elevation ${fileName(url)}: ${info.width}x${info.height} ${info.pixelMeaning} ${info.crsName}, ` +
        `${model.levelCount} levels, ${Math.round(performance.now() - t)} ms`);
    return layer;
}

async function addImageryUrl(url: string) {
    const model = await GeoTiffTileSetModel.create({url, resolveReference: referenceWkt});
    const layer = new RasterTileSetLayer(model, {label: fileName(url)});
    addLayer(layer);
    const info = model.getModelInfo();
    log(`Imagery ${fileName(url)}: ${info.width}x${info.height} ${info.pixelMeaning} ${info.crsName}, ${model.levelCount} levels`);
    return layer;
}

async function addSwissArea() {
    const number = (id: string, min: number, max: number) => Math.min(max, Math.max(min, Number($<HTMLInputElement>(id).value)));
    const area = {
        east: number("swiss-e", 2480, 2840),
        north: number("swiss-n", 1070, 1300),
        width: number("swiss-w", 1, 20),
        height: number("swiss-h", 1, 20),
    };
    const {elevation, imagery} = await loadSwissArea(area, log);
    addLayer(elevation);
    addLayer(imagery);
    return elevation;
}

const sourceSelect = $<HTMLSelectElement>("source");
const addButton = $<HTMLButtonElement>("add");

function showOptions() {
    document.querySelectorAll<HTMLElement>("[data-source]").forEach((section) => {
        section.hidden = section.dataset.source !== sourceSelect.value;
    });
}
sourceSelect.addEventListener("change", showOptions);

addButton.addEventListener("click", async () => {
    addButton.disabled = true;
    try {
        let added: LayerTreeNode;
        switch (sourceSelect.value) {
            case "elevation":
                added = await addElevationUrl($<HTMLInputElement>("elevation-url").value.trim());
                break;
            case "imagery":
                added = await addImageryUrl($<HTMLInputElement>("imagery-url").value.trim());
                break;
            default:
                added = await addSwissArea();
        }
        const bounds = layerBounds(added);
        if (bounds) await fitBounds(bounds);
    } catch (e) {
        log(describe(e), true);
    } finally {
        addButton.disabled = false;
    }
});

// ------------------------------------------------------------------------------------------- start

createLayerControl($<HTMLDivElement>("layers"), map.layerTree, (bounds) => fitBounds(bounds));
addBasemap();
void addFusionElevation();

// Prefill the URL fields: the local Zermatt COGs built by demo/fetch-swisstopo.sh when present, else swisstopo's
// Matterhorn tile.
void (async () => {
    let local = false;
    try {
        local = (await fetch("/data/zermatt-elevation.tif", {method: "HEAD"})).ok;
    } catch {
        // no local data
    }
    $<HTMLInputElement>("elevation-url").value = local ? "/data/zermatt-elevation.tif" : SAMPLE_ELEVATION;
    $<HTMLInputElement>("imagery-url").value = local ? "/data/zermatt-imagery.tif" : SAMPLE_IMAGERY;
})();
showOptions();

// Exposed for automated checks from the browser console.
Object.assign(window, {demo: {map, probeTerrain}});
