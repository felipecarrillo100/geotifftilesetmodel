# ria-geotiff demo

A minimal LuciadRIA app to test the library from its sources (`src/`), not from a build.

- **Add** (left): choose what to add, fill in its options, press Add. Layers are appended and the map zooms to them.
  - *swisstopo area*: an LV95 box (east, north, width, height in km), streamed tile by tile from swisstopo:
    swissALTI3D 0.5 m as **one** elevation layer (a mosaic: the same band name in every input) and SWISSIMAGE 10 cm as one imagery mosaic.
  - *Elevation COG (URL)* / *Imagery COG (URL)*: a single COG.
- **Layers** (top right): visibility, zoom to the layer, delete. Always present: the Esri World Imagery basemap and
  the LuciadFusion world elevation (off; switch it on to compare).
- LuciadRIA paints only **one elevation layer** at a time (it hides the others and logs a warning). The layer control
  therefore switches the other elevation layers off when you switch one on, so the checkboxes match what is shown.

```bash
cp /path/to/your/luciadria_development.txt demo/public/license.txt   # once; this file is git-ignored
npm run demo                                                          # http://localhost:5299
```

The LuciadRIA license is **not** part of the repository. The demo uses the repository's own (dev) LuciadRIA, deduped
with the library's, so there is exactly one LuciadRIA in the page.

## Studio

`/studio.html` is the remote-sensing showcase: Sentinel-2 scenes (Earth Search), Landsat surface temperature and
WorldCover (Planetary Computer, tokens fetched automatically), NAIP (one 4-band file) and WorldClim monthly
temperature (12 bands). The WorldClim COG is local: build it once with `./demo/prepare-worldclim.sh` (GDAL, about
40 MB download). Shoelace and Chart.js are demo-only dev dependencies.

The studio starts with only the basemap and the terrain. The panel on the left has two tabs. **Add a layer** takes
any URL or file (also dropped on the map): `identifySource` says what it is, a COG, manifest or STAC item opens at
once (with "✓ COG" or "⚠ not a COG" from `probeCog`), and a STAC API, static catalog or collection opens a stepper:
collection, requirements with Check, items with their footprints on the map, Show on map. The collection list can be
searched (any part of the title or id) and filtered by format: each collection shows the formats of its items
(from `item_assets`, else one item from `StacClient.sampleItem`), and the filter starts on COG and GeoTIFF, the ones
a model opens. Each found item shows its assets by format (`assetFormat`); items without a GeoTIFF are listed but
cannot be chosen. Show on map makes a mosaic, a time series, or a **terrain** (one height mosaic from an asset of
each item, the newest per tile, such as swissALTI3D at 2 m or 0.5 m): collections that look like elevation
(`elevationHint`) default to it, and a note warns when the chosen tiles cover only part of the view. Its Try menu has example URLs, including local
test fixtures (a static catalog, a collection, an item, an item collection, a COG, a GeoTIFF in strips, a manifest)
and two error examples. **Gallery** adds a ready-made scene when one is picked.

Layers accumulate: the **Layers** panel (top right) shows them top first, with visibility, order, zoom and delete;
clicking one makes it the active layer. The **Active layer** panel below it holds the layer's description and its
style; the legend and histogram are under the left panel. "Save the current layer as a manifest…" is in the Style
JSON tab.

With "Log library calls to the console" ticked (the default), every library and LuciadRIA call of Add a layer and of
the layer list is logged in the browser console as copy-pasteable TypeScript, under its workflow step ("1
Capabilities", "2 Choose", "3 Create", "4 Layer", "5 Style"), with a summary of the result and its duration; secrets
are shown as `<redacted>`.

## Data

Recommended: build a 10 x 8 km test area around Zermatt and the Matterhorn (about 70 MB of downloads; the result is a
53 MB elevation COG and an 8 MB imagery COG in `demo/public/data/`, git-ignored). The demo opens it automatically.

```bash
demo/fetch-swisstopo.sh                     # or: demo/fetch-swisstopo.sh <name> <E_min> <N_min> <E_max> <N_max>
```

Without it, the demo streams swisstopo's single Matterhorn tile (1 km) directly from swisstopo, which serves COGs with
HTTP range and CORS support (swissALTI3D 0.5 m Float32, SWISSIMAGE 10 cm RGB JPEG). One 1 km tile in an otherwise
flat world shows as a block with steep walls: check "LuciadFusion elevation" for surrounding terrain, or use the area.

Data: © swisstopo (free use with attribution). Basemap: Esri, Maxar, Earthstar Geographics, and the GIS User
Community (see Esri's terms of use; production use needs an ArcGIS account).

Other files: put them in the URL fields, or pass `?elevation=<url>&imagery=<url>` (`&fusion=0` hides the LuciadFusion world elevation, shown by default around the data). Local files can be placed
in `demo/public/data/` (git-ignored) and loaded as `/data/<file>.tif`; the unit-test fixtures are served as
`/fixtures/<file>.tif`.

EPSG:2056 is not shipped with LuciadRIA: `src/references.ts` shows how an application registers a definition when
the library reports `UnknownIdentifier`. For LV95 the WKT must use LuciadRIA's `Swiss_Oblique_Mercator` projection
and a `TOWGS84` datum shift.

## Checks

Click the map to read the terrain height LuciadRIA renders there. From the console,
`await demo.probeTerrain([[lon, lat], ...])` looks straight down at each point and returns the rendered heights
(ellipsoidal: about 50 m above the geoid heights of the source in Switzerland).
