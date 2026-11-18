import {getReference} from "@luciad/ria/reference/ReferenceProvider.js";
import {createPoint} from "@luciad/ria/shape/ShapeFactory.js";
import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {LayerGroup} from "@luciad/ria/view/LayerGroup.js";
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {GeoTiffTileSetModel} from "ria-geotiff";
import {ensureReference} from "./references.js";

/**
 * Streams an area of swisstopo open data straight from swisstopo, without downloads or preprocessing.
 *
 * swisstopo publishes swissALTI3D (elevation) and SWISSIMAGE (orthophotos) as 1 km Cloud Optimized GeoTIFFs in LV95,
 * served with HTTP range and CORS support, and lists them in a STAC catalogue (also CORS enabled). For an LV95
 * box this finds the latest tile of each kind and opens the COGs with ria-geotiff:
 *
 * - elevation: ONE layer over all tiles, a mosaic (the same band name in every input), because LuciadRIA shows
 *   only one elevation layer;
 * - imagery: also one mosaic model over all tiles, with a fixed 8-bit stretch.
 */

const STAC = "https://data.geo.admin.ch/api/stac/v0.9/collections";

export interface SwissArea {
    /** LV95 kilometre of the western column of tiles, e.g. 2616. */
    east: number;
    /** LV95 kilometre of the southern row of tiles, e.g. 1091. */
    north: number;
    /** Number of 1 km tiles from west to east. */
    width: number;
    /** Number of 1 km tiles from south to north. */
    height: number;
}

/** Ground sampling (metres) of the assets to stream: swissALTI3D has 0.5 and 2, SWISSIMAGE 0.1 and 2. */
const ELEVATION_GSD = 0.5;
const IMAGERY_GSD = 0.1;

/** Latest COG of each 1 km tile in the area, keyed by "E-N" (e.g. "2617-1091"). */
async function findTiles(collection: string, gsd: number, area: SwissArea): Promise<Map<string, string>> {
    ensureReference("EPSG:2056");
    const lv95 = getReference("EPSG:2056");
    const toWgs84 = createTransformation(lv95, getReference("CRS:84"));
    const corners = [
        [area.east * 1000, area.north * 1000],
        [(area.east + area.width) * 1000, (area.north + area.height) * 1000],
    ].map(([e, n]) => toWgs84.transform(createPoint(lv95, [e, n])));
    // A generous box (LV95 is rotated a little against longitude/latitude); exact tiles are filtered below.
    const pad = 0.01;
    const bbox = [corners[0].x - pad, corners[0].y - pad, corners[1].x + pad, corners[1].y + pad].join(",");

    const latest = new Map<string, { year: string; href: string }>();
    let url: string | undefined = `${STAC}/${collection}/items?bbox=${bbox}&limit=100`;
    while (url) {
        const page = await (await fetch(url)).json() as {
            features: { id: string; assets: Record<string, { href: string; "eo:gsd"?: number }> }[];
            links?: { rel: string; href: string }[];
        };
        for (const item of page.features) {
            const [year, tile] = item.id.split("_").slice(-2); // e.g. swissalti3d_2019_2617-1091
            const [e, n] = tile.split("-").map(Number);
            if (e < area.east || e >= area.east + area.width || n < area.north || n >= area.north + area.height) continue;
            const asset = Object.values(item.assets).find((a) => a["eo:gsd"] === gsd && a.href.endsWith(".tif"));
            if (asset && (!latest.has(tile) || year > latest.get(tile)!.year)) latest.set(tile, {year, href: asset.href});
        }
        url = page.links?.find((l) => l.rel === "next")?.href;
    }
    return new Map([...latest].map(([tile, {href}]) => [tile, href]));
}

/** One elevation layer over all tiles of the area, and one imagery mosaic layer over them. */
export async function loadSwissArea(area: SwissArea, log: (message: string, error?: boolean) => void) {
    const t0 = performance.now();
    const [elevationTiles, imageryTiles] = await Promise.all([
        findTiles("ch.swisstopo.swissalti3d", ELEVATION_GSD, area),
        findTiles("ch.swisstopo.swissimage-dop10", IMAGERY_GSD, area),
    ]);
    log(`swisstopo catalogue: ${elevationTiles.size} elevation and ${imageryTiles.size} imagery tiles ` +
        `(${area.width} x ${area.height} km), ${Math.round(performance.now() - t0)} ms`);

    const elevationModel = await GeoTiffTileSetModel.create({
        inputs: [...elevationTiles.values()].map((url) => ({url, bands: "height"})),
        dataType: RasterDataType.ELEVATION,
        // Problems reading a tile's data while browsing: shown in the demo's log (the model recovers on its own).
        onReadError: (error) => log(`swissALTI3D: ${error.message}`, true),
    });
    const elevation = new RasterTileSetLayer(elevationModel, {
        label: `swissALTI3D 0.5 m (${elevationTiles.size} tiles, one layer)`,
    });

    const imagery = new LayerGroup({label: `SWISSIMAGE 10 cm (${imageryTiles.size} tiles)`});
    try {
        // One mosaic: the same band names in every tile.
        const mosaic = await GeoTiffTileSetModel.create({
            inputs: [...imageryTiles.values()].map((url) => ({url, bands: ["red", "green", "blue"]})),
            style: {render: {type: "rgb", red: "red", green: "green", blue: "blue", stretch: [0, 255]}},
            onReadError: (error) => log(`SWISSIMAGE: ${error.message}`, true),
        });
        imagery.addChild(new RasterTileSetLayer(mosaic, {label: `SWISSIMAGE (${imageryTiles.size} tiles, one layer)`}));
    } catch (e) {
        log(`SWISSIMAGE: ${(e as Error).message}`, true);
    }
    log(`swisstopo area ready in ${Math.round(performance.now() - t0)} ms (all tiles streamed from data.geo.admin.ch)`);
    return {elevation, imagery};
}
