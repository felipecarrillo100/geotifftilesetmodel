import type {LayerTree} from "@luciad/ria/view/LayerTree.js";
import type {LayerTreeNode} from "@luciad/ria/view/LayerTreeNode.js";
import type {Bounds} from "@luciad/ria/shape/Bounds.js";
import type {Handle} from "@luciad/ria/util/Evented.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffTileSetModel} from "ria-geotiff";

/**
 * Bounds of a layer's data: its model's bounds when the model has any (raster tile set models do); for a layer group,
 * the union of its children's bounds (children in another reference are skipped).
 */
export function layerBounds(node: LayerTreeNode): Bounds | null {
    const model = (node as { model?: { bounds?: Bounds | null } }).model;
    if (model) return model.bounds ?? null;
    let union: Bounds | null = null;
    for (const child of node.children) {
        const b = layerBounds(child);
        if (!b) continue;
        if (!union) union = b.copy();
        else if (b.reference?.identifier === union.reference?.identifier) union.setTo2DUnion(b);
    }
    return union;
}

/** Whether a layer (or any layer of a group) is an elevation layer. */
export function isElevation(node: LayerTreeNode): boolean {
    const model = (node as { model?: { dataType?: RasterDataType } }).model;
    if (model) return model instanceof GeoTiffTileSetModel ? model.isElevation : model.dataType === RasterDataType.ELEVATION;
    return node.children.some(isElevation);
}

const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/><path d="M11 8v6M8 11h6"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';

function iconButton(icon: string, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
    return button;
}

/**
 * A layer control: one row per layer of the map's layer tree, top layer first, with a visibility checkbox, a zoom
 * button and a delete button. It follows the layer tree (layers added, removed or moved, visibility or label
 * changed elsewhere).
 *
 * LuciadRIA shows only one elevation layer: switching an elevation layer on switches the other ones off here,
 * instead of letting LuciadRIA hide one of them silently.
 */
export function createLayerControl(
    container: HTMLElement,
    layerTree: LayerTree,
    zoomTo: (bounds: Bounds, node: LayerTreeNode) => void | Promise<void>,
): { destroy(): void } {
    let nodeHandles: Handle[] = [];

    const render = () => {
        nodeHandles.forEach((h) => h.remove());
        nodeHandles = [];
        container.replaceChildren();
        // children are in painting order (bottom first): list the top layer first
        const nodes = [...layerTree.children].reverse();
        if (nodes.length === 0) {
            container.textContent = "No layers";
            return;
        }
        for (const node of nodes) {
            const elevation = isElevation(node);
            const row = document.createElement("div");
            row.className = "layer-row";

            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = node.visible;
            checkbox.setAttribute("aria-label", `Show ${node.label}`);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked && elevation) {
                    for (const other of layerTree.children) {
                        if (other !== node && isElevation(other)) other.visible = false;
                    }
                }
                node.visible = checkbox.checked;
            });
            const name = document.createElement("span");
            name.className = "name";
            name.textContent = node.label;
            name.title = node.label;
            label.append(checkbox, name);
            if (elevation) {
                const kind = document.createElement("span");
                kind.className = "kind";
                kind.textContent = "terrain";
                label.append(kind);
            }

            const bounds = layerBounds(node);
            const zoom = iconButton(ICON_ZOOM, `Zoom to ${node.label}`);
            zoom.disabled = !bounds;
            zoom.addEventListener("click", () => { if (bounds) void zoomTo(bounds, node); });

            const remove = iconButton(ICON_TRASH, `Delete ${node.label}`);
            remove.addEventListener("click", () => { layerTree.removeChild(node); });

            row.append(label, zoom, remove);
            container.append(row);

            nodeHandles.push(
                node.on("VisibilityChanged", (visible: boolean) => { checkbox.checked = visible; }),
                node.on("LabelChanged", (text: string) => { name.textContent = text; name.title = text; }),
            );
        }
    };

    const treeHandles = [
        layerTree.on("NodeAdded", render),
        layerTree.on("NodeRemoved", render),
        layerTree.on("NodeMoved", render),
    ];
    render();
    return {
        destroy() {
            treeHandles.forEach((h) => h.remove());
            nodeHandles.forEach((h) => h.remove());
            container.replaceChildren();
        },
    };
}
