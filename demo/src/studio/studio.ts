// Shoelace (web components) and Chart.js are demo-only dependencies: the library itself stays dependency-light.
import "@shoelace-style/shoelace/dist/themes/dark.css";
import {setBasePath} from "@shoelace-style/shoelace/dist/utilities/base-path.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/color-picker/color-picker.js";
import type SlColorPicker from "@shoelace-style/shoelace/dist/components/color-picker/color-picker.js";
import "@shoelace-style/shoelace/dist/components/copy-button/copy-button.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/radio-button/radio-button.js";
import "@shoelace-style/shoelace/dist/components/radio-group/radio-group.js";
import "@shoelace-style/shoelace/dist/components/range/range.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/spinner/spinner.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import "@shoelace-style/shoelace/dist/components/textarea/textarea.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import type SlInput from "@shoelace-style/shoelace/dist/components/input/input.js";
import type SlRange from "@shoelace-style/shoelace/dist/components/range/range.js";
import type SlSelect from "@shoelace-style/shoelace/dist/components/select/select.js";
import type SlSwitch from "@shoelace-style/shoelace/dist/components/switch/switch.js";
import type SlTextarea from "@shoelace-style/shoelace/dist/components/textarea/textarea.js";
import type SlRadioGroup from "@shoelace-style/shoelace/dist/components/radio-group/radio-group.js";
import type SlIconButton from "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import {
    BarController, BarElement, Chart, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip,
    CategoryScale, type Plugin,
} from "chart.js";

import {WebGLMap} from "@luciad/ria/view/WebGLMap.js";
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import {createBounds, createPoint} from "@luciad/ria/shape/ShapeFactory.js";
import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
import {LocationMode} from "@luciad/ria/transformation/LocationMode.js";
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {LayerType} from "@luciad/ria/view/LayerType.js";
import {Layer} from "@luciad/ria/view/Layer.js";
import {FusionTileSetModel} from "@luciad/ria/model/tileset/FusionTileSetModel.js";
import {UrlTileSetModel} from "@luciad/ria/model/tileset/UrlTileSetModel.js";
import {SwipeController, SwipeLineOrientation} from "@luciad/ria/view/controller/SwipeController.js";
import {CompositeController} from "@luciad/ria/view/controller/CompositeController.js";
import {NavigateController} from "@luciad/ria/view/controller/NavigateController.js";
import type {PerspectiveCamera} from "@luciad/ria/view/camera/PerspectiveCamera.js";
import type {LayerTreeNode} from "@luciad/ria/view/LayerTreeNode.js";
import type {Handle} from "@luciad/ria/util/Evented.js";
import {FeatureLayer} from "@luciad/ria/view/feature/FeatureLayer.js";

import {
    compileExpression, compileStyle, cssGradient, expressionBands, isColorTable, resolveRamp, reverseRamp, sampleRamp, formatColor, parseColor,
    toExpressionNode, type BandStatistics, type BandStyle, type ColorMapSpec, type GeoTiffTileSetModel, type RampJSON,
    type StretchSpec,
} from "ria-geotiff";
// Optional ready-made content: the studio uses it, but the library itself draws any ramp or table it is given.
import {presetsFor, presetStyle, type StylePreset} from "ria-geotiff/presets";
import {ramp, RAMP_GROUPS, RAMPS, SCL_TABLE, type RampName} from "ria-geotiff/ramps";
import {isElevation, layerBounds} from "../layerControl.js";
import {fillStep, SCENES, type Scene} from "./scenes.js";
import {initOpenData} from "./openData.js";
import {code, trace, traceSync} from "./trace.js";

setBasePath("/shoelace");
Chart.register(BarController, BarElement, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);
Chart.defaults.color = "rgba(255,255,255,0.6)";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.font.size = 10;

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

// ------------------------------------------------------------------------------------------------ map

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{-y}/{x}";
const map = new WebGLMap("map", {reference: getReference("EPSG:4978")});
/** Layers the studio itself needs (basemap, terrain): listed, but not deletable. */
const studioLayers = new Set<LayerTreeNode>();
const wgs84 = getReference("EPSG:4979");
const crs84 = getReference("CRS:84");
const toWgs84 = createTransformation(map.reference, wgs84);
let terrainLayer: RasterTileSetLayer | null = null;

{
    const webMercator = getReference("EPSG:3857");
    const r = 20037508.342789244;
    const basemap = new UrlTileSetModel({
        baseURL: ESRI_IMAGERY,
        structure: {reference: webMercator, bounds: createBounds(webMercator, [-r, 2 * r, -r, 2 * r]),
            level0Columns: 1, level0Rows: 1, tileWidth: 256, tileHeight: 256, levelCount: 20},
    });
    const base = new RasterTileSetLayer(basemap, {label: "Esri World Imagery", layerType: LayerType.BASE});
    studioLayers.add(base);
    map.layerTree.addChild(base, "bottom");
    FusionTileSetModel.createFromURL("https://sampleservices.luciad.com/lts", "world_elevation_6714a770-860b-4878-90c9-ab386a4bae0f")
        .then((model) => {
            terrainLayer = new RasterTileSetLayer(model, {label: "Terrain", visible: $<SlSwitch>("terrain").checked});
            studioLayers.add(terrainLayer);
            // Keep the switch in step when the terrain is shown or hidden elsewhere (the Layers list).
            terrainLayer.on("VisibilityChanged", (visible: boolean) => { $<SlSwitch>("terrain").checked = visible; });
            map.layerTree.addChild(terrainLayer, "above", base);
        })
        .catch((e) => console.warn("terrain unavailable", e));
}

// ------------------------------------------------------------------------------------------------ state

/**
 * A layer the studio opened (from the Gallery or Add a layer), with the style state it had when it was last the
 * current layer. Layers accumulate on the map; the styling area edits the current one.
 */
interface Entry {
    scene: Scene;
    model: GeoTiffTileSetModel;
    layer: RasterTileSetLayer;
    /** Terrain: shown, but without a style. */
    elevation: boolean;
    style: BandStyle | null;
    template: Partial<Record<"band" | "expression" | "red" | "green" | "blue", unknown>> | null;
    step: number;
}
const entries = new Map<LayerTreeNode, Entry>();
/** The layer clicked last in the layer list (an entry, or a layer the studio does not style). */
let currentNode: LayerTreeNode | null = null;

let scene: Scene = SCENES[0];
/** The model and layer of the current entry; null when the current layer has no style (or there is none). */
let model: GeoTiffTileSetModel | null = null;
let layer: RasterTileSetLayer | null = null;
let twinLayer: RasterTileSetLayer | null = null;
let style: BandStyle = {render: {type: "rgb", red: "red", green: "green", blue: "blue"}};
let loadToken = 0;

function setLoading(text: string | null) {
    $("loading").classList.toggle("visible", text !== null);
    if (text) $("loading-text").textContent = text;
}

function toast(message: string) {
    setLoading(null);
    const el = $("loading");
    el.classList.add("visible");
    $("loading-text").textContent = message;
    el.querySelector("sl-spinner")!.toggleAttribute("hidden", true);
    setTimeout(() => { el.classList.remove("visible"); el.querySelector("sl-spinner")!.toggleAttribute("hidden", false); }, 6000);
}

// ------------------------------------------------------------------------------------------------ scenes

function initScenes() {
    const select = $<SlSelect>("scene");
    let group = "";
    for (const s of SCENES) {
        if (s.group !== group) {
            group = s.group;
            const small = document.createElement("small");
            small.textContent = group;
            select.append(small);
        }
        const option = document.createElement("sl-option");
        option.value = s.id;
        option.textContent = `${s.title} — ${s.subtitle.split(" · ")[0]}`;
        select.append(option);
    }
    // No scene is chosen at start (the placeholder shows): picking one adds it.
    select.addEventListener("sl-change", () => {
        const chosen = SCENES.find((s) => s.id === select.value);
        if (chosen && chosen !== currentEntry()?.scene) void loadScene(chosen);
    });
}

const currentEntry = () => (currentNode ? entries.get(currentNode) ?? null : null);

/**
 * Adds a scene's layer on top of the others and makes it the current layer (choosing a scene that is already on
 * the map selects its layer instead). With `rethrow`, errors are thrown after the toast (Add a layer shows them).
 */
async function loadScene(next: Scene, rethrow = false) {
    const existing = [...entries.values()].find((e) => e.scene === next);
    if (existing) {
        await activate(existing.layer);
        await flyTo(next, existing.model).catch(() => undefined);
        return;
    }
    const token = ++loadToken;
    setLoading(`Opening ${next.title}: reading COG headers…`);
    try {
        const created = await next.create();
        created.addReadErrorListener((e) => console.warn(e.message));
        const added = traceSync("4 Layer", `const layer = new RasterTileSetLayer(model, ${code({label: next.title})})`,
            () => new RasterTileSetLayer(created, {label: next.title}));
        const entry: Entry = {scene: next, model: created, layer: added, elevation: created.isElevation,
            style: null, template: null, step: next.timeSeries?.initial ?? 0};
        entries.set(added, entry);
        traceSync("4 Layer", 'map.layerTree.addChild(layer, "top")', () => map.layerTree.addChild(added, "top"));
        // LuciadRIA draws one terrain: a new one replaces the others (they stay in the list, switched off).
        if (created.isElevation) for (const other of map.layerTree.children) if (other !== added && isElevation(other)) other.visible = false;
        if (token !== loadToken) return;   // a later scene was chosen meanwhile: keep this layer, do not select it
        // A later fly-to (another layer) aborts this one: not an error.
        await flyTo(next, created).catch(() => undefined);
        if (token !== loadToken) return;
        await activate(added);
    } catch (e) {
        console.error(e);
        toast(`Could not open ${next.title}: ${(e as Error).message}`);
        if (rethrow) throw e;
    } finally {
        if (token === loadToken) setLoading(null);
    }
}

/** Keeps the style state of the current entry, before another layer becomes current. */
function saveCurrent() {
    const entry = currentEntry();
    if (!entry || entry.elevation || !model) return;
    entry.style = style;
    entry.template = template;
    entry.step = step;
}

function styleNote(text: string | null) {
    $("style-note").hidden = !text;
    $("style-note").textContent = text ?? "";
    $("tabs").hidden = !!text;
    $("insight").hidden = !!text;
}

/** Makes a layer the current one: the styling area, legend, time slider and swipe then work on it. */
let activation = 0;
async function activate(node: LayerTreeNode | null) {
    const mine = ++activation;
    saveCurrent();
    stopPlaying();
    currentNode = node;
    if (mine !== activation) return;
    const entry = currentEntry();
    model = entry && !entry.elevation ? entry.model : null;
    layer = entry && !entry.elevation ? entry.layer : null;
    renderLayerList();
    if (entry) {
        scene = entry.scene;
        if ($<SlSelect>("scene").value !== scene.id) $<SlSelect>("scene").value = scene.id;
    }
    renderLayerInfo();
    if (!model || !entry) {
        $("timebar").classList.remove("visible");
        styleNote(!node ? "No layer to style: add one with Add a layer, or pick a scene in the Gallery."
            : entry?.elevation || isElevation(node) ? `${node.label} is a terrain (elevation) layer: it has heights, not a style.`
                : `${node.label} is not a GeoTIFF layer of the studio: it has no style here.`);
        return;
    }
    styleNote(null);
    initBandControls();
    step = entry.step;
    setupTimebar();
    if (entry.style) {
        style = entry.style;
        template = entry.template;
        $<SlSelect>("preset").value = "";
    } else if (typeof scene.start === "string") {
        choosePreset(scene.start);
    } else {
        template = null;
        style = structuredClone(scene.start);
        $<SlSelect>("preset").value = "";
    }
    if (!entry.style) await focusStatistics(scene);
    if (mine !== activation) return;
    await applyStyle(true);
    if (mine !== activation) return;
}

/**
 * The description at the top of the Active layer panel (bottom left), above the style of that layer.
 * Empty when there is no current layer: the style note then says how to add one.
 */
function renderLayerInfo() {
    const body = $("layer-info-body");
    body.replaceChildren();
    if (!currentNode) return;
    const entry = currentEntry();
    const el = (tag: string, className: string, text: string) => Object.assign(document.createElement(tag), {className, textContent: text});
    if (!entry) {   // basemap, terrain, vector: the style note below says why there is no style
        body.append(el("h2", "", currentNode.label));
        return;
    }
    const s = entry.scene;
    const more = document.createElement("div");
    more.className = "info-more";
    more.append(el("p", "", s.story));
    if (s.details) more.append(el("div", "details", s.details));
    body.append(el("h2", "", s.title), el("div", "sub", s.subtitle), more);
    $("credits").textContent = `${s.credit} Basemap: Esri, Maxar, Earthstar Geographics. Terrain: LuciadFusion sample service.`;
}

function initLayerInfo() {
    const panel = $("layer-info");
    const toggle = $<SlIconButton>("layer-info-toggle");
    toggle.addEventListener("click", () => {
        const collapsed = panel.classList.toggle("collapsed");
        toggle.name = collapsed ? "chevron-up" : "chevron-down";
        toggle.label = collapsed ? "Show the description" : "Hide the description";
    });
}

// ------------------------------------------------------------------------------------------------ layers

/** The layer list: top layer first, visibility, current layer, order, zoom and delete. */
function renderLayerList() {
    const box = $("layers");
    box.replaceChildren();
    if ($<SlSwitch>("swipe").checked) fillSwipeChoices();
    const nodes = [...map.layerTree.children].reverse().filter((n) => n !== twinLayer);
    const button = (name: string, label: string, onClick: () => void, disabled = false) => {
        const b = document.createElement("sl-icon-button") as SlIconButton;
        Object.assign(b, {name, label, disabled});
        b.title = label;
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
    };
    nodes.forEach((node, i) => {
        const row = document.createElement("div");
        row.className = `layer-row${node === currentNode ? " current" : ""}`;
        const visible = document.createElement("input");
        visible.type = "checkbox";
        visible.checked = node.visible;
        visible.title = `Show ${node.label}`;
        visible.addEventListener("change", () => {
            if (visible.checked && isElevation(node)) {
                // LuciadRIA shows one elevation layer: switch the other ones off instead of hiding one silently.
                for (const other of map.layerTree.children) if (other !== node && isElevation(other)) other.visible = false;
            }
            traceSync("4 Layer", `layer.visible = ${visible.checked}; // ${node.label}`, () => { node.visible = visible.checked; });
        });
        const name = document.createElement("span");
        name.className = "name";
        name.title = `${node.label}: click to make it the current layer`;
        if (isElevation(node)) name.append(Object.assign(document.createElement("span"), {className: "kind", textContent: "terrain"}));
        else if (node instanceof FeatureLayer) name.append(Object.assign(document.createElement("span"), {className: "kind", textContent: "vector"}));
        name.append(document.createTextNode(node.label));
        name.addEventListener("click", () => void activate(node));
        const bounds = layerBounds(node);
        // Up and down in drawing order (the list shows the top layer first).
        const up = button("arrow-up", "Draw above the layer above", () => traceSync("4 Layer",
            `map.layerTree.moveChild(layer, "above", other); // ${node.label} above ${nodes[i - 1]?.label}`, () => map.layerTree.moveChild(node, "above", nodes[i - 1])), i === 0);
        const down = button("arrow-down", "Draw below the layer below", () => traceSync("4 Layer",
            `map.layerTree.moveChild(layer, "below", other); // ${node.label} below ${nodes[i + 1]?.label}`, () => map.layerTree.moveChild(node, "below", nodes[i + 1])), i === nodes.length - 1);
        const zoom = button("zoom-in", `Zoom to ${node.label}`, () => {
            if (bounds) void trace("4 Layer", `await map.mapNavigator.fit({bounds: layer.model.bounds, animate: true}); // ${node.label}`,
                () => map.mapNavigator.fit({bounds, animate: {duration: 1200}}));
        }, !bounds || (node as {type?: LayerType}).type === LayerType.BASE);
        const remove = button("trash", studioLayers.has(node) ? "The studio needs this layer" : `Remove ${node.label}`,
            () => traceSync("4 Layer", `map.layerTree.removeChild(layer); // ${node.label}`, () => map.layerTree.removeChild(node)), studioLayers.has(node));
        row.append(visible, name, up, down, zoom, remove);
        box.append(row);
    });
}

const nodeHandles = new Map<LayerTreeNode, Handle[]>();
function watchNode(node: LayerTreeNode) {
    nodeHandles.set(node, [node.on("VisibilityChanged", renderLayerList), node.on("LabelChanged", renderLayerList)]);
}
map.layerTree.on("NodeAdded", (e: { node: LayerTreeNode }) => { watchNode(e.node); renderLayerList(); });
map.layerTree.on("NodeMoved", () => renderLayerList());
map.layerTree.on("NodeRemoved", (e: { node: LayerTreeNode }) => {
    nodeHandles.get(e.node)?.forEach((h) => h.remove());
    nodeHandles.delete(e.node);
    const removed = entries.get(e.node);
    entries.delete(e.node);
    if (swipe && (e.node.id === swipeChoice.left || e.node.id === swipeChoice.right)) void enableSwipe(true);
    // Free the caches of a removed model (the swipe twin shares them and is disposed with its own layer).
    if (removed) traceSync("4 Layer", `model.dispose(); // ${e.node.label}`, () => removed.model.dispose());
    if (removed && removed.layer === layer) { model = null; layer = null; }
    if (e.node === currentNode) {
        // The current layer went away: the top remaining studio layer becomes current.
        const next = [...map.layerTree.children].reverse().find((n) => entries.has(n)) ?? null;
        currentNode = null;
        void activate(next);
    } else {
        renderLayerList();
    }
});
for (const node of map.layerTree.children) watchNode(node);

/**
 * Statistics (and so percentile and standard-deviation stretches) over the scene's place of interest rather than
 * the whole file: a Sentinel-2 tile is 110 km wide, the place usually a few km.
 */
async function focusStatistics(s: Scene) {
    if (!model || !s.view.bbox) return;
    const [w, south, e, n] = s.view.bbox;
    const toModel = createTransformation(crs84, model.reference);
    const corners = [[w, south], [e, south], [e, n], [w, n]].map(([x, y]) => toModel.transform(createPoint(crs84, [x, y])));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    await model.computeStatistics([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

async function flyTo(s: Scene, target: GeoTiffTileSetModel | null = model) {
    if (!s.view.bbox) {
        if (!target) return;
        const [x0, y0, x1, y1] = target.getDataExtent();
        await map.mapNavigator.fit({bounds: createBounds(target.reference, [x0, x1 - x0, y0, y1 - y0]), animate: {duration: 1600}});
        return;
    }
    const [w, south, e, n] = s.view.bbox;
    await map.mapNavigator.fit({bounds: createBounds(crs84, [w, e - w, south, n - south]), animate: {duration: 1600}});
    if (s.view.oblique && $<SlSwitch>("terrain").checked) {
        const {yaw, pitch, distance, height = 1500} = s.view.oblique;
        const target = createTransformation(wgs84, map.reference).transform(createPoint(wgs84, [(w + e) / 2, (south + n) / 2, height]));
        map.camera = (map.camera as PerspectiveCamera).lookAt({ref: target, distance, yaw, pitch, roll: 0});
    }
}

// ------------------------------------------------------------------------------------------------ controls

const isIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

function initBandControls() {
    const bands = model!.getBandNames();
    for (const id of ["red", "green", "blue"]) {
        const select = $<SlSelect>(id);
        select.replaceChildren(...bands.map((b) => Object.assign(document.createElement("sl-option"), {value: b, textContent: b})));
    }
    // Presets that fit the bands, grouped.
    const preset = $<SlSelect>("preset");
    preset.replaceChildren();
    const groups: Record<string, string> = {composite: "Band combinations", index: "Spectral indices", classes: "Classes"};
    const available = presetsFor(bands);
    if (scene.presets?.length) {
        preset.append(Object.assign(document.createElement("small"), {textContent: "This scene"}));
        for (const p of scene.presets) preset.append(Object.assign(document.createElement("sl-option"), {value: p.id, textContent: p.name}));
    }
    for (const group of Object.keys(groups)) {
        const items = available.filter((p) => p.group === group);
        if (!items.length) continue;
        preset.append(Object.assign(document.createElement("small"), {textContent: groups[group]}));
        for (const p of items) preset.append(Object.assign(document.createElement("sl-option"), {value: p.id, textContent: p.name}));
    }
    // Band chips for the expression editor.
    const chips = $("band-chips");
    chips.replaceChildren(...bands.map((b) => {
        const tag = document.createElement("sl-tag");
        tag.size = "small";
        tag.textContent = b;
        tag.addEventListener("click", () => insertIntoExpression(b));
        return tag;
    }));
    $<SlSwitch>("mask").disabled = !scene.mask;
    $("mask-hint").textContent = scene.mask
        ? (scene.mask.band === "scl" ? "Sentinel-2 Scene Classification: hides no data, saturated, cloud shadow, cloud and cirrus classes."
            : "Landsat QA_PIXEL bits 0–4: fill, dilated cloud, cirrus, cloud, cloud shadow.")
        : "No quality band in this dataset.";
}

function insertIntoExpression(text: string) {
    const input = $<SlInput>("expression");
    const native = input.shadowRoot?.querySelector("input");
    const value = input.value;
    const at = native?.selectionStart ?? value.length;
    input.value = value.slice(0, at) + text + value.slice(native?.selectionEnd ?? at);
    input.focus();
    validateExpression();
}

function initColorMaps() {
    const select = $<SlSelect>("colormap");
    const option = (value: string, label: string, gradient: string) => {
        const o = document.createElement("sl-option");
        o.value = value;
        const swatch = document.createElement("span");
        swatch.slot = "suffix";
        swatch.className = "ramp-swatch";
        swatch.style.background = gradient;
        o.append(document.createTextNode(label), swatch);
        return o;
    };
    select.append(option("__current", "Current (edited or from the preset)", "linear-gradient(90deg,#666,#999)"));
    for (const [group, names] of Object.entries(RAMP_GROUPS)) {
        select.append(Object.assign(document.createElement("small"), {textContent: group}));
        for (const name of names) select.append(option(name, name, cssGradient(RAMPS[name])));
    }
}

// ------------------------------------------------------------------------------------------------ colour editor

function currentColorMap(): ColorMapSpec | null {
    const r = style.render;
    return r.type === "pseudocolor" && r.colorMap && typeof r.colorMap === "object" ? r.colorMap : null;
}

function currentRamp(): RampJSON | null {
    const cm = currentColorMap();
    return cm && !isColorTable(cm) ? cm : null;
}

function setColorMap(colorMap: ColorMapSpec) {
    if (style.render.type !== "pseudocolor") return;
    style = {...style, render: {...style.render, colorMap}};
    renderColorEditor();
    void applyStyle();
}

/** One row per ramp stop (colour with opacity, value in data units) or table entry (colour, label). */
function renderColorEditor() {
    const editor = $("ramp-editor");
    editor.replaceChildren();
    const cm = currentColorMap();
    const isTable = !!cm && isColorTable(cm);
    for (const id of ["reverse", "blend", "add-stop"]) $<SlIconButton>(id).disabled = isTable || !cm;
    $("ramp-preview").style.background = cm && !isColorTable(cm) ? cssGradient(cm) : "transparent";
    const select = $<SlSelect>("colormap");
    select.disabled = isTable;
    const preset = cm && !isColorTable(cm) ? cm.preset : undefined;
    const pristine = preset && preset in RAMPS && JSON.stringify(RAMPS[preset as RampName].stops) === JSON.stringify(cm && !isColorTable(cm) ? cm.stops : null);
    select.value = pristine ? preset : "__current";
    if (!cm) return;

    const picker = (color: string, onChange: (c: string) => void) => {
        const p = document.createElement("sl-color-picker") as SlColorPicker;
        Object.assign(p, {size: "small", opacity: true, hoist: true, value: color, format: "hex", noFormatToggle: true});
        p.addEventListener("sl-change", () => {
            const rgba = parseColor(p.getFormattedValue("hexa"));
            if (rgba) onChange(formatColor(rgba)); // #rrggbb when opaque, rgba() otherwise
        });
        return p;
    };
    if (isColorTable(cm)) {
        cm.entries.forEach((entry, i) => {
            const row = document.createElement("div");
            row.className = "stop-row";
            const label = Object.assign(document.createElement("span"), {className: "label", textContent: `${entry.value} · ${entry.label ?? ""}`});
            row.append(picker(entry.color, (c) => {
                const entries = cm.entries.map((e, k) => (k === i ? {...e, color: c} : e));
                setColorMap({...cm, entries});
            }), label, document.createElement("span"));
            editor.append(row);
        });
        return;
    }
    const range = model?.getResolvedStretches()[0] ?? {min: 0, max: 1};
    const resolved = resolveRamp(cm);
    const stops = resolved.stops.map((s) => ({position: s.position, color: s.css, ...(s.label ? {label: s.label} : {})}));
    const commit = (next: typeof stops) => setColorMap({...cm, spacing: "custom", stops: next.sort((a, b) => a.position - b.position)});
    stops.forEach((stop, i) => {
        const row = document.createElement("div");
        row.className = "stop-row";
        const value = document.createElement("sl-input") as SlInput;
        const span = range.max - range.min;
        Object.assign(value, {size: "small", type: "number", value: String(Number((range.min + stop.position * span).toPrecision(4))),
            step: String(Number((span / 100).toPrecision(1))), disabled: resolved.blend === "stepped" && i === 0});
        value.title = `${stop.label ? `${stop.label} · ` : ""}position ${stop.position.toFixed(3)}`;
        value.addEventListener("sl-change", () => {
            const v = Number(value.value);
            if (!Number.isFinite(v)) return;
            commit(stops.map((s, k) => (k === i ? {...s, position: Math.min(1, Math.max(0, (v - range.min) / (span || 1)))} : s)));
        });
        const remove = document.createElement("sl-icon-button") as SlIconButton;
        Object.assign(remove, {name: "trash", label: "Remove stop", disabled: stops.length <= 2});
        remove.addEventListener("click", () => commit(stops.filter((_, k) => k !== i)));
        row.append(picker(stop.color, (c) => commit(stops.map((s, k) => (k === i ? {...s, color: c} : s)))), value, remove);
        editor.append(row);
    });
}

function selectedPreset(): StylePreset | undefined {
    const id = $<SlSelect>("preset").value;
    return scene.presets?.find((p) => p.id === id) ?? presetsFor(model?.getBandNames() ?? []).find((p) => p.id === id);
}

/** Applies a preset of the scene (with its time placeholder) or of the library. */
function choosePreset(id: string) {
    const mask = $<SlSwitch>("mask").checked && scene.mask ? scene.mask : undefined;
    const own = scene.presets?.find((p) => p.id === id);
    if (own) {
        template = sourcesOf(own.style.render);
        style = fillStep(structuredClone(own.style), currentStep());
        if (mask) style.mask = [mask];
    } else {
        template = null;
        style = presetStyle(id, mask);
    }
    $<SlSelect>("preset").value = id;
}

/** Writes the style into the controls. */
function syncControls() {
    const r = style.render;
    $<SlRadioGroup>("mode").value = r.type;
    $("rgb-controls").hidden = r.type !== "rgb";
    $("single-controls").hidden = r.type !== "pseudocolor";
    const channelBand = (c: unknown) => (typeof c === "string" ? c : (c as {band?: string})?.band ?? "");
    if (r.type === "rgb") {
        $<SlSelect>("red").value = channelBand(r.red);
        $<SlSelect>("green").value = channelBand(r.green);
        $<SlSelect>("blue").value = channelBand(r.blue);
        $<SlRange>("saturation").value = r.saturation ?? 1;
    } else if (r.type === "pseudocolor") {
        const expr = r.expression ?? r.band ?? "";
        $<SlInput>("expression").value = typeof expr === "string" ? expr : JSON.stringify(expr);
        validateExpression();
        renderColorEditor();
    }
    const isTable = r.type === "pseudocolor" && r.colorMap && typeof r.colorMap === "object" && isColorTable(r.colorMap);
    $("stretch-controls").hidden = !!isTable;
    $<SlRange>("gamma").value = r.type === "custom" ? 1 : r.gamma ?? 1;
    syncStretchControls();
    $<SlSwitch>("mask").checked = !!style.mask?.length;
    const preset = selectedPreset();
    $("preset-description").textContent = preset?.description ?? "";
}

function currentStretch(): StretchSpec | undefined {
    const r = style.render;
    return r.stretch;
}

function syncStretchControls() {
    const spec = currentStretch();
    const type = !spec ? "percentile" : Array.isArray(spec) ? "fixed" : spec.type;
    $<SlSelect>("stretch-type").value = type;
    const params = $("stretch-params");
    params.replaceChildren();
    const number = (id: string, label: string, value: number, step: number) => {
        const input = document.createElement("sl-input") as SlInput;
        Object.assign(input, {id, label, type: "number", size: "small", value: String(Number(value.toPrecision(4))), step: String(step)});
        input.addEventListener("sl-change", () => { readStretchControls(); void applyStyle(); });
        params.append(input);
    };
    if (type === "percentile") {
        const s = spec as {low?: number; high?: number} | undefined;
        number("p-low", "Low %", s?.low ?? 2, 0.5);
        number("p-high", "High %", s?.high ?? 98, 0.5);
    } else if (type === "stddev") {
        number("sd-n", "Std devs", (spec as {n?: number}).n ?? 2, 0.25);
    } else if (type === "fixed") {
        const resolved = model?.getResolvedStretches()[0];
        const [min, max] = Array.isArray(spec) ? spec : spec && !Array.isArray(spec) && spec.type === "fixed" ? [spec.min, spec.max] : [resolved?.min ?? 0, resolved?.max ?? 1];
        number("f-min", "Min", min, 0.01);
        number("f-max", "Max", max, 0.01);
    }
}

function readStretchControls() {
    const type = $<SlSelect>("stretch-type").value as string;
    const val = (id: string, fallback: number) => {
        const el = document.getElementById(id) as SlInput | null;
        const v = el ? Number(el.value) : NaN;
        return Number.isFinite(v) ? v : fallback;
    };
    let stretch: StretchSpec;
    if (type === "percentile") stretch = {type, low: val("p-low", 2), high: val("p-high", 98)};
    else if (type === "stddev") stretch = {type, n: val("sd-n", 2)};
    else if (type === "minmax") stretch = {type};
    else {
        const resolved = model?.getResolvedStretches()[0];
        stretch = [val("f-min", resolved?.min ?? 0), val("f-max", resolved?.max ?? 1)];
    }
    style.render.stretch = stretch;
}

/** Reads the controls into the style. */
function readControls(): boolean {
    const mode = $<SlRadioGroup>("mode").value;
    const gamma = Number($<SlRange>("gamma").value);
    const stretch = style.render.stretch;
    if (mode === "rgb") {
        style = {...style, render: {type: "rgb", red: $<SlSelect>("red").value as string, green: $<SlSelect>("green").value as string,
            blue: $<SlSelect>("blue").value as string, stretch, gamma, saturation: Number($<SlRange>("saturation").value)}};
    } else {
        const text = $<SlInput>("expression").value.trim();
        if (!validateExpression()) return false;
        const previous = style.render.type === "pseudocolor" ? style.render.colorMap : undefined;
        const colorMap = (previous && typeof previous === "object" ? previous : ramp("viridis")) as ColorMapSpec;
        style = {...style, render: {type: "pseudocolor", ...(isIdentifier(text) ? {band: text} : {expression: text}),
            stretch, gamma, colorMap}};
    }
    style.mask = $<SlSwitch>("mask").checked && scene.mask ? [scene.mask] : undefined;
    return true;
}

function validateExpression(): boolean {
    const status = $("expression-status");
    const text = $<SlInput>("expression").value.trim();
    if (!model) return false;
    if (!text) {
        status.className = "ok-text";
        status.textContent = "Type a band name or an expression, or click a band below.";
        return false;
    }
    try {
        compileExpression(text, model.getBandNames());
        const used = [...expressionBands(toExpressionNode(text))];
        const r = style.render;
        const applied = r.type === "pseudocolor" ? String(r.expression ?? r.band ?? "") : "";
        status.className = "ok-text";
        status.textContent = `✓ valid · reads ${used.length ? used.join(", ") : "no bands"}`
            + (text !== applied ? " · Enter or ✓ to apply" : "");
        return true;
    } catch (e) {
        status.className = "error-text";
        status.textContent = (e as Error).message;
        return false;
    }
}

let applying: Promise<void> = Promise.resolve();

/** Applies the style to the model, then refreshes the legend, histogram, JSON and twin. */
async function applyStyle(fromPreset = false) {
    if (!model) return;
    if (fromPreset) syncControls();
    const target = model;
    const pending = applying.then(async () => {
        setLoading("Computing statistics…");
        try {
            await trace("5 Style", `await model.setStyle(${code(style)})`, () => target.setStyle(style),
                () => ({legend: target.getLegend()?.kind, stretches: target.getResolvedStretches()}));
        } finally {
            setLoading(null);
        }
    });
    applying = pending.catch(() => undefined);
    try {
        await pending;
    } catch (e) {
        toast((e as Error).message);
        return;
    }
    if (target !== model) return;
    await target.requestStatistics(); // for the histogram, also with fixed stretches
    if (target !== model) return;
    syncStretchControlsIfFixed();
    renderLegend();
    renderHistogram();
    const json = JSON.stringify(style, null, 2);
    $<SlTextarea>("json-editor").value = json;
    $("json-copy").setAttribute("value", json);
}

function syncStretchControlsIfFixed() {
    if (Array.isArray(style.render.stretch)) syncStretchControls();
}

function wireControls() {
    $<SlSelect>("preset").addEventListener("sl-change", () => {
        const id = $<SlSelect>("preset").value as string;
        if (!id) return;
        choosePreset(id);
        void applyStyle(true);
    });
    $<SlRadioGroup>("mode").addEventListener("sl-change", () => {
        const mode = $<SlRadioGroup>("mode").value;
        $<SlSelect>("preset").value = "";
        template = null;
        if (mode === "pseudocolor" && style.render.type !== "pseudocolor") {
            const bands = model?.getBandNames() ?? [];
            const expr = bands.includes("nir") && bands.includes("red") ? "(nir - red) / (nir + red)" : bands[0];
            style = {mask: style.mask, render: {type: "pseudocolor", ...(isIdentifier(expr) ? {band: expr} : {expression: expr}),
                stretch: {type: "percentile", low: 2, high: 98}, colorMap: ramp("viridis")}};
        } else if (mode === "rgb" && style.render.type !== "rgb") {
            const b = model?.getBandNames() ?? [];
            const pick = (name: string, i: number) => (b.includes(name) ? name : b[Math.min(i, b.length - 1)]);
            style = {mask: style.mask, render: {type: "rgb", red: pick("red", 0), green: pick("green", 1), blue: pick("blue", 2),
                stretch: {type: "percentile", low: 1, high: 99}, gamma: 1.2}};
        }
        void applyStyle(true);
    });
    for (const id of ["red", "green", "blue"]) {
        $(id).addEventListener("sl-change", () => {
            $<SlSelect>("preset").value = "";
            template = null;
            if (readControls()) { followStepOfStyle(); void applyStyle(); }
        });
    }
    $("mask").addEventListener("sl-change", () => { if (readControls()) void applyStyle(); });
    $<SlSelect>("colormap").addEventListener("sl-change", () => {
        const name = $<SlSelect>("colormap").value as string;
        if (name === "__current" || style.render.type !== "pseudocolor") return;
        setColorMap(ramp(name as RampName));
    });
    $("reverse").addEventListener("click", () => { const r = currentRamp(); if (r) setColorMap(reverseRamp(r)); });
    $("blend").addEventListener("click", () => {
        const r = currentRamp();
        if (r) setColorMap({...r, spacing: "custom", stops: resolveRamp(r).stops.map((s) => ({position: s.position, color: s.css, ...(s.label ? {label: s.label} : {})})),
            blend: r.blend === "stepped" ? "smooth" : "stepped"});
    });
    $("add-stop").addEventListener("click", () => {
        const r = currentRamp();
        if (!r) return;
        // A new stop halfway into the widest gap, in the colour already drawn there: the ramp looks unchanged.
        const resolved = resolveRamp(r);
        const stops = resolved.stops.map((s) => ({position: s.position, color: s.css, ...(s.label ? {label: s.label} : {})}));
        let gap = 0, at = 0.5;
        for (let i = 1; i < stops.length; i++) {
            if (stops[i].position - stops[i - 1].position > gap) { gap = stops[i].position - stops[i - 1].position; at = (stops[i].position + stops[i - 1].position) / 2; }
        }
        stops.push({position: at, color: formatColor(sampleRamp(resolved, at))});
        setColorMap({...r, spacing: "custom", stops: stops.sort((a, b) => a.position - b.position)});
    });
    for (const id of ["gamma", "saturation"]) $(id).addEventListener("sl-change", () => { if (readControls()) void applyStyle(); });
    // The expression applies on Enter or the ✓ button; ✕ clears the field. Typing only validates.
    const applyExpression = () => {
        if (!validateExpression()) return;
        $<SlSelect>("preset").value = "";
        template = null;
        if (!readControls()) return;
        followStepOfStyle();
        validateExpression(); // the status no longer says "to apply"
        void applyStyle();
    };
    const expression = $<SlInput>("expression");
    expression.addEventListener("sl-input", () => validateExpression());
    expression.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") applyExpression(); });
    expression.addEventListener("sl-clear", () => { validateExpression(); expression.focus(); });
    $("expression-apply").addEventListener("click", applyExpression);
    $<SlSelect>("stretch-type").addEventListener("sl-change", () => {
        const type = $<SlSelect>("stretch-type").value as string;
        const resolved = model?.getResolvedStretches()[0];
        style.render.stretch = type === "fixed" ? [resolved?.min ?? 0, resolved?.max ?? 1] : type === "percentile" ? {type, low: 2, high: 98}
            : type === "stddev" ? {type, n: 2} : {type: "minmax"};
        syncStretchControls();
        void applyStyle();
    });
    $("stretch-view").addEventListener("click", () => void stretchToView());
    $("stretch-scene").addEventListener("click", async () => {
        if (!model) return;
        setLoading("Statistics of the whole scene…");
        try { await model.computeStatistics(); } finally { setLoading(null); }
        renderLegend(); renderHistogram();
    });
    $("json-apply").addEventListener("click", () => {
        const status = $("json-status");
        try {
            style = JSON.parse($<SlTextarea>("json-editor").value) as BandStyle;
            $<SlSelect>("preset").value = "";
            status.className = "ok-text"; status.textContent = "Applied.";
            void applyStyle(true);
        } catch (e) {
            status.className = "error-text"; status.textContent = (e as Error).message;
        }
    });
    $<SlSwitch>("terrain").addEventListener("sl-change", () => { if (terrainLayer) terrainLayer.visible = $<SlSwitch>("terrain").checked; });
    $<SlSwitch>("swipe").addEventListener("sl-change", () => void enableSwipe($<SlSwitch>("swipe").checked));
    $("swipe-left").addEventListener("sl-change", () => {
        swipeChoice.left = $<SlSelect>("swipe-left").value as string;
        if ($<SlSwitch>("swipe").checked) void enableSwipe(true);
    });
    $("swipe-right").addEventListener("sl-change", () => {
        swipeChoice.right = $<SlSelect>("swipe-right").value as string;
        if ($<SlSwitch>("swipe").checked) void enableSwipe(true);
    });
    $("inspector-close").addEventListener("click", () => $("inspector").classList.remove("visible"));
}

// ------------------------------------------------------------------------------------------------ stretch to view

/** The view's extent in longitude/latitude (sampled at a grid of view points), or null when it shows no ground. */
function viewBoundsLonLat(): [number, number, number, number] | null {
    const viewToMap = map.getViewToMapTransformation(LocationMode.TERRAIN);
    const [w, h] = map.viewSize;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i <= 6; i++) {
        for (let j = 0; j <= 6; j++) {
            try {
                const p = toWgs84.transform(viewToMap.transform(createPoint(null, [420 + (i / 6) * Math.max(1, w - 780), 20 + (j / 6) * Math.max(1, h - 40)])));
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            } catch {
                // sky
            }
        }
    }
    return minX < maxX ? [minX, minY, maxX, maxY] : null;
}

/** Bounds of what the view shows, in the model's reference (sampled at a grid of view points). */
function viewBoundsInModel(): [number, number, number, number] | null {
    if (!model) return null;
    const toModel = createTransformation(map.reference, model.reference);
    const viewToMap = map.getViewToMapTransformation(LocationMode.TERRAIN);
    const [w, h] = map.viewSize;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i <= 6; i++) {
        for (let j = 0; j <= 6; j++) {
            try {
                const p = toModel.transform(viewToMap.transform(createPoint(null, [420 + (i / 6) * (w - 780), 20 + (j / 6) * (h - 40)])));
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            } catch {
                // sky or outside the projection
            }
        }
    }
    return minX < maxX ? [minX, minY, maxX, maxY] : null;
}

async function stretchToView() {
    if (!model) return;
    const bounds = viewBoundsInModel();
    if (!bounds) return toast("The view does not show the scene.");
    setLoading("Statistics of the view…");
    try {
        await model.computeStatistics(bounds);
    } finally {
        setLoading(null);
    }
    renderLegend();
    renderHistogram();
}

// ------------------------------------------------------------------------------------------------ legend & histogram

function fmt(v: number): string {
    if (!Number.isFinite(v)) return "–";
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.01 || a === 0 ? v.toFixed(3) : v.toExponential(1);
}

function renderLegend() {
    const legend = model?.getLegend();
    if (!legend) return;
    const el = $("legend");
    el.replaceChildren();
    $("legend-title").textContent = legend.kind === "rgb" ? "RGB composite" : legend.title ?? "";
    if (legend.kind === "ramp") {
        const ramp = document.createElement("div");
        ramp.className = "ramp";
        ramp.style.background = legend.gradient;
        const labels = document.createElement("div");
        labels.className = "ramp-labels";
        const unit = scene.timeSeries?.unit ?? "";
        const mid = (legend.min + legend.max) / 2;
        labels.innerHTML = `<span>${fmt(legend.min)}${unit}</span><span>${fmt(mid)}${unit}</span><span>${fmt(legend.max)}${unit}</span>`;
        el.append(ramp, labels);
        if (legend.blend === "stepped") {
            // Class breaks: each stop starts a class running to the next one.
            const box = document.createElement("div");
            box.className = "classes";
            box.style.marginTop = "8px";
            legend.stops.forEach((stop, i) => {
                const to = legend.stops[i + 1]?.value ?? legend.max;
                const row = document.createElement("div");
                const sw = document.createElement("i");
                sw.style.background = stop.color;
                row.append(sw, document.createTextNode(stop.label ?? `${fmt(stop.value)} – ${fmt(to)}${unit}`));
                box.append(row);
            });
            el.append(box);
        }
    } else if (legend.kind === "classes") {
        const box = document.createElement("div");
        box.className = "classes";
        for (const e of legend.entries) {
            const row = document.createElement("div");
            const sw = document.createElement("i");
            sw.style.background = e.color;
            row.append(sw, document.createTextNode(e.label));
            box.append(row);
        }
        el.append(box);
    } else if (legend.kind === "rgb") {
        const box = document.createElement("div");
        box.className = "rgb-legend";
        const colors = ["#f87171", "#4ade80", "#60a5fa"];
        legend.channels.forEach((c, i) => {
            box.insertAdjacentHTML("beforeend", `<span style="color:${colors[i]}">●</span><span>${c.source}</span><span>${fmt(c.min)} – ${fmt(c.max)}</span>`);
        });
        el.append(box);
    }
    $("histogram-wrap").hidden = legend.kind === "classes";
}

let histogramChart: Chart | null = null;
let stretchLines: { min: number; max: number; color: string }[] = [];

const stretchLinePlugin: Plugin = {
    id: "stretchLines",
    afterDatasetsDraw(chart) {
        const {ctx, chartArea, scales} = chart;
        ctx.save();
        for (const line of stretchLines) {
            for (const v of [line.min, line.max]) {
                const x = scales.x.getPixelForValue(v);
                if (x < chartArea.left - 1 || x > chartArea.right + 1) continue;
                ctx.strokeStyle = line.color;
                ctx.setLineDash([4, 3]);
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(x, chartArea.top);
                ctx.lineTo(x, chartArea.bottom);
                ctx.stroke();
            }
        }
        ctx.restore();
    },
};

function histogramPoints(stats: BandStatistics, bins = 64) {
    const {min, max, counts} = stats.histogram;
    const group = Math.max(1, Math.floor(counts.length / bins));
    const width = (max - min) / counts.length;
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < counts.length; i += group) {
        let sum = 0;
        for (let k = i; k < Math.min(i + group, counts.length); k++) sum += counts[k];
        points.push({x: min + (i + group / 2) * width, y: sum});
    }
    return points;
}

function renderHistogram() {
    if (!model) return;
    const stats = model.getStatistics();
    const ranges = model.getResolvedStretches();
    const isRgb = style.render.type === "rgb";
    const colors = isRgb ? ["#f87171", "#4ade80", "#60a5fa"] : ["#7dd3fc"];
    const datasets = stats.slice(0, colors.length).map((s, i) => ({
        label: model!.getStyle()?.render.type === "rgb" ? ["R", "G", "B"][i] : "values",
        data: s ? histogramPoints(s) : [],
        borderColor: colors[i],
        backgroundColor: isRgb ? colors[i] + "22" : colors[i] + "88",
        fill: isRgb,
        borderWidth: isRgb ? 1.2 : 0,
        pointRadius: 0,
        tension: 0.25,
        type: (isRgb ? "line" : "bar") as "line",
        barPercentage: 1, categoryPercentage: 1,
    }));
    $("histogram-unit").textContent = `x: ${scene.timeSeries ? scene.timeSeries.unit : "pixel value"} · dashed: stretch`;
    stretchLines = ranges.slice(0, colors.length).map((r, i) => ({min: r.min, max: r.max, color: isRgb ? colors[i] : "#fde68a"}));
    const valid = stats.filter((s): s is BandStatistics => !!s);
    const xMin = Math.min(...valid.map((s) => s.histogram.min), ...stretchLines.map((l) => l.min));
    const xMax = Math.max(...valid.map((s) => s.histogram.max), ...stretchLines.map((l) => l.max));
    if (!histogramChart) {
        histogramChart = new Chart($<HTMLCanvasElement>("histogram"), {
            type: "bar",
            data: {datasets},
            options: {
                animation: false, responsive: true, maintainAspectRatio: false,
                plugins: {tooltip: {enabled: false}},
                scales: {
                    x: {type: "linear", ticks: {maxTicksLimit: 5, callback: (v) => fmt(Number(v))}, grid: {display: false}},
                    y: {display: false, beginAtZero: true},
                },
            },
            plugins: [stretchLinePlugin],
        });
    } else {
        histogramChart.data.datasets = datasets;
    }
    if (valid.length) {
        histogramChart.options.scales!.x!.min = xMin;
        histogramChart.options.scales!.x!.max = xMax;
    }
    histogramChart.update();
}

// ------------------------------------------------------------------------------------------------ inspector

let profileChart: Chart | null = null;

async function inspect(viewX: number, viewY: number) {
    if (!model) return;
    let world;
    try {
        world = map.getViewToMapTransformation(LocationMode.TERRAIN).transform(createPoint(null, [viewX, viewY]));
    } catch {
        return;
    }
    const p = createTransformation(map.reference, model.reference).transform(world);
    const geo = toWgs84.transform(world);
    // Time series: only the bands the style reads, at every step; otherwise every band (spectral profile).
    let wanted: string[] | undefined;
    if (scene.timeSeries) {
        const names = model.getBandNames();
        wanted = [...new Set(scene.timeSeries.steps.flatMap((t) => {
            try { return compileStyle(styleAtStep(t), names).requiredBands; } catch { return []; }
        }))];
    }
    const result = await model.getValuesAt(p.x, p.y, {bands: wanted});
    const panel = $("inspector");
    if (!result) { panel.classList.remove("visible"); return; }
    panel.classList.add("visible");
    $("inspector-where").textContent = `${geo.y.toFixed(5)}°, ${geo.x.toFixed(5)}°`;
    const sourceKeys = Object.keys(result.sources);
    const r = style.render;
    const unit = scene.timeSeries?.unit ?? "";
    $("inspector-value").textContent = r.type === "pseudocolor"
        ? `${fmt(result.sources[sourceKeys[0]])}${unit}  ${classLabel(result) ?? ""}`
        : sourceKeys.map((k) => `${k} ${fmt(result.sources[k])}`).join(" · ");
    const table = $("inspector-table");
    table.innerHTML = Object.entries(result.bands)
        .map(([b, v]) => `<tr><td>${b}</td><td>${b === "scl" ? `${v} ${SCL_TABLE.entries.find((c) => c.value === v)?.label ?? ""}` : fmt(v)}</td></tr>`)
        .join("");

    // Spectral profile (reflectance against wavelength), or the monthly curve for time series.
    let labels: (string | number)[] = [];
    let values: number[] = [];
    let xType: "linear" | "category" = "linear";
    let series: { label: string; values: number[]; color: string }[] | null = null;
    if (scene.timeSeries) {
        // The current style's sources evaluated at every step: the expression through time at this pixel.
        labels = scene.timeSeries.steps;
        const names = Object.keys(result.bands);
        const pixel = Object.fromEntries(names.map((b) => [b, Float32Array.of(result.bands[b])]));
        const perStep = scene.timeSeries.steps.map((s) => {
            try {
                return compileStyle(styleAtStep(s), names).evaluate(pixel, 1).map((v) => v[0]);
            } catch {
                return [];
            }
        });
        const colors = style.render.type === "rgb" ? ["#f87171", "#4ade80", "#60a5fa"] : ["#7dd3fc"];
        series = colors.map((color, k) => ({label: String(k), color, values: perStep.map((v) => v[k] ?? NaN)}));
        xType = "category";
    } else if (scene.wavelengths) {
        const entries = Object.entries(scene.wavelengths).filter(([b]) => b in result.bands).sort((a, b) => a[1] - b[1]);
        labels = entries.map(([, w]) => w);
        values = entries.map(([b]) => result.bands[b]);
    }
    const data = xType === "linear" ? labels.map((x, i) => ({x: x as number, y: values[i]})) : values;
    const datasets = series
        ? series.map((sr) => ({data: sr.values, borderColor: sr.color, backgroundColor: sr.color + "26", fill: series!.length === 1,
            tension: 0.3, pointRadius: 2.5, borderWidth: 2}))
        : [{data, borderColor: "#7dd3fc", backgroundColor: "rgba(125,211,252,0.15)", fill: true, tension: 0.3, pointRadius: 2.5, borderWidth: 2}];
    if (profileChart) profileChart.destroy();
    profileChart = new Chart($<HTMLCanvasElement>("profile"), {
        type: "line",
        data: {labels: xType === "category" ? labels : undefined, datasets: datasets as never},
        options: {
            animation: {duration: 300}, responsive: true, maintainAspectRatio: false,
            plugins: {tooltip: {enabled: true}},
            scales: {
                x: {type: xType, title: {display: xType === "linear", text: "wavelength (nm)"}, ticks: {maxTicksLimit: 7}},
                y: {title: {display: true, text: scene.timeSeries ? unit || "value" : "reflectance"}, ticks: {maxTicksLimit: 5}},
            },
        },
    });
}

function classLabel(result: { sources: Record<string, number> }): string | null {
    const r = style.render;
    if (r.type !== "pseudocolor" || !r.colorMap || typeof r.colorMap !== "object") return null;
    const v = Object.values(result.sources)[0];
    if (isColorTable(r.colorMap)) return r.colorMap.entries.find((e) => e.value === v)?.label ?? null;
    if (r.colorMap.blend !== "stepped" || !model) return null;
    const legend = model.getLegend();
    if (legend?.kind !== "ramp") return null;
    let label: string | undefined;
    for (const stop of legend.stops) if (v >= stop.value) label = stop.label;
    return label ?? null;
}

{
    let down: [number, number] | null = null;
    map.domNode.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    map.domNode.addEventListener("pointerup", (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
        const rect = map.domNode.getBoundingClientRect();
        void inspect(e.clientX - rect.left, e.clientY - rect.top);
    });
}

// ------------------------------------------------------------------------------------------------ swipe

let swipe: SwipeController | null = null;
const swipeLine = document.createElement("div");
swipeLine.style.cssText = "position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 8px #000a;z-index:3;pointer-events:none;display:none";
document.body.append(swipeLine);

/** The swipe's choice: a layer id, "twin" (true colour of the left layer) or "none" (only what lies below). */
let swipeChoice: { left?: string; right?: string } = {};

/** Layers a swipe can compare: everything on the map but terrain and the swipe's own twin, top first. */
function swipeCandidates(): Layer[] {
    return [...map.layerTree.children].reverse().filter((n): n is Layer => n instanceof Layer && n !== twinLayer && !isElevation(n));
}

/**
 * The true colour style of a studio layer, or null without red, green and blue bands: plain `red`, or for a time
 * series the bands of the step on its slider (`red_2024`).
 */
function trueColourOf(entry: Entry | undefined): BandStyle | null {
    if (!entry || entry.elevation) return null;
    const names = entry.model.getBandNames();
    const steps = entry.scene.timeSeries?.steps;
    const at = steps?.[entry === currentEntry() ? step : entry.step];
    const suffix = at !== undefined ? `_${at.replace(/[^A-Za-z0-9_]/g, "_")}` : "";
    const [red, green, blue] = ["red", "green", "blue"].map((b) => (names.includes(b) ? b : `${b}${suffix}`));
    if (![red, green, blue].every((b) => names.includes(b))) return null;
    const preset = presetStyle("true-color");
    return {...preset, render: {...preset.render, red, green, blue} as BandStyle["render"]};
}

/** Fills the Left / Right pickers from the layers on the map, keeping the choice while its layers exist. */
function fillSwipeChoices() {
    const candidates = swipeCandidates();
    const ids = new Set(candidates.map((n) => n.id));
    if (!swipeChoice.left || !ids.has(swipeChoice.left)) swipeChoice.left = layer?.id ?? candidates[0]?.id;
    const leftEntry = [...entries.values()].find((e) => e.layer.id === swipeChoice.left);
    const twinPossible = trueColourOf(leftEntry) !== null;
    const validRight = (v?: string) => v === "none" || (v === "twin" && twinPossible) || (v !== undefined && v !== swipeChoice.left && ids.has(v));
    if (!validRight(swipeChoice.right)) {
        swipeChoice.right = twinPossible ? "twin" : candidates.find((n) => n.id !== swipeChoice.left)?.id ?? "none";
    }
    const option = (value: string, text: string) => Object.assign(document.createElement("sl-option"), {value, textContent: text});
    const left = $<SlSelect>("swipe-left"), right = $<SlSelect>("swipe-right");
    left.replaceChildren(...candidates.map((n) => option(n.id, n.label)));
    right.replaceChildren(
        ...(twinPossible ? [option("twin", `${leftEntry!.layer.label} in true colour`)] : []),
        ...candidates.filter((n) => n.id !== swipeChoice.left).map((n) => option(n.id, n.label)),
        option("none", "Nothing (the layers below)"));
    left.value = swipeChoice.left ?? "";
    right.value = swipeChoice.right ?? "none";
}

let swipeToken = 0;
async function enableSwipe(on: boolean) {
    const mine = ++swipeToken;
    if (twinLayer) { map.layerTree.removeChild(twinLayer); (twinLayer.model as GeoTiffTileSetModel).dispose(); twinLayer = null; }
    $("swipe-choice").hidden = !on;
    if (!on) {
        map.controller = null;
        swipe = null;
        swipeLine.style.display = "none";
        return;
    }
    fillSwipeChoices();
    const find = (id?: string) => swipeCandidates().find((n) => n.id === id) ?? null;
    const leftNode = find(swipeChoice.left);
    if (!leftNode) { map.controller = null; swipe = null; swipeLine.style.display = "none"; return; }
    const right: Layer[] = [];
    if (swipeChoice.right === "twin") {
        const entry = [...entries.values()].find((e) => e.layer === leftNode)!;
        const leftStyle = entry === currentEntry() ? style : entry.model.getStyle() ?? undefined;
        const colour = {...trueColourOf(entry)!, ...(leftStyle?.mask ? {mask: leftStyle.mask} : {})};
        const twin = await trace("5 Style", `const twin = await model.withStyle(${code(colour)}); // ${leftNode.label}`,
            () => entry.model.withStyle(colour));
        if (mine !== swipeToken) { twin.dispose(); return; }
        twinLayer = new RasterTileSetLayer(twin, {label: `${leftNode.label} (true colour)`});
        map.layerTree.addChild(twinLayer, "below", leftNode);
        right.push(twinLayer);
    } else if (swipeChoice.right !== "none") {
        const node = find(swipeChoice.right);
        if (node) right.push(node);
    }
    // Both compared layers must be drawn.
    for (const n of [leftNode, ...right]) n.visible = true;
    swipe = new SwipeController();
    swipe.automaticOrientation = false;
    swipe.swipeLineOrientation = SwipeLineOrientation.VERTICAL;
    swipe.layers = [[leftNode], right];
    const composite = new CompositeController();
    composite.appendController(swipe);
    composite.appendController(new NavigateController());
    map.controller = composite;
    const place = (x: number) => {
        const rect = map.domNode.getBoundingClientRect();
        swipeLine.style.left = `${rect.left + x}px`;
        swipeLine.style.display = "block";
    };
    swipe.swipeLineLocation = createPoint(null, [map.viewSize[0] * 0.55, map.viewSize[1] / 2]);
    place(map.viewSize[0] * 0.55);
    swipe.on("SwipeLineLocationChange", (p) => place(p.x));
    renderLayerList();
}

// ------------------------------------------------------------------------------------------------ time series

let playTimer: ReturnType<typeof setInterval> | null = null;
/** Index of the current time step. */
let step = 0;
/** The source fields of the scene preset in use, with `{T}` for the time step; null for other styles. */
let template: Partial<Record<"band" | "expression" | "red" | "green" | "blue", unknown>> | null = null;

const SOURCE_FIELDS = ["band", "expression", "red", "green", "blue"] as const;

function sourcesOf(render: BandStyle["render"]): NonNullable<typeof template> {
    const out: NonNullable<typeof template> = {};
    const fields = render as unknown as Record<string, unknown>;
    for (const f of SOURCE_FIELDS) if (fields[f] !== undefined) out[f] = fields[f];
    return out;
}

function currentStep(): string {
    return scene.timeSeries?.steps[step] ?? "";
}

/** The current style as it would be at another step. */
function styleAtStep(target: string): BandStyle {
    if (template) return {...style, render: {...style.render, ...fillStep(template, target)} as BandStyle["render"]};
    // A hand-written style: replace the current step's token ("Jan", the 2024 of "green_2024") by the target's.
    const from = currentStep();
    if (!from || from === target) return style;
    const token = new RegExp(`(?<![A-Za-z0-9])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g");
    const swapped = JSON.parse(JSON.stringify(sourcesOf(style.render)).replace(token, target));
    return {...style, render: {...style.render, ...swapped} as BandStyle["render"]};
}

/**
 * After a hand-written style: when it names exactly one time step ("Jun", "green_2024"), the slider moves to that
 * step, so sliding changes it from there. Styles naming several steps ("Jul - Jan") keep the slider where it is.
 */
function followStepOfStyle() {
    const ts = scene.timeSeries;
    if (!ts) return;
    const text = JSON.stringify(sourcesOf(style.render));
    const found = ts.steps.filter((t) => new RegExp(`(?<![A-Za-z0-9])${t}(?![A-Za-z0-9])`).test(text));
    if (found.length !== 1) return;
    step = ts.steps.indexOf(found[0]);
    $<SlRange>("month").value = step;
    $("month-label").textContent = found[0];
}

function setStep(index: number) {
    if (!scene.timeSeries || !model) return;
    const target = scene.timeSeries.steps[index];
    style = styleAtStep(target);
    step = index;
    $("month-label").textContent = target;
    $<SlRange>("month").value = index;
    void applyStyle(true);
    // A true colour twin in the swipe shows the same year as its layer.
    const colour = twinLayer && swipeChoice.left === layer?.id ? trueColourOf(currentEntry() ?? undefined) : null;
    if (twinLayer && colour) void (twinLayer.model as GeoTiffTileSetModel).setStyle(colour);
}

function setupTimebar() {
    const ts = scene.timeSeries;
    $("timebar").classList.toggle("visible", !!ts);
    if (!ts) return;
    const range = $<SlRange>("month");
    range.max = ts.steps.length - 1;
    range.value = step;
    $("month-label").textContent = ts.steps[step];
}

function stopPlaying() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    $<SlIconButton>("play").name = "play-fill";
}

function wireTimebar() {
    $<SlRange>("month").tooltipFormatter = (v: number) => scene.timeSeries?.steps[v] ?? String(v);
    $<SlRange>("month").addEventListener("sl-input", () => setStep(Number($<SlRange>("month").value)));
    $("play").addEventListener("click", () => {
        if (playTimer) return stopPlaying();
        $<SlIconButton>("play").name = "pause-fill";
        playTimer = setInterval(() => setStep((step + 1) % (scene.timeSeries?.steps.length ?? 1)), 1100);
    });
}

// ------------------------------------------------------------------------------------------------ HUD

let resourceCount = 0;
new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (/\.tiff?($|\?)/i.test(entry.name)) resourceCount++;
}).observe({type: "resource", buffered: true});

setInterval(() => {
    if (!model) { $("hud").textContent = ""; return; }
    const p = model.getPerformance();
    const hit = p.tiles ? Math.round((100 * p.cacheHits) / p.tiles) : 0;
    $("hud").innerHTML =
        `tiles rendered <b>${p.tiles}</b> · cache hits <b>${hit}%</b><br>` +
        `read+decode <b>${p.readMs.toFixed(0)} ms</b> · style <b>${p.renderMs.toFixed(2)} ms</b> /tile<br>` +
        `decoded cache <b>${(p.cacheBytes / 1048576).toFixed(0)} MiB</b> · range requests <b>${resourceCount}</b>`;
}, 500);

// ------------------------------------------------------------------------------------------------ start

initScenes();
initLayerInfo();
initOpenData({
    load: (s) => loadScene(s, true),
    register: (s) => SCENES.push(s),
    viewBbox: viewBoundsLonLat,
    model: () => model,
    title: () => scene.title,
    map,
});
initColorMaps();
wireControls();
wireTimebar();
// Nothing is loaded at start: a Gallery scene is added when it is picked, any other data with Add a layer.
void activate(null);

Object.assign(window, {studio: {map, get model() { return model; }, get style() { return style; }, loadScene, SCENES}});
