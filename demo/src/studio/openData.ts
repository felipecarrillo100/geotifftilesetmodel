/**
 * The studio's "Add a layer" tab: one box for any URL or file. `identifySource` says what it is; a COG, a manifest
 * or a STAC item opens at once; a STAC API, static catalog or collection opens a stepper (collection, requirements,
 * items with footprints on the map, show on map); an item collection goes straight to the items. Saving the current
 * layer as a manifest is a small dialog. Everything goes through the library's public API.
 */
import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import type SlInput from "@shoelace-style/shoelace/dist/components/input/input.js";
import type SlRange from "@shoelace-style/shoelace/dist/components/range/range.js";
import type SlSelect from "@shoelace-style/shoelace/dist/components/select/select.js";
import type SlTabGroup from "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import type SlTextarea from "@shoelace-style/shoelace/dist/components/textarea/textarea.js";
import type SlCheckbox from "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import type SlButton from "@shoelace-style/shoelace/dist/components/button/button.js";
import type {WebGLMap} from "@luciad/ria/view/WebGLMap.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffTileSetModel, identifySource, RiaGeoTiffError, toManifest, type IdentifiedSource} from "ria-geotiff";
import {
    assetFormat, coverageOf, dedupeItems, elevationHint, isDataAsset, itemKey, selectionToRequest, StacClient, toBandInputs, type Bbox, type CollectionDetails, type CollectionSummary, type Pick,
    type Period, type StacCandidate, type StacItemJson, type StacProgress, type StacSelection,
} from "ria-geotiff/stac";
import {referenceWkt} from "../references.js";
import {Footprints} from "./footprints.js";
import {code, logRequest, setTracing, trace, traceSync} from "./trace.js";
import type {Scene} from "./scenes.js";

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

/** Assets of one format: `usable` when a model opens them (a GeoTIFF data asset), else shown greyed out. */
interface FormatGroup { format: string; usable: boolean; keys: string[] }

/** The assets of an item (or a collection's item_assets) grouped by format, the usable ones first. */
function formatGroups(assets: Record<string, { type?: string; href?: string; roles?: string[] }> | undefined): FormatGroup[] {
    const groups = new Map<string, FormatGroup>();
    for (const [key, asset] of Object.entries(assets ?? {})) {
        const {format, openable} = assetFormat(asset);
        const usable = openable && isDataAsset(key, asset);
        const group = groups.get(`${format}|${usable}`) ?? {format, usable, keys: []};
        group.keys.push(key);
        groups.set(`${format}|${usable}`, group);
    }
    return [...groups.values()].sort((a, b) => Number(b.usable) - Number(a.usable));
}
const groupText = (g: FormatGroup) => `${g.format}${g.keys.length > 1 ? ` ×${g.keys.length}` : ""}`;

/** One line for a collection: its usable formats, else what it holds instead. */
function formatsLine(groups: FormatGroup[]): string {
    const usable = groups.filter((g) => g.usable);
    if (usable.length) return usable.map(groupText).join(", ");
    return groups.length ? `no GeoTIFF: ${groups.map(groupText).join(", ")}` : "no assets";
}

/** Chips of the asset formats of an item; the title of each lists its asset keys. */
function formatChips(groups: FormatGroup[]): HTMLElement {
    const box = Object.assign(document.createElement("span"), {className: "formats"});
    for (const g of groups) {
        const chip = Object.assign(document.createElement("span"), {className: `format${g.usable ? " usable" : ""}`, textContent: groupText(g)});
        chip.title = `${g.usable ? "Opens" : g.format === "COG" || g.format === "GeoTIFF" ? "Not a data asset (thumbnail, overview)" : "Cannot be opened"}: ${g.keys.join(", ")}`;
        box.append(chip);
    }
    return box;
}

/**
 * Which asset of each item gives the heights of a terrain: by resolution (`gsd`) when every GeoTIFF data asset
 * declares one (swissALTI3D: 0.5 m and 2 m, under keys that name the tile), else by asset key (`dem`).
 */
interface HeightChoice { value: string; label: string; keyOf: (item: StacItemJson) => string | undefined }
function heightChoices(items: StacItemJson[]): HeightChoice[] {
    const assets = items.flatMap((item) => Object.entries(item.assets).filter(([key, a]) => isDataAsset(key, a) && assetFormat(a).openable)
        .map(([key, a]) => ({item, key, gsd: (a as { gsd?: number }).gsd ?? (item.properties.gsd as number | undefined)})));
    if (assets.length && assets.every((a) => typeof a.gsd === "number")) {
        const sizes = [...new Set(assets.map((a) => a.gsd!))].sort((a, b) => b - a);   // coarsest first: the default, quickest
        return sizes.map((gsd, i) => ({value: `gsd:${gsd}`, label: `${gsd} m resolution${i === 0 && sizes.length > 1 ? " (quickest)" : ""}`,
            keyOf: (item) => assets.find((a) => a.item === item && a.gsd === gsd)?.key}));
    }
    const keys = [...new Set(assets.map((a) => a.key))];
    return keys.map((key) => ({value: `key:${key}`, label: `Asset ${key}`, keyOf: (item) => (item.assets[key] ? key : undefined)}));
}

/** The newest item of each footprint (tiled products list a tile once per survey). */
function newestPerFootprint(items: StacItemJson[]): StacItemJson[] {
    const kept = new Map<string, StacItemJson>();
    for (const item of items) {
        const key = (item.bbox ?? []).map((v) => v.toFixed(6)).join(",") || item.id;
        const other = kept.get(key);
        if (!other || dateOf(item) > dateOf(other)) kept.set(key, item);
    }
    return [...kept.values()];
}

/** CORS relay of the dev server for INPE's data files (its API answers browsers, its files do not). */
const relay = (url: string) => url.replace(/^https:\/\/data\.inpe\.br\//, "/inpe/");

/** Example URLs of the Try menu: demo conveniences, clearly labelled as examples. */
const EXAMPLES: { group: string; label: string; url: string }[] = [
    {group: "STAC APIs", label: "Earth Search (Element 84, AWS)", url: "https://earth-search.aws.element84.com/v1"},
    {group: "STAC APIs", label: "Microsoft Planetary Computer", url: "https://planetarycomputer.microsoft.com/api/stac/v1"},
    {group: "STAC APIs", label: "INPE Brazil Data Cube (files through the dev relay)", url: "https://data.inpe.br/bdc/stac/v1"},
    {group: "STAC APIs", label: "swisstopo", url: "https://data.geo.admin.ch/api/stac/v1"},
    {group: "STAC APIs", label: "Collection of an API: Earth Search Sentinel-2 L2A", url: "https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a"},
    {group: "Local examples (test fixtures)", label: "Static catalog", url: "/fixtures/static-catalog/catalog.json"},
    {group: "Local examples (test fixtures)", label: "Static collection", url: "/fixtures/static-catalog/s2-sample/collection.json"},
    {group: "Local examples (test fixtures)", label: "STAC item", url: "/fixtures/static-catalog/s2-sample/a/a.json"},
    {group: "Local examples (test fixtures)", label: "STAC item collection", url: "/fixtures/static-catalog/items.json"},
    {group: "Local examples (test fixtures)", label: "COG (RGB, Web Mercator)", url: "/fixtures/rgb-3857-uint8.tif"},
    {group: "Local examples (test fixtures)", label: "ria-geotiff manifest (NDVI of two COGs)", url: "/fixtures/manifest-s2.json"},
    {group: "Local examples (test fixtures)", label: "GeoTIFF in strips (not a COG)", url: "/fixtures/not-cog-strips.tif"},
    {group: "Examples of errors", label: "An HTML page", url: "/studio.html"},
    {group: "Examples of errors", label: "Nothing there (404)", url: "/fixtures/nothing-here.tif"},
];

export interface AddLayerHooks {
    /** Adds a scene's layer to the map and makes it current (rejects when it cannot be opened). */
    load(scene: Scene): Promise<void>;
    /** Adds a scene to the Gallery's list. */
    register(scene: Scene): void;
    /** The current view in longitude/latitude, when it shows ground. */
    viewBbox(): Bbox | null;
    /** The model of the current layer. */
    model(): GeoTiffTileSetModel | null;
    /** Title of the current layer. */
    title(): string;
    map: WebGLMap;
}

let counter = 0;

/** A scene for something opened here, listed in the Gallery as "Opened: …". */
function opened(title: string, subtitle: string, story: string, create: (scene: Scene) => Promise<GeoTiffTileSetModel>, extra: Partial<Scene> = {}): Scene {
    const scene: Scene = {
        id: `opened-${++counter}`, group: "Opened", title, subtitle, story, credit: "Opened by you.", view: {},
        start: {render: {type: "rgb", red: "b1", green: "b2", blue: "b3"}},
        async create() {
            const model = await create(scene);
            scene.start = model.getStyle() ?? scene.start;   // the style the source chose
            return model;
        },
        ...extra,
    };
    const option = Object.assign(document.createElement("sl-option"), {value: scene.id, textContent: `Opened: ${title}`});
    $<SlSelect>("scene").append(option);
    return scene;
}

/** An error as text: every error of the library has the same shape (message, problems, details). */
export function describeError(e: unknown): string {
    if (!(e instanceof RiaGeoTiffError)) return e instanceof Error ? e.message : String(e);
    const problems = e.problems.map((p) => `${p.severity === "error" ? "✗" : "⚠"} ${p.path || "(whole value)"}: ${p.message}`);
    const details = Object.entries(e.details()).filter(([k]) => k !== "body").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return [e.message, ...problems, ...details].join("\n");
}

const nameOf = (source: string | File) => (typeof source === "string" ? source.split("?")[0].split("/").filter(Boolean).pop() ?? source : source.name);
const dateOf = (i: StacItemJson) => String(i.properties.datetime ?? i.properties.start_datetime ?? "").slice(0, 10);
const cloudOf = (i: StacItemJson) => (typeof i.properties["eo:cloud_cover"] === "number" ? i.properties["eo:cloud_cover"] as number : undefined);

/** The one-line description of an identification. */
function identityLine(found: IdentifiedSource, cog?: string): { text: string; ok: boolean } {
    switch (found.kind) {
        case "geotiff": return {text: `✓ GeoTIFF${found.bigTiff ? " (BigTIFF)" : ""}${cog ? ` · ${cog}` : ""}`, ok: true};
        case "manifest": return found.problems.length
            ? {text: `✗ ria-geotiff manifest with problems: ${found.problems.map((p) => `${p.path || "manifest"}: ${p.message}`).join("; ")}`, ok: false}
            : {text: `✓ ria-geotiff manifest${found.manifest.title ? ` · ${found.manifest.title}` : ""}`, ok: true};
        case "stac-api": return {text: `✓ STAC API · ${found.title ?? found.url}`, ok: true};
        case "stac-catalog": return {text: `✓ STAC catalog without item search · ${found.title ?? found.url ?? ""}`, ok: true};
        case "stac-collection": return {text: `✓ STAC collection · ${found.collection.title ?? found.collection.id}${found.apiUrl ? ` · served by ${found.apiUrl}` : " · static"}`, ok: true};
        case "stac-item": return {text: `✓ STAC item · ${found.item.id} · ${dateOf(found.item)}`, ok: true};
        case "stac-item-collection": return {text: `✓ STAC item collection · ${found.items.length} items${found.next ? " (first page)" : ""}`, ok: true};
        case "unknown": return {text: `✗ ${found.reason}`, ok: false};
    }
}

/** GeoTiffTileSetModel.create, logged (step 3). */
export function create(given: Parameters<typeof GeoTiffTileSetModel.create>[0]): Promise<GeoTiffTileSetModel> {
    // resolveReference: definitions of references LuciadRIA does not ship (UTM zones of satellite data, LV95).
    const options = {...given, resolveReference: referenceWkt, onRequest: logRequest};
    return trace("3 Create", `const model = await GeoTiffTileSetModel.create(${code(options)})`, () => GeoTiffTileSetModel.create(options),
        (m) => ({bands: m.getBandNames(), source: m.getSource().kind, periods: m.getSource().periods, reference: m.reference.identifier,
            dataType: m.dataType, style: m.getStyle()}));
}

export function initOpenData(hooks: AddLayerHooks) {
    const logBox = $<SlCheckbox>("add-log");
    setTracing(logBox.checked);
    logBox.addEventListener("sl-change", () => setTracing(logBox.checked));
    const tabs = () => $<SlTabGroup>("panel-tabs");
    const identity = $("add-identity");
    const errorBox = $("add-error");
    const setIdentity = (text: string, ok: boolean | null) => {
        identity.textContent = text;
        identity.className = `identity${ok === true ? " ok" : ok === false ? " bad" : ""}`;
    };
    const showError = (e: unknown | null) => {
        errorBox.hidden = e === null;
        errorBox.textContent = e === null ? "" : describeError(e);
    };

    // ------------------------------------------------------------------------------------------- save as manifest
    $("save-manifest-open").addEventListener("click", () => {
        const dialog = $<SlDialog>("save-dialog");
        try {
            const json = JSON.stringify(toManifest(hooks.model()!, {title: hooks.title()}), null, 2);
            $<SlTextarea>("save-manifest").value = json;
            $("save-copy").setAttribute("value", json);
            $("save-status").className = "hint";
            $("save-status").textContent = "This manifest reopens the current layer: its files, band names and style.";
        } catch (e) {
            $<SlTextarea>("save-manifest").value = "";
            $("save-status").className = "error-text";
            $("save-status").textContent = (e as Error).message;
        }
        void dialog.show();
    });

    // ------------------------------------------------------------------------------------------- Try menu
    const tryMenu = $<SlSelect>("add-try");
    let group = "";
    EXAMPLES.forEach((ex, i) => {
        if (ex.group !== group) {
            group = ex.group;
            tryMenu.append(Object.assign(document.createElement("small"), {textContent: `Examples · ${group}`}));
        }
        tryMenu.append(Object.assign(document.createElement("sl-option"), {value: String(i), textContent: ex.label}));
    });
    tryMenu.addEventListener("sl-change", () => {
        const ex = EXAMPLES[Number(tryMenu.value)];
        if (!ex) return;
        $<SlInput>("add-url").value = ex.url;
        tryMenu.value = "";
        void open(ex.url);
    });

    // ------------------------------------------------------------------------------------------- identify and open
    let footprints: Footprints | null = null;
    const clearFootprints = () => { footprints?.remove(); footprints = null; };
    let opening = 0;

    const openScene = async (scene: Scene) => {
        hooks.register(scene);
        await hooks.load(scene);
    };

    async function open(source: string | File) {
        const token = ++opening;
        showError(null);
        resetStepper();
        setIdentity(`Identifying ${nameOf(source)}…`, null);
        let found: IdentifiedSource;
        try {
            // One range request (or a slice of the file) says what the source is.
            found = await trace("1 Capabilities", `const found = await identifySource(${typeof source === "string" ? code(source) : "file"})`,
                () => identifySource(source, {onRequest: logRequest}), (r) => r);
        } catch (e) {
            setIdentity(`✗ ${(e as Error).message}`, false);
            return;
        }
        if (token !== opening) return;
        let cogNote: string | undefined;
        let cogWarning = "";
        if (found.kind === "geotiff") {
            // identifySource already checked the header (never image data): is it a COG? It opens either way.
            const {cog} = found;
            cogNote = cog.isCog ? "✓ COG" : `⚠ not a COG: ${cog.reasons.join("; ")}`;
            cogWarning = cog.isCog ? "" : ` Not a COG (${cog.reasons.join("; ")}): it opens, but views read more data.`;
        }
        const line = identityLine(found, cogNote);
        setIdentity(line.text, line.ok);
        const name = nameOf(source);
        try {
            switch (found.kind) {
                case "geotiff": {
                    const f = found;
                    await openScene(opened(name, `GeoTIFF${cogNote?.startsWith("✓") ? " · COG" : " · not a COG"}`,
                        `A single GeoTIFF; bands named by its descriptions or b1…bN.${cogWarning}`,
                        () => create(f.url ? {url: f.url} : {file: f.file!})));
                    break;
                }
                case "manifest": {
                    const f = found;
                    await openScene(opened(f.manifest.title ?? name, "Manifest", f.manifest.description ?? "Opened from a ria-geotiff manifest.",
                        // The manifest was read by identifySource: pass it with its URL as the base of relative files.
                        () => create({manifest: f.manifest, base: f.url, rewriteUrl: relay})));
                    break;
                }
                case "stac-item": {
                    const item = found.item;
                    await openScene(opened(item.id, `STAC item · ${dateOf(item)}`, `STAC item of ${item.collection ?? "no collection"}.`,
                        () => create({stac: {items: [item]}, rewriteUrl: relay})));
                    break;
                }
                case "stac-item-collection":
                    showItems(undefined, found.items, "From the item collection");
                    break;
                case "stac-api":
                case "stac-catalog":
                case "stac-collection": {
                    if (!found.url) throw new Error("A catalog or collection file needs its URL: its relative links cannot be followed from a dropped file.");
                    setIdentity(`${line.text} · connecting…`, true);
                    // An API, a static catalog or a collection URL: connect gives the client (of the collection's
                    // API, with collectionId set, for a collection).
                    const target = found.url;
                    const client = await trace("1 Capabilities", `const client = await StacClient.connect(${code(target)})`,
                        () => StacClient.connect(target, {onRequest: logRequest}), (c) => ({url: c.url, title: c.landing.title, collectionId: c.collectionId, capabilities: c.capabilities}));
                    if (token !== opening) return;
                    const caps = client.capabilities;
                    setIdentity(`${line.text} · ${caps.staticCatalog ? "static: crawled, filtered in the browser"
                        : `item search ${caps.itemSearch ? "✓" : "✗"} · CQL2 ${caps.filter ? "✓" : "✗"} · Query ${caps.query ? "✓" : "✗"} · sort ${caps.sort ? "✓" : "✗"}`}`, true);
                    await showCatalog(client, client.collectionId);
                    break;
                }
                case "unknown":
                    break;
            }
        } catch (e) {
            if (token === opening) showError(e);
        }
    }

    $("add-open").addEventListener("click", () => {
        const url = $<SlInput>("add-url").value.trim();
        if (url) void open(url);
    });
    $<SlInput>("add-url").addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") $("add-open").click();
    });
    const picker = $<HTMLInputElement>("add-file-input");
    $("add-file").addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        if (file) void open(file);
        picker.value = "";
    });
    // Drop a file on the map: the Add a layer tab shows what it is.
    const mapEl = $("map");
    mapEl.addEventListener("dragover", (e) => { e.preventDefault(); });
    mapEl.addEventListener("drop", (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        void tabs().show("add");
        void open(file);
    });

    // ------------------------------------------------------------------------------------------- STAC stepper
    let catalog: { client: StacClient; collections: CollectionSummary[] } | null = null;
    let details: CollectionDetails | null = null;
    let found: { items: StacItemJson[]; per?: Period; area?: Bbox } | null = null;
    const chosen = new Set<string>();   // item keys (collection/id)
    const unusable = new Set<string>(); // item keys of found items with no GeoTIFF asset: listed, not choosable
    let heights: HeightChoice[] = [];   // the assets a terrain can take its heights from, for the found items
    $("add-per").addEventListener("sl-change", () => {
        $("add-height-wrap").hidden = $<SlSelect>("add-per").value !== "terrain";
        terrainNote();
    });
    /** For a terrain: how much of the view the chosen tiles cover, with advice when it is only part of it. */
    function terrainNote() {
        const note = $("add-terrain-note");
        note.textContent = "";
        if ($<SlSelect>("add-per").value !== "terrain" || !found?.area) return;
        const tiles = newestPerFootprint(found.items.filter((item) => chosen.has(itemKey(item))));
        if (!tiles.length) return;
        const covered = Math.min(1, tiles.reduce((sum, item) => sum + coverageOf(item, found!.area!), 0));
        if (covered >= 0.95) return;
        note.textContent = `⚠ ${tiles.length} tile(s) cover about ${Math.max(1, Math.round(100 * covered))}% of the view: the terrain will only be there.`
            + " Zoom in to the area you need (and pick \"All items found\"), or choose a coarser collection with one large file"
            + " (on swisstopo: swissALTIRegio, 10 m, for the whole country).";
    }
    let search: AbortController | null = null;
    // Formats per collection: from item_assets when declared, else from one item (many catalogs do not declare them).
    let collectionFormats = new Map<string, Promise<FormatGroup[] | null>>();
    let labelling: AbortController | null = null;
    function formatsOf(id: string): Promise<FormatGroup[] | null> {
        let formats = collectionFormats.get(id);
        if (!formats) {
            const client = catalog?.client;
            formats = !client ? Promise.resolve(null) : (async () => {
                // The collection JSON is listed (and cached) by the client already: no request for item_assets.
                const declared = (await client.listCollections()).find((c) => c.id === id)?.item_assets;
                if (declared && Object.keys(declared).length) return formatGroups(declared);
                // One item through the items endpoint (a search is much slower on some servers, as swisstopo's).
                const item = await client.sampleItem(id);
                return formatGroups(item?.assets);
            })().catch(() => null);
            collectionFormats.set(id, formats);
        }
        return formats;
    }

    function resetStepper() {
        search?.abort();
        labelling?.abort();
        clearFootprints();
        catalog = null; details = null; found = null; chosen.clear();
        collectionFormats = new Map();
        knownFormats.clear();
        $("add-formats-note").textContent = "";
        $("stepper").hidden = true;
        for (const id of ["step-requirements", "step-items", "step-show"]) $(id).hidden = true;
        $("step-collection").hidden = false;
        $("add-problems").textContent = "";
        $("add-collection-info").textContent = "";
        $<SlSelect>("add-collection").replaceChildren();
    }

    async function showCatalog(client: StacClient, preselect?: string) {
        $("stepper").hidden = false;
        $("add-collection-info").textContent = client.capabilities.staticCatalog ? "Crawling the catalog for collections…" : "Listing collections…";
        // 1. Capabilities: the collections (a static catalog is crawled through its child links).
        catalog = {client, collections: await trace("1 Capabilities", "const collections = await client.collections()", () => client.collections(),
            (r) => ({count: r.length, ids: r.slice(0, 20).map((c) => c.id), crawlProblems: client.crawlProblems}))};
        await fillCollections(preselect);
    }

    /** Documents a static crawl could not read, for display. */
    const crawlNote = () => {
        const problems = catalog?.client.crawlProblems ?? [];
        return problems.length ? `\n⚠ ${problems.length} document(s) of the catalog could not be read: ${problems.slice(0, 3).map((p) => p.url).join(", ")}${problems.length > 3 ? ", …" : ""}` : "";
    };

    const collectionSelect = $<SlSelect>("add-collection");
    async function fillCollections(preselect?: string) {
        if (!catalog) return;
        const view = $<SlCheckbox>("add-in-view").checked ? hooks.viewBbox() : null;
        // The list is cached by the client: filtering again by the view costs no request; include keeps the preselection.
        const client = catalog.client;
        const filter = {...(view ? {area: view} : {}), ...(preselect ? {include: [preselect]} : {})};
        const list = await trace("1 Capabilities", `const shown = await client.collections(${code(filter)})`, () => client.collections(filter),
            (r) => ({count: r.length}));
        const options = list.map((c) => Object.assign(document.createElement("sl-option"), {value: c.id, textContent: c.title ? `${c.title} (${c.id})` : c.id}));
        collectionSelect.replaceChildren(...options);
        void labelFormats(options as HTMLElement[]);
        $("add-collection-info").textContent = `${catalog.collections.length} collections, ${list.length} ${view ? "covering the view" : "in all"}.${crawlNote()}`;
        const pick = preselect ?? (list.length === 1 ? list[0].id : undefined);
        if (pick && list.some((c) => c.id === pick)) {
            collectionSelect.value = pick;
            void chooseCollection(pick);
        }
    }
    /** Collection id to the formats of its items, once known (null: could not be read). */
    const knownFormats = new Map<string, FormatGroup[] | null>();
    /** The formats to list collections by; COG and GeoTIFF (what a model opens) at first. Empty: every collection. */
    let formatFilter = new Set(["COG", "GeoTIFF"]);
    const formatSelect = $<SlSelect>("add-formats");
    const formatValue = (format: string) => format.replace(/[^A-Za-z0-9]+/g, "_");
    /** Text of the search box, lower case: collections whose title or id contain it (anywhere) are listed. */
    let textFilter = "";
    /** How many listed collections have their formats checked (for the note while checking). */
    let formatsDone = 0;
    const matches = (groups: FormatGroup[] | null | undefined) => formatFilter.size === 0
        || (groups ?? []).some((g) => formatFilter.has(g.format) && (g.usable || !(g.format === "COG" || g.format === "GeoTIFF")));

    /** Shows the collections whose formats match the filter (unknown ones wait), and the formats seen so far. */
    function applyFormatFilter(options: HTMLElement[], done: number) {
        formatsDone = done;
        let shown = 0;
        const counts = new Map<string, number>();
        for (const option of options) {
            const id = (option as unknown as { value: string }).value;
            const known = knownFormats.has(id);
            const groups = knownFormats.get(id);
            for (const g of groups ?? []) counts.set(g.format, (counts.get(g.format) ?? 0) + 1);
            const text = (option.dataset.label ?? option.textContent ?? "").toLowerCase();
            option.hidden = (textFilter !== "" && !text.includes(textFilter)) || (formatFilter.size > 0 && (!known || !matches(groups)));
            if (!option.hidden) shown++;
        }
        // The format choices: every format seen, the openable ones first, with how many collections have it.
        // Option values cannot hold spaces ("GeoTIFF (zipped)"): the value is the format with "_" for spaces.
        const formats = [...counts.keys()].sort((a, b) => Number(["COG", "GeoTIFF"].includes(b)) - Number(["COG", "GeoTIFF"].includes(a)) || a.localeCompare(b));
        const existing = new Map((Array.from(formatSelect.querySelectorAll("sl-option")) as unknown as HTMLElement[]).map((o) => [o.dataset.format!, o]));
        if (formats.some((f) => !existing.has(f))) {
            // A new format: rebuild in order (rare); otherwise only the counts change, so an open list does not jump.
            formatSelect.replaceChildren(...formats.map((f) => {
                const o = Object.assign(document.createElement("sl-option"), {value: formatValue(f), textContent: `${f} (${counts.get(f)})`});
                o.dataset.format = f;
                return o;
            }));
            formatSelect.value = formats.filter((f) => formatFilter.has(f)).map(formatValue);
        } else {
            for (const [f, o] of existing) o.textContent = `${f} (${counts.get(f) ?? 0})`;
        }
        const filter = (formatFilter.size ? ` with ${[...formatFilter].join(" or ")}` : "") + (textFilter ? ` matching "${textFilter}"` : "");
        $("add-formats-note").textContent = done < options.length
            ? `Checking formats: ${done} of ${options.length} collections (one item each when undeclared)… ${shown} listed${filter} so far.`
            : `${shown} of ${options.length} collections listed${filter}.`;
    }
    formatSelect.addEventListener("sl-change", () => {
        const byValue = new Map((Array.from(formatSelect.querySelectorAll("sl-option")) as unknown as HTMLElement[]).map((o) => [formatValue(o.dataset.format!), o.dataset.format!]));
        formatFilter = new Set((formatSelect.value as string[]).map((v) => byValue.get(v) ?? v));
        applyFormatFilter(Array.from(collectionSelect.querySelectorAll("sl-option")) as unknown as HTMLElement[], formatsDone);
    });
    // In memory, as you type: no request.
    $<SlInput>("add-collection-search").addEventListener("sl-input", () => {
        textFilter = ($<SlInput>("add-collection-search").value as string).trim().toLowerCase();
        applyFormatFilter(Array.from(collectionSelect.querySelectorAll("sl-option")) as unknown as HTMLElement[], formatsDone);
    });

    /**
     * Adds its formats to each listed collection, a few at a time (one item each when the collection does not
     * declare item_assets); the format filter hides the ones that do not match.
     */
    async function labelFormats(options: HTMLElement[]) {
        labelling?.abort();
        const mine = labelling = new AbortController();
        let done = 0;
        for (const option of options) option.dataset.label ??= option.textContent ?? "";
        // Every collection stays selectable (its items can be browsed); the label says what it holds.
        const label = (option: HTMLElement, groups: FormatGroup[] | null) => {
            option.textContent = groups ? `${option.dataset.label} · ${formatsLine(groups)}` : `${option.dataset.label} · formats unknown`;
        };
        // Already known (a refill after the view changed): no request.
        for (const option of options) {
            const id = (option as unknown as { value: string }).value;
            if (knownFormats.has(id)) { label(option, knownFormats.get(id)!); done++; }
        }
        applyFormatFilter(options, done);
        const queue = options.filter((o) => !knownFormats.has((o as unknown as { value: string }).value));
        const worker = async () => {
            for (let option = queue.shift(); option; option = queue.shift()) {
                const id = (option as unknown as { value: string }).value;
                const groups = await formatsOf(id);
                if (mine.signal.aborted) return;
                knownFormats.set(id, groups);
                label(option, groups);
                applyFormatFilter(options, ++done);
            }
        };
        await Promise.all(Array.from({length: Math.min(6, queue.length)}, worker));
    }
    $("add-in-view").addEventListener("sl-change", () => void fillCollections(collectionSelect.value as string || undefined));
    collectionSelect.addEventListener("sl-change", () => void chooseCollection(collectionSelect.value as string));

    async function chooseCollection(id: string) {
        if (!catalog || !id) return;
        const summary = catalog.collections.find((c) => c.id === id);
        details = null;
        $("add-collection-info").textContent = "Reading the collection…";
        try {
            const client = catalog.client;
            details = await trace("1 Capabilities", `const collection = await client.collection(${code(id)})`, () => client.collection(id),
                (d) => ({interval: d.interval, bands: d.bands, queryables: d.queryables.map((q) => `${q.name} (${q.source})`)}));
        } catch (e) {
            showError(e);
            return;
        }
        if (collectionSelect.value !== id) return;
        const d = details;
        const filterable = d.queryables.filter((q) => q.source === "queryables").map((q) => q.name);
        $("add-collection-info").textContent = `Period ${d.interval[0]?.slice(0, 10) ?? ".."} – ${d.interval[1]?.slice(0, 10) ?? "today"} · `
            + `bands: ${d.bands.length ? d.bands.join(", ") : "not described"} · filterable: ${filterable.length ? filterable.join(", ")
                : d.queryables.length ? `${d.queryables.map((q) => q.name).join(", ")} (from summaries)` : "unknown"}`
            + (summary?.bandNaming === "asset-keys" ? " · band names are asset keys (the items may name them by role)" : "");
        // Elevation: STAC does not say so, the metadata does (keywords, title, description): offer Terrain first.
        const hint = elevationHint(d.raw);
        const per = $<SlSelect>("add-per");
        if (hint) {
            $("add-collection-info").textContent += ` · looks like elevation (${hint}): Show on map defaults to Terrain`;
            per.value = "terrain";
        } else if (per.value === "terrain") {
            per.value = "auto";
        }
        $("add-height-wrap").hidden = per.value !== "terrain";
        const formats = await formatsOf(id);
        if (collectionSelect.value !== id) return;
        if (formats) {
            $("add-collection-info").textContent += ` · formats: ${formatsLine(formats)}`;
            // Still browsable: Find items lists the items with their formats, none of them can be ticked.
            if (!formats.some((g) => g.usable)) {
                $("add-collection-info").textContent += "\n⚠ Its items hold no GeoTIFF: you can browse them, but a model cannot open them.";
            }
        }
        // 2. Requirements, within what the collection offers.
        $("step-requirements").hidden = false;
        for (const input of [$<SlInput>("add-from"), $<SlInput>("add-to")]) {
            input.min = d.interval[0]?.slice(0, 10) ?? "";
            input.max = d.interval[1]?.slice(0, 10) ?? "";
        }
        // Default dates: the whole period of a short collection (up to 3 years), else its last year (or the last
        // year until today, for an open end), so a first Find over a small catalog does not come back empty.
        const end = d.interval[1] ? new Date(d.interval[1]) : new Date();
        const first = d.interval[0] ? new Date(d.interval[0]) : null;
        const short = first !== null && end.getTime() - first.getTime() <= 3 * 366 * 864e5;
        const start = short ? first! : new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate()));
        $<SlInput>("add-to").value = end.toISOString().slice(0, 10);
        $<SlInput>("add-from").value = (first && first > start ? first : start).toISOString().slice(0, 10);
        $("add-cloud-wrap").hidden = !d.queryables.some((q) => q.name === "eo:cloud_cover");
        const bands = $<SlSelect>("add-bands");
        bands.replaceChildren(...d.bands.map((b) => Object.assign(document.createElement("sl-option"), {value: b, textContent: b})));
        bands.value = ["red", "green", "blue", "nir"].filter((b) => d.bands.includes(b));
        $("add-problems").textContent = "";
    }

    /** The selection of step 2, or null with a message. */
    function selection(): (StacSelection & { pick?: Pick }) | null {
        if (!catalog || !details) { $("add-problems").textContent = "Choose a collection first."; return null; }
        const area = hooks.viewBbox();
        if (!area) { $("add-problems").textContent = "The view shows no ground: zoom to an area first."; return null; }
        const from = $<SlInput>("add-from").value || null, to = $<SlInput>("add-to").value || null;
        const cloud = Number($<SlRange>("add-cloud").value);
        const pick = $<SlSelect>("add-pick").value as string;
        const months = ($<SlSelect>("add-months").value as string[]).map(Number);
        const bands = $<SlSelect>("add-bands").value as string[];
        return {
            collection: details.id, area, datetime: from || to ? [from, to] : undefined,
            ...(!$("add-cloud-wrap").hidden && cloud < 100 ? {maxCloud: cloud} : {}),
            ...(bands.length ? {bands} : {}),
            ...(pick === "all" ? {} : {pick: {
                coverage: $<SlSelect>("add-coverage").value as "full" | "best",
                rank: $<SlSelect>("add-rank").value as "least-cloud",
                ...(pick !== "single" ? {per: pick as Period} : {}),
                ...(months.length ? {months} : {}),
            }}),
        };
    }

    $("add-check").addEventListener("click", () => {
        const s = selection();
        if (!s) return;
        // Before any search: the problems of the selection against the collection, with their paths.
        const client = catalog!.client;
        const problems = traceSync("2 Choose", `const problems = client.check(${code(s)}, collection)`, () => client.check(s, details!));
        $("add-problems").textContent = problems.length
            ? problems.map((p) => `${p.severity === "error" ? "✗" : "⚠"} ${p.path}: ${p.message}`).join("\n")
            : "✓ The requirements fit the collection.";
    });

    $("add-find").addEventListener("click", async () => {
        const s = selection();
        if (!s) return;
        showError(null);
        clearFootprints();
        $("step-items").hidden = true;
        $("step-show").hidden = true;
        const client = catalog!.client;
        $("add-problems").textContent = client.capabilities.staticCatalog ? "Crawling the catalog's items…" : "Searching…";
        search?.abort();
        const controller = new AbortController();
        search = controller;
        const cancel = $<SlButton>("add-cancel");
        cancel.hidden = false;
        // Progress of the search: one line, updated per page.
        const onProgress = (p: StacProgress) => {
            $("add-problems").textContent = p.step === "collection" ? "Reading the collection…"
                : p.step === "pick" ? `Picking among ${p.kept} item(s)…`
                    : `Page ${p.pages}: ${p.scanned} item(s) read, ${p.kept} kept${p.matched !== undefined ? ` of ${p.matched} matched` : ""}…`;
        };
        try {
            let items: StacItemJson[], note: string, candidates: StacCandidate[] | undefined;
            if (s.pick) {
                // Search and pick; Cancel aborts the requests.
                const result = await trace("2 Choose", `const found = await client.select(${code(s)}, {signal, onProgress})`,
                    () => client.select(s, {signal: controller.signal, onProgress}),
                    (r) => ({found: r.found, picked: r.items.map((i) => i.id), periods: r.periods, filterEncoding: r.plan.filterEncoding,
                        degradations: r.plan.degradations, problems: r.problems,
                        notPicked: Object.fromEntries(["months", "coverage", "reference", "rank"].map((k) => [k, r.candidates.filter((c) => c.reason === k).length]))}));
                items = result.items;
                candidates = result.candidates;
                note = `${result.found} found, ${items.length} picked`
                    + (result.skipped ? ` · ${result.skipped} without a GeoTIFF skipped (zipped or vector downloads)` : "")
                    + ` · filter: ${result.plan.filterEncoding}`
                    + (result.plan.degradations.length ? ` · ${result.plan.degradations.map((d) => d.kind).join(", ")}` : "")
                    + (result.problems.length ? `\n${result.problems.map((p) => `⚠ ${p.path}: ${p.message}`).join("\n")}` : "");
            } else {
                // No pick: the items the selection's search returns, at most 50.
                const request = {...selectionToRequest(s), maxItems: 50};
                const run = client.search(request, {signal: controller.signal, onProgress});
                items = await trace("2 Choose", `const items = await client.search(${code(request)}, {signal, onProgress}).collect()`, () => run.collect(),
                    (r) => ({count: r.length, ids: r.map((i) => i.id), filterEncoding: run.plan.filterEncoding, degradations: run.plan.degradations}));
                note = `${items.length} found (first 50 at most) · filter: ${run.plan.filterEncoding}`
                    + (run.plan.degradations.length ? ` · ${run.plan.degradations.map((d) => d.kind).join(", ")}` : "");
            }
            $("add-problems").textContent = "";
            showItems(s.pick?.per, items, note + crawlNote(), s.area as Bbox, candidates);
        } catch (e) {
            if (!controller.signal.aborted) {
                $("add-problems").textContent = "";
                showError(e);
            }
        } finally {
            if (search === controller) cancel.hidden = true;
        }
    });
    $("add-cancel").addEventListener("click", () => {
        search?.abort();
        $("add-problems").textContent = "Cancelled.";
        $("add-cancel").hidden = true;
    });

    // 3. Items, with their footprints on the map.
    const list = $("add-items");
    const REASONS: Record<NonNullable<StacCandidate["reason"]>, string> = {
        months: "other month", coverage: "covers part of the view", reference: "other projection", rank: "ranked lower",
    };
    /** The items to list: every candidate of a selection (picked ones ticked), or the items of a search. */
    function showItems(per: Period | undefined, picked: StacItemJson[], note: string, area?: Bbox, candidates?: StacCandidate[]) {
        // Keys are collection/id: some catalogs return a scene twice, so duplicates are dropped first.
        const items = dedupeItems(candidates ? [...picked, ...candidates.filter((c) => !c.picked).map((c) => c.item)] : picked);
        const info = new Map(candidates?.map((c) => [c.item, c]));
        $("stepper").hidden = false;
        if (!catalog) {
            $("step-collection").hidden = true;
            $("step-requirements").hidden = true;
        }
        found = {items, per, area: area ?? hooks.viewBbox() ?? undefined};
        chosen.clear();
        unusable.clear();
        const groupsOf = new Map(items.map((item) => [itemKey(item), formatGroups(item.assets)]));
        for (const [key, groups] of groupsOf) if (!groups.some((g) => g.usable)) unusable.add(key);
        picked.forEach((item) => { if (!unusable.has(itemKey(item))) chosen.add(itemKey(item)); });
        $("step-items").hidden = false;
        $("step-show").hidden = items.length === 0;
        $("add-found").textContent = items.length ? note : `${note}\nNo items: widen the dates, the cloud cover or the view.`;
        clearFootprints();
        footprints = new Footprints(hooks.map, items, (key) => {
            list.querySelectorAll(".item-row").forEach((r) => r.classList.toggle("hot", (r as HTMLElement).dataset.key === key));
            if (key !== null) list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({block: "nearest"});
        });
        const view = found.area;
        list.replaceChildren(...items.map((item) => {
            const key = itemKey(item);
            const row = document.createElement("label");
            row.className = "item-row";
            row.dataset.key = key;
            const box = Object.assign(document.createElement("input"), {type: "checkbox", checked: chosen.has(key), disabled: unusable.has(key)});
            box.addEventListener("change", () => {
                if (box.checked) chosen.add(key); else chosen.delete(key);
                updateChosen();
            });
            const cloud = cloudOf(item);
            // A selection gives each candidate's coverage and why it was not picked; plain search results do not.
            const c = info.get(item);
            const fraction = c?.coverage ?? (view ? coverageOf(item, view) : undefined);
            const coverage = fraction !== undefined ? `${Math.round(100 * fraction)}%` : "";
            row.title = `${item.id}${item.collection ? ` (${item.collection})` : ""}${c?.reason ? ` · not picked: ${REASONS[c.reason]}` : ""}`;
            if (c?.reason) row.classList.add("not-picked");
            if (unusable.has(key)) {
                row.classList.add("unusable");
                row.title += " · no GeoTIFF asset: it cannot be opened";
            }
            row.append(box,
                Object.assign(document.createElement("span"), {className: "id", textContent: `${dateOf(item)} ${item.id}`}),
                Object.assign(document.createElement("span"), {textContent: cloud !== undefined ? `☁${cloud.toFixed(0)}%` : ""}),
                Object.assign(document.createElement("span"), {textContent: coverage, title: "coverage of the view"}),
                Object.assign(document.createElement("span"), {className: "reason", textContent: c?.reason ? REASONS[c.reason] : c?.period ?? ""}),
                formatChips(groupsOf.get(key) ?? []));
            row.addEventListener("mouseenter", () => footprints?.highlight(key));
            row.addEventListener("mouseleave", () => footprints?.highlight(null));
            return row;
        }));
        updateChosen();
        heights = heightChoices(items.filter((item) => !unusable.has(itemKey(item))));
        $<SlSelect>("add-height").replaceChildren(...heights.map((h) => Object.assign(document.createElement("sl-option"), {value: h.value.replace(/[^A-Za-z0-9:._-]/g, "_"), textContent: h.label})));
        $<SlSelect>("add-height").value = heights[0]?.value.replace(/[^A-Za-z0-9:._-]/g, "_") ?? "";
        // The items appear below the requirements: bring them into view.
        $("step-items").scrollIntoView({block: "start"});
    }
    function updateChosen() {
        $("add-chosen").textContent = `${chosen.size} of ${found?.items.length ?? 0} chosen`;
        footprints?.setChosen(chosen);
        $<SlButton>("add-show").disabled = chosen.size === 0;
        terrainNote();
    }
    const setAll = (on: boolean) => {
        chosen.clear();
        if (on) found?.items.forEach((item) => { if (!unusable.has(itemKey(item))) chosen.add(itemKey(item)); });
        list.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((b) => { b.checked = on && !b.disabled; });
        updateChosen();
    };
    $("add-all").addEventListener("click", () => setAll(true));
    $("add-none").addEventListener("click", () => setAll(false));

    /**
     * 4b. The chosen items as one terrain: the height asset of the newest item per tile, as unnamed single-band
     * inputs (several make one "elevation" mosaic), in a model of data type ELEVATION.
     */
    async function showTerrain(chosenItems: StacItemJson[]) {
        const value = $<SlSelect>("add-height").value as string;
        const height = heights.find((h) => h.value.replace(/[^A-Za-z0-9:._-]/g, "_") === value) ?? heights[0];
        if (!height) { showError(new Error("None of the chosen items has a GeoTIFF asset to take heights from.")); return; }
        const items = newestPerFootprint(chosenItems);
        const inputs = items.flatMap((item) => {
            const key = height.keyOf(item);
            return key ? toBandInputs(item, {assets: [key], rewriteUrl: relay}) : [];
        }).map(({bands: _bands, ...input}) => input);
        if (!inputs.length) { showError(new Error(`None of the chosen items has ${height.label}.`)); return; }
        const title = details?.title ?? details?.id ?? items[0].collection ?? "Terrain";
        const client = catalog?.client;
        const dropped = chosenItems.length - items.length;
        const scene = opened(title, `${client ? new URL(client.url).host : "item collection"} · terrain · ${inputs.length} tile(s) · ${height.label}`,
            `Chosen in Add a layer as terrain: ${inputs.length} tile(s)${dropped ? ` (${dropped} older survey(s) of the same tiles left out)` : ""}.`,
            async (self) => {
                // The shared create: logged, with the definitions of references LuciadRIA does not ship (LV95).
                const model = await create({inputs, dataType: RasterDataType.ELEVATION});
                self.details = `${inputs.length} tile(s): ${items.map((i) => `${i.id} ${dateOf(i)}`).join(", ")}`;
                return model;
            }, found?.area ? {view: {bbox: found.area}} : {});
        const button = $<SlButton>("add-show");
        button.loading = true;
        try {
            await openScene(scene);
            clearFootprints();
        } catch (e) {
            showError(e);
        } finally {
            button.loading = false;
        }
    }

    // 4. Show on map: one model from the chosen items (a mosaic per period; several periods are a time series).
    $("add-show").addEventListener("click", async () => {
        if (!found || chosen.size === 0) return;
        showError(null);
        const items = found.items.filter((item) => chosen.has(itemKey(item)));
        const choice = $<SlSelect>("add-per").value as string;
        if (choice === "terrain") return showTerrain(items);
        const per: Period | undefined = choice === "auto" ? found.per : choice === "mosaic" ? undefined : choice as Period;
        const title = details?.title ?? details?.id ?? items[0].collection ?? "STAC items";
        const client = catalog?.client;
        const view = found.area;
        const scene = opened(title, `${client ? new URL(client.url).host : "item collection"} · ${items.length} item(s)${per ? ` · per ${per}` : ""}`,
            `Chosen in Add a layer: ${items.map((i) => `${i.id} ${dateOf(i)}`).join(", ")}`,
            async (self) => {
                // The model has every band of the items; a later style opens the assets it reads.
                const model = await create({stac: {items, ...(per ? {per} : {})}, rewriteUrl: relay});
                const {periods} = model.getSource();
                self.details = `${items.length} item(s): ${items.map((i) => `${i.id} ${dateOf(i)}`).join(", ")}`;
                if (periods) self.timeSeries = {steps: periods, unit: "", initial: periods.length - 1};
                return model;
            }, view ? {view: {bbox: view}} : {});
        const button = $<SlButton>("add-show");
        button.loading = true;
        try {
            await openScene(scene);
            clearFootprints();
        } catch (e) {
            showError(e);
        } finally {
            button.loading = false;
        }
    });
}
