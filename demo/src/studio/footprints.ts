/**
 * Footprints of STAC items on the map, while the user chooses them: a LuciadRIA vector layer (FeatureModel on a
 * MemoryStore), chosen items in the accent colour, the hovered or selected one highlighted.
 */
import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import {Feature} from "@luciad/ria/model/feature/Feature.js";
import {FeatureModel} from "@luciad/ria/model/feature/FeatureModel.js";
import {MemoryStore} from "@luciad/ria/model/store/MemoryStore.js";
import {GeoJsonCodec} from "@luciad/ria/model/codec/GeoJsonCodec.js";
import {FeatureLayer} from "@luciad/ria/view/feature/FeatureLayer.js";
import {FeaturePainter} from "@luciad/ria/view/feature/FeaturePainter.js";
import type {WebGLMap} from "@luciad/ria/view/WebGLMap.js";
import type {Handle} from "@luciad/ria/util/Evented.js";
import {itemFootprints, type StacItemJson} from "ria-geotiff/stac";

const crs84 = getReference("CRS:84");

export class Footprints {
    readonly layer: FeatureLayer;
    private readonly features = new Map<string, Feature>();
    private readonly painter = new FeaturePainter();
    private readonly handles: Handle[] = [];
    private chosen = new Set<string>();

    /**
     * @param map The map to draw on.
     * @param items The items, without duplicates: each feature is keyed by `itemKey(item)`.
     * @param onSelect Called with the key of the footprint selected on the map (or null).
     */
    constructor(private readonly map: WebGLMap, items: StacItemJson[], onSelect: (key: string | null) => void) {
        const codec = new GeoJsonCodec();
        const store = new MemoryStore({reference: crs84});
        // The library's footprints: feature ids are item keys (collection/id), the list rows use the same keys.
        for (const f of itemFootprints(items).features) {
            const shape = codec.decodeGeometryObject(f.geometry as never, crs84);
            if (!shape) continue;
            const feature = new Feature(shape, f.properties, f.id);
            this.features.set(f.id, feature);
            store.add(feature);
        }
        this.painter.paintBody = (canvas, feature, shape, _layer, _map, state) => {
            const chosen = this.chosen.has(String(feature.id));
            const hot = state.selected || state.hovered;
            canvas.drawShape(shape, {
                stroke: {color: hot ? "#fde68a" : chosen ? "#7dd3fc" : "rgba(255,255,255,0.45)", width: hot ? 3 : chosen ? 2 : 1},
                fill: {color: hot ? "rgba(253,230,138,0.18)" : chosen ? "rgba(125,211,252,0.12)" : "rgba(255,255,255,0.03)"},
            });
        };
        this.layer = new FeatureLayer(new FeatureModel(store, {reference: crs84}), {label: "Item footprints", painter: this.painter,
            selectable: true, hoverable: true});
        map.layerTree.addChild(this.layer, "top");
        this.handles.push(map.on("SelectionChanged", () => {
            const picked = map.selectedObjects.find((p) => p.layer === this.layer)?.selected[0];
            onSelect(picked ? String(picked.id) : null);
        }));
    }

    /** Draws these items (keys) as chosen. */
    setChosen(keys: Iterable<string>) {
        this.chosen = new Set(keys);
        this.painter.invalidateAll();
    }

    /** Highlights one footprint (selects it on the map), or none. */
    highlight(key: string | null) {
        const feature = key === null ? undefined : this.features.get(key);
        if (feature) this.map.selectObjects([{layer: this.layer, objects: [feature]}]);
        else this.map.clearSelection();
    }

    remove() {
        this.handles.forEach((h) => h.remove());
        if (this.map.layerTree.findLayerById(this.layer.id)) this.map.layerTree.removeChild(this.layer);
    }
}
