# ria-geotiff demo

A minimal LuciadRIA app to test the library from its sources (`src/`), not from a build.

- **Add** (left): choose what to add, fill in its options, press Add. Layers are appended and the map zooms to them.
  - *swisstopo area*: an LV95 box (east, north, width, height in km), streamed tile by tile from swisstopo:
    swissALTI3D 0.5 m as **one** elevation layer (`createFromURLs`) and SWISSIMAGE 10 cm as a group of layers.
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
