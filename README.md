# ria-geotiff

Cloud Optimized GeoTIFF (COG) support for [LuciadRIA](https://www.luciad.com/): one `RasterTileSetModel`,
`GeoTiffTileSetModel`, that streams COGs straight from where they are published with HTTP range requests, and shows
them as **imagery** styled with band math in the browser, or uses them as **terrain**.

- **One factory**, `GeoTiffTileSetModel.create(options)`, for one file (`url`, `file`), several files as bands or
  as a mosaic (`inputs`), STAC items (`stac`) and manifests (`manifest`).
- **Styles** as JSON: composites, indices from expressions (`(nir - red) / (nir + red)`), colour ramps, class tables,
  masks, statistics-based stretches. Restyling costs no requests.
- **Terrain** (`dataType: RasterDataType.ELEVATION`) in the tile layout LuciadFusion uses for its elevation.
- **STAC**: `StacClient` finds collections, checks a selection and picks items, on real servers that differ a lot.
- **One box for any URL**: `identifySource(url)` tells a COG, a manifest, a STAC item, collection, static catalog or
  API apart with one range request (`probeCog` says whether a GeoTIFF is cloud optimized); `StacClient` also crawls
  static catalogs.

LuciadRIA is **not** included: it is a peer dependency, the application provides it.

**Documentation:** the [developer guide](docs/developer-guide.md) (the five-step quick start, concepts, recipes,
troubleshooting), the API reference site (`npm run docs`, then open `build/docs/index.html`) and the
[manifest specification](docs/manifest.md).

## Requirements

- LuciadRIA 2024.1 or later (peer dependency; built and tested with 2026.1.2).
- An ES module bundler (Vite, webpack, ...) or TypeScript.

## Install

```bash
npm install ria-geotiff
```

## Usage

```ts
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {GeoTiffTileSetModel} from "ria-geotiff";

const map = ...;   // your LuciadRIA WebGLMap
const url = ...;   // URL of a COG
const model = await GeoTiffTileSetModel.create({url});   // an automatic style: true colour, or grey
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
```

The file should be a COG (tiled, with its header at the start of the file) served with HTTP range support; for
cross-origin URLs the server must allow CORS (`Access-Control-Allow-Origin`, and `Range` in
`Access-Control-Allow-Headers`). A dropped file: `GeoTiffTileSetModel.create({file})` with the `File`, an `ArrayBuffer` or a geotiff.js
`GeoTIFF`.

### Bands and styles

```ts
const redUrl = ..., nirUrl = ...;        // single-band COGs
const model = await GeoTiffTileSetModel.create({
  inputs: [{url: redUrl, bands: "red"}, {url: nirUrl, bands: "nir"}],
  style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9],
           colorMap: ramp("rdylgn")}},   // ramp from "ria-geotiff/ramps" (optional ready-made data)
});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "NDVI"}));
await model.setStyle({render: {type: "rgb", red: "nir", green: "red", blue: "red"}});   // no new requests
```

- Band names are set once: per input (`bands: ["red", "green", "blue", "nir"]`), or by 1-based location
  (`bands: {red: "f1_b3", nir: "f2_b1"}`). Without names: GDAL band descriptions, else `b1`…`bN`.
- Renders: `rgb`, `pseudocolor` (`band` or `expression` through a ramp or class table), `custom` (your own paint).
- Stretches: `[min, max]`, `{type: "percentile", low, high}` (default 2–98), `{type: "stddev", n}`, `{type: "minmax"}`.
- Masks: `{band, values}`, `{band, bits}`, `{band, range}`, `{expression}`, with `invert`.
- Expressions are parsed by a fixed grammar, never evaluated as JavaScript: user-typed expressions are safe.
- `withStyle(style)` makes a twin with another style sharing files and caches (swipe comparisons).

### Terrain and mosaics

One DEM file as terrain:

```ts
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";

const demUrl = ...;                      // URL of a single-band DEM
const terrain = await GeoTiffTileSetModel.create({url: demUrl, dataType: RasterDataType.ELEVATION});
map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
```

A DEM published as tiles is one **mosaic**: where tiles overlap, the first one wins.

```ts
const tileUrls: string[] = ...;          // the tiles of one DEM
const terrain = await GeoTiffTileSetModel.create({
  inputs: tileUrls.map((url) => ({url})),
  dataType: RasterDataType.ELEVATION,
});
```

For imagery, a mosaic is the same band name in several inputs (`inputs: urls.map((url) => ({url, bands: ["red", "green", "blue"]}))`).
Units, several bands, combining DEMs: see the guide, section 4.4.

Elevation tiles are delivered as LuciadFusion delivers its elevation (LTS) tiles: a quadtree of **64 x 64 point
samples** per tile spanning the tile edge to edge (no seams), encoded as LuciadFusion's **LuciadElev0 PNG**. Heights
are interpolated (bilinear, nodata aware) from the most suitable image; GDAL scale/offset is applied. With several
bands, `elevation.height` names one or combines them (`"where(isnan(lidar), national, lidar)"`);
`elevation.noDataHeight` replaces missing data. LuciadRIA shows **one elevation layer** at a time: make a tiled DEM one
mosaic model. `model.asElevation()` and `terrain.withStyle(style)` make twins that read nothing twice.

To turn any elevation file into a suitable COG, use [`scripts/elevation-to-cog.sh`](scripts/elevation-to-cog.sh)
(GDAL): a single Float32 band with nodata, optional reprojection, 256 x 256 tiles, DEFLATE and averaged overviews.

### Finding data with STAC

```ts
import {StacClient} from "ria-geotiff/stac";

const catalogUrl = ...;    // the STAC API URL the user entered
const area = ...;          // [west, south, east, north] the user drew
const catalog = await StacClient.connect(catalogUrl);
const collections = await catalog.collections({area});            // 1. capabilities
const id = ...;                                                   // the collection the user picked
const collection = await catalog.collection(id);                  // interval, bands, queryables
const selection = {collection: id, area, datetime: "2024", maxCloud: 10};
const problems = catalog.check(selection, collection);            // 2. choose: [] when it fits
const found = await catalog.select({...selection, pick: {per: "month"}});
const model = await GeoTiffTileSetModel.create({stac: {items: found.items, per: "month"}});   // 3. model
map.layerTree.addChild(new RasterTileSetLayer(model, {label: id}));                         // 4. layer
model.getSource().periods;   // ["2024-01", ...]: bands red_2024_01, ... for a time slider
```

Items of one period are a mosaic, several periods a time series; the model has every band of the items, and opens an
asset when a style first reads it. The
client compiles each search for the server (CQL2-JSON, CQL2-text, Query extension or a client-side filter), verifies
the first page and falls back when a filter was ignored; `plan.degradations` says what it did. Planetary Computer
assets are signed automatically.

### Coordinate references and errors

The model uses the EPSG code in the GeoTIFF, else the input's `crsName` (STAC sources take it from `proj:code` /
`proj:epsg`, for files with a user-defined projection), else a `.prj` file next to it; `options.reference` overrides
them all. When LuciadRIA
does not know the code, `GeoTiffTileSetModel.create` rejects with a `GeoTiffModelError` whose `cause` is `"UnknownIdentifier"` and whose
`identifier` is the code: register its definition with `addReference(parseWellKnownText(wkt), identifier)` and try
again. Other causes: `ERROR_LOADING_FILE`, `BoundsMissing`, `INVALIDELEVATION`, `REFERENCE_MISMATCH`.
`GeoTiffTileSetModel.create` never throws synchronously. Problems while browsing are reported once each as a `GeoTiffReadError` to
`onReadError` / `addReadErrorListener` (shared with twins), else logged with `console.warn`.

### Protected data

`credentials`, `requestHeaders` and `requestParameters` are LuciadRIA's `HttpRequestOptions`, accepted by `GeoTiffTileSetModel.create`,
per input, and by `StacClient.connect`. They are sent only to the origin of a URL the application gave for them, never
to discovered URLs (manifest files on another server, STAC assets, links to other hosts); a redirect to another
origin is refused. `model.requestHeaders = {...}` renews a token for the next requests. They are never written to
manifests or shown in messages.

### Inspecting a file, and migrating from 0.0.x

`GeoTiffTileSetModel.infoFromURL(url)` (size, bands, data type, CRS, tiling, COG layout) and `model.getModelInfo()`
are the first step for a single file. Coming from 0.0.x: the URL factory and the gradient, band mapping and nodata
setters are replaced by `GeoTiffTileSetModel.create` with a `style`, see the
[migration table](docs/developer-guide.md#migrating-from-00x).

## geotiff.js version

ria-geotiff depends on geotiff.js `~3.0.5` (3.0.x patch releases, not 3.1 automatically).

geotiff.js 3.0.4 and 3.0.5 contain a regression: `fromUrl()` no longer batches reads into cached blocks unless a
`blockSize` is given (geotiff.js [#516](https://github.com/geotiffjs/geotiff.js/pull/516)). Each read becomes a
separate small range request, and in browsers that ends in refused requests and corrupt data
("Offset is outside the bounds of the DataView"), for example when a terrain tile reads from many COGs at once.
ria-geotiff always passes `blockSize: 65536`, which avoids it; a unit test checks that all range requests are whole,
64 KiB-aligned blocks.

**Recommendation: move to geotiff.js `^3.1.0` as soon as it is published on npm.** 3.1.0 fixes the regression
upstream ([#530](https://github.com/geotiffjs/geotiff.js/pull/530)) and includes an LZW decoder fix
([#546](https://github.com/geotiffjs/geotiff.js/pull/546)); it is tagged on GitHub but its npm release failed
([#540](https://github.com/geotiffjs/geotiff.js/issues/540)). When upgrading, keep the explicit `blockSize`, run
`npm run verify`, and check a large mosaic in the demo (for example a 10 x 12 km swisstopo area) for read errors.

## Development

```bash
npm install
npm test            # unit tests (Vitest), offline, with small COG fixtures in test/fixtures
npm run typecheck   # library, tests and demo
npm run build       # lib/ with tsc (no bundler: LuciadRIA and geotiff.js stay external imports)
npm run verify      # all of the above + check that lib/ contains no LuciadRIA code + publint
npm run demo        # the demo app, see demo/README.md
```

The fixtures are generated with `test/fixtures/make-fixtures.py` (GDAL Python bindings).

**LuciadRIA must never be bundled into this library.** It is a `peerDependency` (`>=2024.1`) and a pinned
`devDependency` for building and testing only; `npm run check:no-ria` (part of `verify` and `prepublishOnly`) fails
if any of its code ends up in `lib/`.

## License

MIT. See [CHANGELOG.md](CHANGELOG.md) for changes.
