# ria-geotiff developer guide

ria-geotiff brings Cloud Optimized GeoTIFFs (COGs) into [LuciadRIA](https://www.luciad.com/). It streams the files
straight from where they are published, reading only the parts in view with HTTP range requests, and turns them into
LuciadRIA raster models: imagery styled with band math in the browser, or terrain. It finds files for you in STAC
catalogs, and opens datasets described in a small JSON manifest.

**Contents**

1. [Overview](#1-overview)
2. [Installation and setup](#2-installation-and-setup)
3. [Quick start: five steps](#3-quick-start-five-steps)
4. [Concepts](#4-concepts)
5. [Recipes](#5-recipes)
6. [API reference](#6-api-reference)
7. [Errors](#7-errors)
8. [Performance and limits](#8-performance-and-limits)
9. [Security and protected data](#9-security-and-protected-data)
10. [Compatibility and versioning](#10-compatibility-and-versioning)
11. [Troubleshooting](#11-troubleshooting), including [Frequently asked questions](#frequently-asked-questions)
12. [Glossary](#12-glossary)

---

## 1. Overview

### What it does

| You have | You call | You get |
|---|---|---|
| One COG: an orthophoto, a DEM, a single-band raster | `GeoTiffTileSetModel.create({url})` | Imagery with an automatic style, or terrain (`dataType: ELEVATION`) |
| Several COGs: bands in separate files (Sentinel-2, Landsat), tiles of one dataset | `GeoTiffTileSetModel.create({inputs})` | Composites and indices from named bands; tiles with the same band name form a mosaic |
| A STAC catalog (Earth Search, Planetary Computer, …) | `StacClient` then `GeoTiffTileSetModel.create({stac})` | Search by area, date and properties, pick items, a mosaic or a time series |
| A dataset description to share | `GeoTiffTileSetModel.create({manifest})` | The create options as a JSON file, opened in one call |

### How it works

```
  COG files (HTTP range requests, only the blocks in view)
        │
        ▼
  geotiff.js decoding (web workers) ──► decoded blocks and decoded band tiles (caches)
        │
        ▼
  GeoTiffTileSetModel
    imagery:  bands → expression → mask → stretch → colour map → RGBA tiles
    terrain:  height (a band or an expression) → LuciadFusion elevation tiles
        │
        └──────────────► LuciadRIA RasterTileSetLayer (2D or 3D, draped on terrain)
```

Everything runs in the browser: no tile server, no preprocessing. Restyling re-renders from the cache without new
requests.

### Entry points

| Import | Contains |
|---|---|
| `ria-geotiff` | `GeoTiffTileSetModel`, styles, expressions, colour-map functions, statistics, manifests, errors |
| `ria-geotiff/stac` | `StacClient` (capabilities, check, select), search plans, selection helpers, asset signing |
| `ria-geotiff/ramps` | Optional ready-made colour ramps and class tables (plain data) |
| `ria-geotiff/presets` | Optional ready-made styles: composites, indices, class styles, cloud masks |

---

## 2. Installation and setup

```bash
npm install ria-geotiff @luciad/ria
```

- **LuciadRIA is a peer dependency.** ria-geotiff never bundles it; your application provides one copy. Supported:
  LuciadRIA 2024.1 or later (built and tested with 2026.1.2). With Vite, add `resolve: {dedupe: ["@luciad/ria"]}`.
- **geotiff.js** (`~3.0.5`) is a regular dependency.
- **The LuciadRIA license** must be set before RIA modules that need it are evaluated, so load your app dynamically
  after `setLicenseText(...)`:

  ```ts
  import {setLicenseText} from "@luciad/ria/util/License.js";
  setLicenseText(await (await fetch("./license.txt")).text());
  await import("./app.js");
  ```

- **Serving COGs:** the server must answer HTTP range requests, and for cross-origin URLs send CORS headers
  (`Access-Control-Allow-Origin`, `Range` allowed in `Access-Control-Allow-Headers`).
- **Coordinate references:** LuciadRIA knows common references (EPSG:4326, 3857, …). For others (UTM zones, national
  grids) register a WKT definition, see [Unknown coordinate references](#unknown-coordinate-references).

---

## 3. Quick start: five steps

The API is built around one workflow:

1. **Query capabilities**: what a catalog or a file offers.
2. **Choose** what you are interested in, from what step 1 returned.
3. **Create the model**: one factory, `GeoTiffTileSetModel.create(options)`.
4. **Add the model to a layer**. Done.
5. **Style** at creation, or later with `model.setStyle(...)`.

To watch the workflow on real data, open the browser console in the studio (`npm run demo`, then `/studio.html`):
with "Log library calls to the console" ticked in its Add a layer tab, each call it makes is logged as
copy-pasteable TypeScript under its step number, with a summary of the result and the time it took.

### From a STAC catalog

```ts
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {GeoTiffTileSetModel} from "ria-geotiff";
import {StacClient} from "ria-geotiff/stac";

const map = ...;          // your LuciadRIA WebGLMap
const catalogUrl = ...;   // the STAC API URL the user entered
const area = ...;         // [west, south, east, north] the user drew

// 1. Capabilities.
const catalog = await StacClient.connect(catalogUrl);
const collections = await catalog.collections({area});      // CollectionSummary[]
const id = ...;                                              // the id the user picked
const collection = await catalog.collection(id);            // CollectionDetails: interval, bands, queryables

// 2. Choose.
const from = ..., to = ...;                                  // dates within collection.interval
const userFilters = ...;                                     // e.g. {"eo:cloud_cover": {lt: 20}}, from collection.queryables
const chosenBands = ...;                                     // from collection.bands; here it includes "red" and "nir"
const selection = {collection: id, area, datetime: [from, to], where: userFilters, bands: chosenBands};
const problems = catalog.check(selection, collection);      // [] when the request fits the collection; no requests
const found = await catalog.select({...selection, pick: {per: "year"}});   // items, periods, plan; rejects when nothing fits
const chosenItems = ...;                                     // found.items, or the ones the user ticked

// 3. Model: items of one year are a mosaic, several years a time series (bands red_2024, nir_2024, ...).
const model = await GeoTiffTileSetModel.create({stac: {items: chosenItems, per: "year", bands: chosenBands}});

// 4. Layer.
map.layerTree.addChild(new RasterTileSetLayer(model, {label: collection.title ?? id}));

// 5. Style. In a time series, band names end with "_" and the period label ("-" becomes "_": 2024-07 gives
// red_2024_07). With a single period there is no suffix and getSource().periods is undefined.
const periods = model.getSource().periods;
const s = periods ? `_${periods.at(-1)!.replace(/[^A-Za-z0-9_]/g, "_")}` : "";
await model.setStyle({render: {type: "pseudocolor", expression: `(nir${s} - red${s}) / (nir${s} + red${s})`,
  stretch: [-0.2, 0.9]}});
```

### From a single file

```ts
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {GeoTiffTileSetModel} from "ria-geotiff";
import {ramp} from "ria-geotiff/ramps";

const map = ...;          // your LuciadRIA WebGLMap
const url = ...;          // URL of a COG the user chose

// 1. Capabilities: size, bands, data type, reference (reads the header only).
const info = await GeoTiffTileSetModel.infoFromURL(url);
// 2. Choose: imagery or terrain.
const terrain = info.canBeElevation && info.bands === 1;
// 3. Model, with the automatic style for imagery (true colour, or the first band in grey).
const model = await GeoTiffTileSetModel.create(terrain ? {url, dataType: RasterDataType.ELEVATION} : {url});
// 4. Layer.
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
// 5. Style (imagery only). Band names come from the file: its GDAL band descriptions, else b1…bN.
if (!terrain) {
  const [first] = model.getBandNames();
  await model.setStyle({render: {type: "pseudocolor", band: first, stretch: {type: "minmax"}, colorMap: ramp("viridis")}});
}
```

A style that names `b1`, `b2`, `b3` works only when the file has no GDAL band
descriptions: otherwise the bands carry those names, and the style rejects with a `StyleError` that lists the
available names. To be independent of the file, name the bands yourself: `GeoTiffTileSetModel.create({url, bands: {red: "b1", green:
"b2", blue: "b3"}})`.

### From several files and from a manifest

```ts
const redUrl = ..., nirUrl = ...;        // single-band COGs
const ndvi = await GeoTiffTileSetModel.create({
  inputs: [{url: redUrl, bands: "red"}, {url: nirUrl, bands: "nir"}],
  style: {render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9]}},
});
map.layerTree.addChild(new RasterTileSetLayer(ndvi, {label: "NDVI"}));

const manifestUrl = ...;                 // URL of a ria-geotiff manifest
const dataset = await GeoTiffTileSetModel.create({manifest: manifestUrl});
map.layerTree.addChild(new RasterTileSetLayer(dataset, {label: "Dataset"}));
```

---

## 4. Concepts

### 4.1 One model, two data types

`GeoTiffTileSetModel` is the only model. LuciadRIA fixes a model's `dataType` when it is constructed, so a model is
**imagery** (`RasterDataType.IMAGE`, the default) or **terrain** (`RasterDataType.ELEVATION`) for its whole life.
To show the same data both ways, make a **twin**: a second model over the same open files and caches.
`model.asElevation()` gives a terrain twin, `model.withStyle(style)` an imagery twin. Twins share files, downloads,
decoded blocks and decoded tiles, so showing one DEM as terrain and as a coloured layer reads nothing twice.

- **Imagery** tiles form a quadtree of `tileSize` × `tileSize` pixel tiles (default 256; an integer from 16 to 4096,
  else `GeoTiffTileSetModel.create` rejects with a `RangeError`), in the model's reference.
  The quadtree starts at the north-west corner of the data extent and can reach past its east and south edges. Its
  deepest level has the pixel size of the finest input; each level above halves the resolution, up to level 0,
  which has as few tiles as cover the data. For each tile, every input is read from one image: the coarsest
  overview whose pixels are still at least as fine as the tile's pixels. That image is resampled onto the tile:
  bilinear by default, nearest when the input sets `resampling: "nearest"`. STAC sources choose nearest for class
  and mask assets; for other inputs set it yourself.
- **Terrain** tiles are delivered as LuciadFusion delivers elevation: 64 × 64 point samples per tile spanning the
  tile edge to edge (neighbouring tiles share their edge samples, so there are no seams), encoded as LuciadElev0
  PNG (see the [glossary](#12-glossary)). The values are used as metres (see [4.4](#44-elevation)).

### 4.2 Sources

`GeoTiffTileSetModel.create(options)` takes exactly one source:

| Source | Meaning |
|---|---|
| `url` | One GeoTIFF by URL (shortcut for `inputs: [{url}]`) |
| `file` | One GeoTIFF from memory: a `File`/`Blob`, an `ArrayBuffer` or an opened geotiff.js `GeoTIFF` |
| `inputs` | Several GeoTIFFs: as bands (different names) and/or as a mosaic (the same name) |
| `stac` | STAC items the user chose (`{items, per}`), or a selection to search (`{catalog, collection, ...}`) |
| `manifest` | A manifest: these same options saved as JSON |

`model.getSource()` returns what was opened: `{kind, items?, periods?, plan?, found?, manifest?}`. A time slider reads
`periods`, a list reads `items`.

What `GeoTiffTileSetModel.create` requests for each source, before it resolves, is listed in the FAQ:
[What does GeoTiffTileSetModel.create() request?](#what-does-create-request-before-it-resolves).

In this guide, a model's **source** is what it is opened from (this table). The bands and expressions a style reads
are called **value sources** ([4.5](#45-styles)); `getStatistics()` returns one entry per value source.

### 4.3 Bands and mosaics

Styles and expressions only use band names, so name bands once, when the model is created:

```ts
// Per input, in file order (null skips a band):
inputs: [{url: naipUrl, bands: ["red", "green", "blue", "nir"]}]
// Or by location for the whole model: input N, band M, both 1-based (as in GDAL). One input: "b3" is enough.
inputs: [{url: rgbUrl}, {url: nirUrl}], bands: {red: "f1_b1", green: "f1_b2", blue: "f1_b3", nir: "f2_b1"}
```

Without names, bands take the files' GDAL band descriptions (when every band of the file has one, all unique and
valid identifiers), else `b1`…`bN` (one input) or `f1_b1`… (several). Names are identifiers: letters, digits and
`_`, not starting with a digit. `model.getBandNames()` lists them.

**Bands you do not name** do not exist in the model. With location names (`bands: {red: "f1_b3"}`), only the named
bands exist; with per-input names, `null` (or a missing entry at the end of the list) skips a band. A band that does
not exist cannot be used in styles, expressions or `getValuesAt`, and is never read. Every input is still opened
(its header is read), even when none of its bands is named.

**The same band name in several inputs is a mosaic**: where inputs overlap, the first input with data at a pixel
wins (input order is priority), and the extent is the union. "Data" means a value that is not nodata, not NaN and
not hidden by the file's internal mask. This is how adjacent tiles of one dataset, or several STAC items of one
date, become one picture.

**Different resolutions** are allowed: each input is resampled onto the tiles from its best-matching overview
([4.1](#41-one-model-two-data-types)). **Different references** are not: all inputs must declare the same one, else
`GeoTiffTileSetModel.create` rejects with cause `REFERENCE_MISMATCH`. There is no reprojection: make one model per reference.

### 4.4 Elevation

`dataType: RasterDataType.ELEVATION` turns the model into terrain: heights in metres, shown by LuciadRIA as the
map's elevation. Every example below adds only what the one before it lacks. All of them need:

```ts
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {GeoTiffTileSetModel} from "ria-geotiff";

const map = ...;   // your LuciadRIA WebGLMap
```

**1. One DEM file.** One band: that band is the height. Nothing else to set.

```ts
const demUrl = ...;   // URL of a DEM COG
const terrain = await GeoTiffTileSetModel.create({url: demUrl, dataType: RasterDataType.ELEVATION});
map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
```

**2. A DEM the user opened from disk.** `file` instead of `url`.

```ts
const demFile = ...;   // a File from <input type="file"> or a drop
const terrain = await GeoTiffTileSetModel.create({file: demFile, dataType: RasterDataType.ELEVATION});
```

**3. A DEM published as tiles.** Several single-band files form one mosaic. Where tiles overlap, the first URL wins.

```ts
const tileUrls: string[] = ...;   // the tiles of one DEM, in the same reference
const terrain = await GeoTiffTileSetModel.create({
  inputs: tileUrls.map((url) => ({url})),
  dataType: RasterDataType.ELEVATION,
});
```

**4. Heights in feet.** Heights are used as stored; `scale` converts them to metres.

```ts
const terrain = await GeoTiffTileSetModel.create({
  inputs: [{url: demUrl, scale: 0.3048}],
  dataType: RasterDataType.ELEVATION,
});
```

**5. A file with several bands.** Say which band is the height, by its name (`b2`, or the file's GDAL band
description). Without it, `GeoTiffTileSetModel.create` rejects with a `RangeError` that lists the band names.

```ts
const terrain = await GeoTiffTileSetModel.create({
  url: multiBandUrl,
  dataType: RasterDataType.ELEVATION,
  elevation: {height: "b2"},
});
```

**6. Two DEMs combined.** Name the inputs, then give the height as an expression: here a detailed lidar DEM,
with its holes filled from a national DEM.

```ts
const terrain = await GeoTiffTileSetModel.create({
  inputs: [{url: lidarUrl, bands: "lidar"}, {url: nationalUrl, bands: "national"}],
  dataType: RasterDataType.ELEVATION,
  elevation: {height: "where(isnan(lidar), national, lidar)"},
});
```

**7. A height where there is no data.** By default missing samples are delivered as nodata, and LuciadRIA shows
its default terrain there. `noDataHeight` (metres) replaces them instead.

```ts
const terrain = await GeoTiffTileSetModel.create({
  url: demUrl,
  dataType: RasterDataType.ELEVATION,
  elevation: {noDataHeight: 0},
});
```

**8. The same DEM as terrain and as a coloured image.** A twin shares the files and decoded data, so nothing is
read twice. See [Terrain and a coloured view of the same DEM](#terrain-and-a-coloured-view-of-the-same-dem).

Details:

- **Band names**: one file, as in 4.3. Several single-band files with no `bands` on any input: all of them are
  one band named `elevation` (example 3). As soon as one input names its bands, the usual rules apply.
- **Units**: LuciadRIA expects metres. Values are used as stored, after the input's `scale` and `offset` (or the
  file's GDAL scale and offset tags); nothing else is converted.
- **No data**: nodata values, NaN, pixels outside every input and expressions that give NaN are missing. They are
  delivered as nodata in the LuciadElev0 encoding, or as `elevation.noDataHeight` when it is set.
- **Sampling**: heights are interpolated bilinearly, nodata aware, from the image of each input whose pixels best
  match the tile's sample spacing. A failed overview read falls back to a finer image, then to nodata.
- **Tiles**: 64 x 64 point samples per tile, as LuciadFusion serves elevation; `elevation.tileSize` changes it (an
  integer of at least 2, else a `RangeError`).
- **Options that apply**: `elevation`, `reference`, `cacheSize`, `decodedBlocks`, `byteCacheSize`, the HTTP and
  signing options. **Ignored**: `tileSize`, `statisticsSize`, `resampling`. A `style` is rejected (`RangeError`):
  terrain has no style, statistics or legend, so `getStyle()` and `getLegend()` return null.
- **Data that cannot be terrain**: colour images (RGB, YCbCr, ...) reject with `GeoTiffModelError` cause
  `INVALIDELEVATION`.
- **One elevation layer**: LuciadRIA shows one elevation layer at a time, so combine DEMs in one model
  (examples 3 and 6), not in several layers.

### 4.5 Styles

A style is a JSON object: what to compute per pixel, and how to colour it.

```ts
{
  render: {type: "rgb", red: "swir22", green: "nir", blue: "red", stretch: {type: "percentile", low: 2, high: 98}, gamma: 1.2},
  mask: [{band: "scl", values: [3, 8, 9, 10]}]
}
```

The pipeline per pixel: **value sources** (the bands or expressions the render reads: three for `rgb`, one for
`pseudocolor`, the `sources` of `custom`) → **mask** → **stretch** to 0..1 → **gamma** → **colour**.

| Render | For | Fields |
|---|---|---|
| `rgb` | Band combinations | `red`, `green`, `blue` (a band, an expression, or `{band \| expression, stretch, gamma}`), `stretch`, `gamma`, `saturation` |
| `pseudocolor` | One value per pixel: a band, an index, classes | `band` or `expression`, `stretch`, `colorMap`, `gamma` |
| `custom` | Full control (not JSON) | `sources`, `stretch`, `paint({values, n, ranges, out})` writes RGBA bytes |

**Stretches** map data values (after scale and offset) to 0..1; values outside are clamped. `[min, max]` or
`{type: "fixed", min, max}` (fixed), `{type: "percentile", low, high}` (the default when `stretch` is not set,
2–98 %), `{type: "stddev", n}` (mean ± n standard deviations, default 2), `{type: "minmax"}`. The last three need
statistics of the whole data extent, see [4.7](#47-statistics-caching-and-restyling). A class table ignores the
stretch.

**Colour maps** are data in the style: a **ramp** (`{stops: [{position, color}], blend, spacing}`), a **class
table** (`{type: "table", entries: [{value, color, label}]}`, values matched in float32 precision, so `0.1`
matches a stored float32 0.1) or a function `(t, value) => [r, g, b, a?]` (`t` is the position after `gamma`,
`value` the data value drawn there).

**Masks** hide pixels: `{band, values}`, `{band, bits}`, `{band, range}`, `{expression}`, optionally `invert`ed.
Missing data (no-data values, NaN, outside every input) is transparent. A mask rule without data at a pixel (NaN in
its band, or in a band its expression reads) hides it too, inverted or not: NaN is no data, and no data is hidden.

**Default style.** Without `style`, `GeoTiffTileSetModel.create` chooses one from the band names:

| Model | Default style |
|---|---|
| One file with one band and a colour palette (PhotometricInterpretation "palette") | The palette as a class table |
| STAC time series | True colour of the last period (`red_<p>`, `green_<p>`, `blue_<p>`, 1–99 % stretch), else its first band in grey |
| Bands named `red`, `green` and `blue` | `autoStyle`: true colour, 2–98 % stretch, gamma 1.2 |
| Three or more other bands | `autoStyle`: the first three bands as red, green, blue (in band order), 2–98 % stretch |
| One or two bands | `autoStyle`: the first band in grey, 2–98 % stretch |

The 2–98 % stretch needs statistics, so `GeoTiffTileSetModel.create` reads the statistics sample before it resolves. Invalid styles
reject with a `StyleError` whose `path` names the property (`render.colorMap.stops[2].color: invalid colour
"blue"`).

### 4.6 Expressions

Band math in a safe grammar (never evaluated as JavaScript):

```
(nir - red) / (nir + red)
2.5 * (nir - red) / (nir + 6 * red - 7.5 * blue + 1)
where(scl == 6, 1, 0)
nir_2026 - nir_2018
```

| | |
|---|---|
| Operands | numbers, band names, `pi` |
| Operators | `+ - * / ^` (or `**`), `< <= > >= == !=`, `&& \|\| !` |
| Functions | `abs sqrt log log10 exp floor ceil round sin cos tan atan atan2 pow min max clamp where mean isnan` |
| JSON form | `["/", ["-", "nir", "red"], ["+", "nir", "red"]]`; `["band", 4]` is `b4` |

Results that are not finite are no data. Comparisons and `&&`, `||`, `!` give 1 or 0. Band names are case
sensitive. Invalid expressions throw `ExpressionError`, synchronously, from `parseExpression` and
`compileExpression`; its `position` is the 0-based index of the offending character (the message says
`at character N`, 1-based). Inside a style the same problem is a `StyleError` with the style path.

### 4.7 Statistics, caching and restyling

- **Statistics** (count, min, max, mean, standard deviation and a 256-bin histogram per value source) are computed
  when a style has a `percentile`, `stddev` or `minmax` stretch. The sample is a grid with `statisticsSize` (512)
  points along the longer side of the **whole data extent**, read from the overview of each input whose pixels match
  the grid spacing. NaN, nodata and pixels hidden by the style's mask are left out.
- **When**: before `GeoTiffTileSetModel.create`, `setStyle` and `withStyle` resolve. `setStyle` applies a new style **once its
  statistics exist**, so the layer never shows a fallback stretch. Statistics are kept per value source and mask,
  and the sampled band values are kept too: a new style over the same bands needs no reads for its statistics.
- **They do not follow the view**: colours stay the same while the user pans and zooms. For a stretch of the
  visible area call `computeStatistics(bounds)`
  ([recipe](#pixel-values-and-a-stretch-adapted-to-the-view)); later styles use that region until the next call, and
  twins made afterwards with `withStyle` start with that region and its statistics, so a swipe compares the same
  stretch.
- **Caches**, all shared with twins:

  | Cache | Holds | Size |
  |---|---|---|
  | Fetched bytes | 64 KiB blocks of each file, as downloaded | `byteCacheSize` (16 MiB) per input |
  | Decoded blocks | File blocks decompressed by geotiff.js | `decodedBlocks` (96) blocks for the model |
  | Decoded band tiles | Float32 band values of each rendered tile | `cacheSize` (256 MiB) for the model |

  Least recently used entries are dropped first. Switching between styles over cached bands costs no requests.
- **Reads in flight are shared and never cancelled**: LuciadRIA aborts pending tiles on every restyle, and the new
  requests need the same data.
- **8-bit RGB fast path**: an `rgb` style over three 8-bit bands of one file, without mask, saturation, nodata or
  scale/offset, on tiles whose pixels coincide with the pixels of an image of the file, goes straight from the bytes
  to RGBA through per-channel tables. The colours are the same as on the normal path; it is only faster.

### 4.8 STAC

`ria-geotiff/stac` follows steps 1 and 2 of the workflow:

- `StacClient.connect(url)`: reads the landing page (one request; on failure once more with a trailing slash), and
  `/conformance` when the landing page lists no conformance classes. Capabilities come from those classes and links.
- `catalog.collections(filter)`: summaries of the collections overlapping an area, a period, a text. The first call
  lists all collections (following `next` links) and caches the list; the filter runs in the client.
- `catalog.collection(id)`: one collection with its queryables, data assets and JSON (at most two requests).
- `catalog.check(selection, collection)`: problems before searching (area or period outside the collection, bands it
  lacks, filters on properties it does not describe). No requests; errors and warnings are returned, not thrown.
- `catalog.select(selection, {signal, onProgress})`: reads the collection, checks the selection, searches (100 items
  per page, up to `maxItems`, default 300) and picks items with `pick`: `months`, then `coverage`, then `per` or
  `rank`. `signal` (an `AbortSignal`) stops its requests; `onProgress` receives a `StacProgress` (`step`, `pages`,
  `scanned`, `kept`, `matched`) when the collection is read, after every page, and before picking. The result's
  `candidates` lists every item found as a `StacCandidate`: `{item, picked, reason?, coverage?, period?}`, where
  `reason` is `"months"`, `"coverage"`, `"reference"` or `"rank"`. With an area the default `pick.coverage` is
`"full"` (one item containing the whole area); for a view larger than a scene use `"best"`, a mosaic.
- A collection's `bands` are named as its item_assets allow: `bandNaming` is `"common-names"` (presets fit),
  `"asset-keys"` or `"none"`. The model names bands from the items, which may say more: `getBandNames()` decides.

**Periods** group items by time, in UTC: `day`, `solar-day` (the local day at each item's centre longitude,
`solarLongitude(item)`, so one satellite pass that crosses midnight UTC stays in one day), `week` (ISO 8601),
`month`, `quarter`, `year`. Their labels are `2024-07-15`, `2024-W29`, `2024-07`, `2024-Q3`, `2024`. `select`,
`groupItems`, `bestPerPeriod` and `GeoTiffTileSetModel.create({stac: {items, per}})` use the same solar-day rule, so
items picked per solar day keep their periods in the model.

Then `GeoTiffTileSetModel.create({stac: {items}})` makes the model: items of one period (`per`, default `"day"`) are a mosaic; several
periods a time series. In a time series each band name gets `_` and the period label, with every character other
than a letter, digit or `_` replaced by `_`: `red_2024` (year), `red_2024_07` (month), `red_2024_Q3`. The model has
a band for every data asset of the items: `getBandNames()` lists them all. `create` opens only the assets its style
reads; a later `setStyle`, `withStyle` or `asElevation` that reads other bands opens their assets first (one header
read per COG, shared with twins). `getBands()` lists the bands opened so far.
Class and mask assets are read with nearest resampling. `GeoTiffTileSetModel.create({stac: {catalog, collection, ...}})` does the
selection itself: without `pick.per` its items are one mosaic.

All items of a model must share a coordinate reference. When `select` can return several items (with `pick.per`, or
the mosaic of `coverage: "best"`), it uses the candidates of one `proj:code` (or `proj:epsg`) only: with an area the
reference whose items together cover most of it, then the one with most candidates, then the one that sorts first.
The candidates of the other references are listed in the result's `dropped` (`[{reference, items}]`) and reported
by a warning with path `pick` in `problems`. Items you pass yourself are not grouped: mixed references make
`GeoTiffTileSetModel.create` reject with `REFERENCE_MISMATCH`, so group them first with `groupItems(items, "crs")`.

**When nothing fits**, `select` rejects with a `StacError` whose `problems` say which rule excluded how many items
(`pick.months`, `pick.coverage`). When the search itself found nothing, requirements tested in the browser (static
catalogs, items endpoints, filters the server cannot apply) are counted per path (`datetime`, `area`, `maxCloud`,
`where.{property}`: "excluded 2 of the 2 item(s) read"; `StacSearch.rejected` gives the same counts for any search);
what the server filtered is not seen, so then the message lists the filters to widen. The common case: no
single item contains the whole area. The default `pick.coverage: "full"` then leaves nothing; `"best"` returns the
fewest items that cover the area, a mosaic.

**A server without STAC item search** is searched through its collections' `items` endpoints when it has a collections
endpoint (`capabilities.search` `"collection-items"`, see below), or crawled when it is a static catalog. Only when
neither applies (`"none"`) do `plan` and `search` throw a `StacError` synchronously, and `select` and
`GeoTiffTileSetModel.create({stac: {catalog, ...}})` reject with it.

**Static catalogs** (a `catalog.json` or `collection.json` file and the files it links, no API): `StacClient.connect`
recognises a landing page that is a `Catalog` or `Collection` without item search and without a collections endpoint,
and sets `capabilities.staticCatalog`. It then makes no conformance request, `collections()` crawls `child` links
(breadth first, relative hrefs resolved against each document's URL), `collection(id)` and `check` work as for an API
(queryables come from the summaries), and `search` / `select` follow `item` and `child` links and test every item in
the browser (`plan.filterEncoding` `"client"`, degradation `static-catalog`). Limits: `crawl.maxDepth` (4 links deep),
`crawl.maxDocuments` (500 catalog and collection documents), `crawl.concurrency` (8 requests at a time), and per search
`maxScanned` items read (default 2000) and `maxItems` kept. Such a search has no `matched` total and no resume
cursor. Asset hrefs relative to their item resolve against the item's URL. Links on the catalog's origin get the
client's credentials, headers and parameters; links elsewhere get none. A document found through a link that cannot
be read is skipped and listed in `client.crawlProblems` (`{url, message, status?}[]`); pass `crawl: {onError: "throw"}`
to reject instead. The catalog itself, and the collections a search starts from, must be readable.

**How a client searches** is one field, `client.capabilities.search`: `"item-search"` (a STAC API), `"crawl"` (a static
catalog), `"collection-items"` (an OGC API - Features server without STAC item search: the collection's `items`
endpoint with `bbox`, `datetime` and `limit`, everything else tested in the browser, degradation `collection-items`,
one collection per search), or `"none"`. `identifySource` reports the first as `stac-api` and the other two as
`stac-catalog`, with the same `search` value.

**Lists of items** need a key per item: ids repeat across collections and catalogs, so use `itemKey(item)`
(`` `${collection}/${id}` ``) for rows, map features and sets of chosen items; `dedupeItems` drops duplicates by it.
`itemFootprints(items)` gives their footprints as a GeoJSON FeatureCollection whose feature ids are those keys, for
a vector layer. `selectionToRequest(selection)` is the search request `select` sends, for "every item found" lists
with the same filters. `collections({area, include: [id]})` keeps a collection (the one pasted or chosen) in a list
filtered by the view; the list is cached, so filtering again costs no request (the test is `bboxesIntersect`).

Real servers differ: some silently ignore filters, page sizes are capped, totals are missing. The client compiles each
request into a plan for the server (CQL2-JSON, CQL2-text, the Query extension, or a client-side filter), verifies the
first page, and falls back when a filter was ignored. `plan.degradations` lists every compromise; what the client
learns is a JSON profile you can save and restore. Power users use `catalog.search(request)` and `catalog.plan(request)`
directly, and the selection helpers (`coverArea`, `bestPerPeriod`, `itemsCovering`, `groupItems`, …).

### 4.9 Manifests

A manifest is `GeoTiffTileSetModel.create` options as JSON plus `type: "ria-geotiff/stack"`, `version: 1`, `title`, `description`,
`attribution` and named `styles`. Relative URLs resolve against the manifest's URL (or `base`). Options passed next to
`manifest` override the manifest's. `toManifest(model)` saves a model. See the [manifest specification](manifest.md).

`toManifest` writes the inputs (URLs as opened, band names, `scale`, `offset`, `nodata`, `resampling`, Planetary
Computer signing), `tileSize`, `reference` (its identifier, when the model was opened with `options.reference`) and
the current style, or for terrain `dataType` and `elevation`. It does not write secrets (`requestHeaders`,
`requestParameters`), `credentials`, cache sizes, function options (custom signers, `rewriteUrl`, `resolve`,
`access`) or the `computeStatistics` region. A STAC source is written as its
asset inputs. It throws an `Error` for inputs opened from a `File` or `ArrayBuffer`, and for styles with functions.

---

## 5. Recipes

In the recipes, `map` is your LuciadRIA `WebGLMap`, `GeoTiffTileSetModel` is imported from `ria-geotiff`, and
`RasterTileSetLayer` from `@luciad/ria/view/tileset/RasterTileSetLayer.js`. `catalog` is a client from
`StacClient.connect(...)` (`ria-geotiff/stac`). `...` stands for a value of your application. Recipes that only
restyle start from a `model` already in a layer.

### One URL box for any source

`identifySource(urlOrFile)` tells what the user pasted (or dropped) with one range request for the first 64 KiB: a
GeoTIFF, a manifest, a STAC item, item collection, collection, static catalog or STAC API, or `unknown` with a reason
for display (an HTTP status, an HTML page, CORS, JSON that is neither STAC nor a manifest). For a GeoTIFF, `cog` is
the `CogProbe` of `probeCog`, from the same bytes. It returns the document it read, so nothing is fetched twice, and
never throws for what it cannot open. `StacClient.connect` takes any STAC URL it reports: an API, a static catalog,
or a collection, whose API it connects to with `collectionId` set. Then one switch:

```ts
import {identifySource} from "ria-geotiff";
import {StacClient} from "ria-geotiff/stac";

const input = ...;   // what the user typed, or a dropped File
const area = ...;    // [west, south, east, north] of the view
const found = await identifySource(input);
let model: GeoTiffTileSetModel | null = null;
switch (found.kind) {
    case "geotiff":
        if (!found.cog.isCog) console.warn(`Not a COG, it opens but zoomed-out views read more: ${found.cog.reasons.join("; ")}`);
        model = await GeoTiffTileSetModel.create(found.url ? {url: found.url} : {file: found.file!});
        break;
    case "manifest":   // found.problems lists what is invalid; create rejects an invalid manifest
        model = await GeoTiffTileSetModel.create({manifest: found.manifest, base: found.url});
        break;
    case "stac-item":
        model = await GeoTiffTileSetModel.create({stac: {items: [found.item]}});
        break;
    case "stac-item-collection":   // let the user choose among found.items first
        model = await GeoTiffTileSetModel.create({stac: {items: found.items}});
        break;
    case "stac-api":
    case "stac-catalog":
    case "stac-collection": {
        const catalog = await StacClient.connect(found.url!);   // a collection URL gives its API, with collectionId set
        const id = catalog.collectionId ?? (await catalog.collections({area}))[0].id;
        const picked = await catalog.select({collection: id, area, pick: {coverage: "best"}});
        model = await GeoTiffTileSetModel.create({stac: {items: picked.items}});
        break;
    }
    case "unknown":
        console.log(`Cannot open it: ${found.reason}`);
}
if (model) map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Opened"}));
```

A `stac-catalog` (`search` says how: crawled, or through each collection's items endpoint), or a `stac-collection` whose root cannot be searched, is searched by the same `StacClient` (see
section 4.8). A catalog or collection given as a `File` cannot be crawled (its relative links need its URL). The
studio's Add a layer tab is this recipe with a user interface: a collection list, requirements with `check`, items with
footprints on the map, then `GeoTiffTileSetModel.create({stac: {items}})`.

### Offer the styles that fit the bands

```ts
import {presetsFor, presetStyle} from "ria-geotiff/presets";

const chosenItem = ...;   // an item the user picked from catalog.select(...)
const model = await GeoTiffTileSetModel.create({stac: {items: [chosenItem]}});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: chosenItem.id}));
const choices = presetsFor(model.getBandNames());     // every band of the item: only the presets that fit
if (choices.length) await model.setStyle(presetStyle(choices[0].id));   // opens the assets the preset reads
```

### A time series with a slider

```ts
const id = ...;                                      // the collection id the user picked
const area = ...;                                    // [west, south, east, north] the user drew, in degrees
const from = ..., to = ...;                          // the period the user chose
const found = await catalog.select({collection: id, area, datetime: [from, to], pick: {per: "year", months: [6, 7, 8, 9]}});
const model = await GeoTiffTileSetModel.create({stac: {items: found.items, per: "year"}});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Time series"}));
const periods = model.getSource().periods ?? [];     // ["2019", "2020", ...]: the slider's steps; undefined for one year
const suffix = (p: string) => p.replace(/[^A-Za-z0-9_]/g, "_");   // "2024-07" → "2024_07" for monthly series
const show = (p: string) => model.setStyle({render: {type: "rgb",
  red: `red_${suffix(p)}`, green: `green_${suffix(p)}`, blue: `blue_${suffix(p)}`}});
```

Each call of `show` costs requests the first time a period is shown (its statistics and visible tiles), and none
afterwards while its tiles stay in the cache.

### Terrain and a coloured view of the same DEM

```ts
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";
import {ramp} from "ria-geotiff/ramps";

const demUrl = ...;                                  // URL of a single-band DEM
const terrain = await GeoTiffTileSetModel.create({url: demUrl, dataType: RasterDataType.ELEVATION});
const [height] = terrain.getBandNames();             // "b1", or the file's GDAL band description
const coloured = await terrain.withStyle({render: {type: "pseudocolor", band: height, stretch: {type: "minmax"},
  colorMap: ramp("terrain")}});
map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
map.layerTree.addChild(new RasterTileSetLayer(coloured, {label: "Heights"}));
```

### A class raster with a legend

```ts
import {WORLDCOVER_TABLE} from "ria-geotiff/ramps";

const landCoverUrl = ...;                            // URL of an ESA WorldCover COG
const model = await GeoTiffTileSetModel.create({
  inputs: [{url: landCoverUrl, bands: "landcover", resampling: "nearest"}],   // nearest: never blend class codes
  style: {render: {type: "pseudocolor", band: "landcover", colorMap: WORLDCOVER_TABLE}},
});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Land cover"}));
model.getLegend();   // {kind: "classes", entries: [{value: 10, color: "#006400", label: "Tree cover"}, …]}
```

### Swipe against true colour

```ts
import {SwipeController} from "@luciad/ria/view/controller/SwipeController.js";
import {presetStyle} from "ria-geotiff/presets";

const model = ...;                                   // a GeoTiffTileSetModel with bands red, green, blue and an NDVI style
const analysisLayer = new RasterTileSetLayer(model, {label: "NDVI"});
const twin = await model.withStyle(presetStyle("true-color"));   // shares files and decoded tiles
const trueColorLayer = new RasterTileSetLayer(twin, {label: "True colour"});
map.layerTree.addChild(trueColorLayer);
map.layerTree.addChild(analysisLayer);
const swipe = new SwipeController();
swipe.layers = [[analysisLayer], [trueColorLayer]];
map.controller = swipe;
```

### Pixel values and a stretch adapted to the view

`getValuesAt` and `computeStatistics` take coordinates in the **model's reference** (`model.reference`), not view
pixels or map coordinates. Transform them first:

```ts
import {createPoint} from "@luciad/ria/shape/ShapeFactory.js";
import {createTransformation} from "@luciad/ria/transformation/TransformationFactory.js";
import {LocationMode} from "@luciad/ria/transformation/LocationMode.js";

// Values under the mouse.
const mapToModel = createTransformation(map.reference, model.reference);
map.domNode.addEventListener("mousemove", async (event) => {
  const rect = map.domNode.getBoundingClientRect();
  const viewPoint = createPoint(null, [event.clientX - rect.left, event.clientY - rect.top]);
  try {
    const p = mapToModel.transform(map.getViewToMapTransformation(LocationMode.CLOSEST_SURFACE).transform(viewPoint));
    const values = await model.getValuesAt(p.x, p.y);   // {bands: {red: 0.04, …}, sources: {"(nir - red) / (nir + red)": 0.71}}
    console.log(values ?? "outside the data");
  } catch {
    // not on the earth, or outside the domain of the model's reference
  }
});

// A stretch for the visible area: the statistics are recomputed for it, and the layer is redrawn.
await model.computeStatistics(mapToModel.transformBounds(map.mapBounds));
await model.computeStatistics();   // back to the whole data extent
```

`getValuesAt` reads the full-resolution image of each input, so each call costs range requests unless the blocks
are still among the fetched bytes in memory. Throttle it (for example to one call per 100 ms) on `mousemove`.

### Save and reopen a session

```ts
import {toManifest} from "ria-geotiff";

const json = JSON.stringify(toManifest(model, {title: "My analysis"}));   // inputs, band names, style
const again = await GeoTiffTileSetModel.create({manifest: JSON.parse(json)});
map.layerTree.addChild(new RasterTileSetLayer(again, {label: "My analysis"}));
```

The manifest holds no secrets: pass `requestHeaders` again when you reopen it. See [4.9](#49-manifests) for what is
not saved.

### Protected data and renewed tokens

```ts
const url = ...;            // a COG on a server that needs a token
const token = ...;          // the application's token
const model = await GeoTiffTileSetModel.create({url, requestHeaders: {Authorization: `Bearer ${token}`}});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Protected"}));
const renewed = ...;        // later, a fresh token
model.requestHeaders = {Authorization: `Bearer ${renewed}`};   // the next requests use it; nothing is re-read
```

### A token for a STAC API, and another for its asset storage

The API's options never go to the assets. Give the storage its own token with `stac.assetAccess`, and renew the
API's token with an `access` hook: both hooks run before every request.

```ts
import {StacClient} from "ria-geotiff/stac";

const catalogUrl = ...;                              // the STAC API URL
const apiToken = (): string => ...;                  // the application's current token for the API
const storageHost = ...;                             // host name of the storage that holds the COGs
const storageToken = (): string => ...;              // the application's current token for the storage
const catalog = await StacClient.connect(catalogUrl, {
  access: (url) => (url.origin === new URL(catalogUrl).origin ? {requestHeaders: {Authorization: `Bearer ${apiToken()}`}} : null),
});
const chosenItems = ...;                             // items from catalog.select(...)
const model = await GeoTiffTileSetModel.create({stac: {
  items: chosenItems,
  assetAccess: (url) => (url.hostname === storageHost ? {requestHeaders: {Authorization: `Bearer ${storageToken()}`}} : null),
}});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Protected scenes"}));
```

For storage that takes a token in the URL (a SAS token, a signed URL), write an `AssetSigner` instead.

### Planetary Computer and other signed sources

Assets of Planetary Computer items are signed automatically (SAS tokens, cached and renewed 5 minutes before they
expire). For a plain URL on Planetary Computer storage pass `sign: planetaryComputerSigner()` on the input. For other
token schemes implement an `AssetSigner` and pass it in `signers`:

```ts
import type {AssetSigner} from "ria-geotiff/stac";

const storageHost = ...;                             // host name of the storage
const signedUrlFor = (url: string): Promise<string> => ...;   // asks your backend for a signed URL
const signer: AssetSigner = {
  matches: (url) => new URL(url).hostname === storageHost,
  sign: signedUrlFor,
};
const chosenItems = ...;                             // items from catalog.select(...)
const model = await GeoTiffTileSetModel.create({stac: {items: chosenItems}, signers: [signer]});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Signed scenes"}));
```

`sign` is called once when an input is opened, and again when a read fails: the file is then reopened with the new
URL and the read retried once. It is not called for every request, so a signed URL must stay valid for a while.
Passing `signers` replaces the default list: add `...DEFAULT_SIGNERS` to keep Planetary Computer signing.

### Servers without CORS

Route requests through a proxy you control: `rewriteUrl` in `GeoTiffTileSetModel.create` for the COGs and the `.prj`
files next to them (signed and rewritten as their GeoTIFF), and `StacClient.connect(url, {rewriteUrl})` for API
requests (both take `(url) => string`). The model's `rewriteUrl` does not apply to manifest or STAC item URLs: serve
those with CORS, or fetch them yourself and pass the JSON.

On a page served over https, browsers block `http://` URLs (mixed content): `resolveAsset` reports an http-only STAC
asset as `readable: "no"` with reason `"mixed content"`, and `toBandInputs` and `GeoTiffTileSetModel.create({stac})`
reject it with a `RangeError` unless a `rewriteUrl` is given (the proxy is then expected to serve it over https).

### Unknown coordinate references

LuciadRIA knows the common EPSG codes, not all of them (UTM zones of satellite data, national grids). Give
`resolveReference`: it is called with the identifier a file declares when LuciadRIA does not know it, and returns the
WKT, which the library parses and registers under that identifier, so every later model uses it directly.

```ts
const url = ...;   // URL of a COG in a reference LuciadRIA may not know
const wktOf = async (identifier: string): Promise<string | null> => ...;   // e.g. from your own service; null when unknown
const model = await GeoTiffTileSetModel.create({url, resolveReference: wktOf});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
```

Without `resolveReference` (or when it returns `null`), `create` rejects with a `GeoTiffModelError` whose `cause` is
`UnknownIdentifier` and whose `identifier` names the code: register it yourself with LuciadRIA's `addReference` and
`parseWellKnownText`, then call `create` again.

### Log or count requests

```ts
const url = ...;   // URL of a COG
let bytesAsked = 0;
const model = await GeoTiffTileSetModel.create({url, onRequest: (r) => {
    console.debug(`${r.method} ${r.kind} ${r.url} ${r.range ?? ""} → ${r.status ?? r.error} (${Math.round(r.ms)} ms)`);
    const m = /bytes=(\d+)-(\d+)/.exec(r.range ?? "");
    if (m) bytesAsked += Number(m[2]) - Number(m[1]) + 1;
}});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "COG"}));
```

`onRequest` receives a `RiaGeoTiffRequest` (`url`, `kind`, `method`, `range?`, `status?`, `ms`, `error?`) after every
request: of `GeoTiffTileSetModel.create` and the model's tiles (kinds `file`, `stac-asset`, `manifest`, `stac-api`),
`identifySource` and `probeCog` (`source`), `readManifest` (`manifest`) and `StacClient` (`stac-api`). URLs are
reported unsigned, before `rewriteUrl` and without the added `requestParameters`; headers and credentials never.

### Remove a layer and free its memory

```ts
const layer = ...;   // a RasterTileSetLayer of a GeoTiffTileSetModel, on the map
map.layerTree.removeChild(layer);
(layer.model as GeoTiffTileSetModel).dispose();   // drops its caches; data shared with twins goes with the last twin
```

A disposed model delivers no more tiles. `model.isElevation` tells a terrain model (no style; one elevation layer is
shown at a time) from imagery without importing LuciadRIA's `RasterDataType`.

### Migrating from 0.0.x

0.0.x had one factory for a URL, and setters for its gradient, band mapping and nodata value.
1.0.0 replaces them with `GeoTiffTileSetModel.create` and a `style`. Bands are named `b1`…`bN` (1-based, as in
GDAL), where 0.0.x band indices were 0-based.

| 0.0.x | 1.0.0 |
|---|---|
| `createFromURL(url, options)` | `GeoTiffTileSetModel.create({url, ...})` |
| `credentials`, `requestHeaders`, `requestParameters`, `reference`, `dataType` | Same options of `GeoTiffTileSetModel.create` |
| `dataType: RasterDataType.ELEVATION` (band 0 as heights) | `dataType: RasterDataType.ELEVATION`; a single band is used as heights, else `elevation: {height: "b1"}` |
| `nodata: -9999` | `inputs: [{url, nodata: -9999}]` |
| `gradient: {colorMap, range}` | `style: {render: {type: "pseudocolor", band: "b1", stretch: [range.min, range.max], colorMap: {stops: colorMap.map((s) => ({position: s.level, color: s.color}))}}}` |
| `bandMapping: {gray: 2}` with a gradient | `style: {render: {type: "pseudocolor", band: "b3", ...}}` |
| `bandMapping: {rgb: true, red: 3, green: 2, blue: 1}` | `style: {render: {type: "rgb", red: "b4", green: "b3", blue: "b2", stretch: [0, 255]}}` |
| `setGradient`, `setBandMapping` / `getGradient`, `getBandMapping` | `model.setStyle(style)` / `model.getStyle()` |
| `setNodata` / `getNodata` | `nodata` per input when the model is created |
| `NOTCOG` error for files that are not COGs | `GeoTiffTileSetModel.create` opens any GeoTIFF; check `(await GeoTiffTileSetModel.infoFromURL(url)).isCog` if needed |
| `GrayscaleGradient` | `GREY_RAMP`, or `colorMap: {stops: [{position: 0, color: "#000"}, {position: 1, color: "#fff"}]}` |
| `infoFromURL(url, options)`, `getModelInfo()` | Unchanged |

Without a `style`, `GeoTiffTileSetModel.create` picks one (see `autoStyle`): a percentile stretch instead of the
fixed full range of 0.0.x. Give a fixed `stretch` to keep the 0.0.x colours.

---

## 6. API reference

The API reference is a browsable site generated from the documentation comments in the source code, so it always
matches the code. Build it with `npm run docs` and open `build/docs/index.html`. It holds this guide, the manifest
specification and every class, method, function, interface and type: each signature with the type of every
parameter and property, defaults, return types, the errors thrown, and examples. Search covers names and comments.

The reference is organised by topic:

| Entry point | Topics |
|---|---|
| `ria-geotiff` | Model, Sources, Manifests, Styles, Expressions, Colour maps, Statistics, Protected data, Errors |
| `ria-geotiff/stac` | Client, Choosing data, Search, Selection helpers, Assets and bands, STAC JSON, Errors |
| `ria-geotiff/ramps` | Ramps |
| `ria-geotiff/presets` | Presets |

Where to start, following the workflow:

| Step | Read |
|---|---|
| 1. Capabilities | `StacClient.connect`, `StacClient.collections`, `StacClient.collection`; `GeoTiffTileSetModel.infoFromURL` for one file |
| 2. Choose | `StacClient.check`, `StacClient.select`, `StacSelection`; `StacClient.search` for raw paging |
| 3. Create | `GeoTiffTileSetModel.create`, `CreateModelOptions`, `BandInput` |
| 4. Layer | LuciadRIA's `RasterTileSetLayer`, with the model |
| 5. Style | `GeoTiffTileSetModel.setStyle`, `BandStyle`, `GeoTiffTileSetModel.withStyle`, `GeoTiffTileSetModel.getLegend` |

Conventions: `?` marks an optional parameter or property (defaults are in its description); `Promise<T>` means
the call is asynchronous and errors are rejections; band locations (`"b3"`, `"f1_b3"`) are 1-based, as in GDAL.

---

## 7. Errors

**Sync or async.** Every method that returns a `Promise` reports problems by rejecting it, never by throwing: `GeoTiffTileSetModel.create`,
`setStyle`, `withStyle`, `asElevation`, `computeStatistics`, `requestStatistics`, `getValuesAt`, `infoFromURL`,
`readManifest`, and the `StacClient` methods `connect`, `collections`, `collection`, `select`, `items`, ....
Every error of the library extends `RiaGeoTiffError`, with one shape for display: `message`, `name` (the class),
`problems: RiaGeoTiffProblem[]` (`{path, severity: "error" | "warning", message}`, possibly empty), `details()` (the
fields of the subclass that are set, below) and `toJSON()` (`JSON.stringify(error)` gives all of it). One error box
fits all:

```ts
import {RiaGeoTiffError} from "ria-geotiff";

const errorBox = ...;   // an element of your page
function showError(e: unknown) {
    if (!(e instanceof RiaGeoTiffError)) { errorBox.textContent = String(e); return; }
    errorBox.textContent = [e.message, ...e.problems.map((p) => `${p.severity} ${p.path}: ${p.message}`),
        ...Object.entries(e.details()).map(([key, value]) => `${key}: ${String(value)}`)].join("\n");
}
```

`RangeError` (invalid options) and the abort reason of a signal (an `AbortError` `DOMException`) are not library
errors.

Functions that return a value throw synchronously: `compileStyle`, `parseExpression`, `compileExpression`,
`toManifest`, `resolveAsset`, and `StacClient.plan` and `StacClient.search` (when the API has no item search).
`StacClient.check` and `validateManifest` return problems instead of throwing. Errors while browsing are not thrown
at all: they go to read error listeners.

| Error | Raised by | Useful fields |
|---|---|---|
| `GeoTiffModelError` | `GeoTiffTileSetModel.create`, `asElevation`, `infoFromURL` | `cause` (below), `message`, `identifier` (for `UnknownIdentifier`), `pixelFormat` (for `INVALIDELEVATION`), `originalError` (the network or geotiff.js error) |
| `GeoTiffReadError` | Tile, statistics and `getValuesAt` reads, reported to `onReadError` / `addReadErrorListener` once per file and image, never thrown | `url` (without added parameters), `fileIndex` (0-based), `image` (0 = full resolution), `recovery` (`finerImage` / `nodata`), `originalError` |
| `StyleError` | `GeoTiffTileSetModel.create`, `setStyle`, `withStyle`, `compileStyle`, `asElevation` (for `elevation.height`) | `path` (`render.red`, `mask[0].band`, `render.colorMap.stops[2].color`, `elevation.height`, …) |
| `ExpressionError` | `parseExpression`, `compileExpression` (inside a style it becomes a `StyleError`) | `position`: 0-based index of the offending character, when known |
| `ColorMapError` | The colour map functions (`resolveRamp`, `rampFromValues`, …); inside a style it becomes a `StyleError` | `path` inside the colour map, `reason` |
| `ManifestError` | `GeoTiffTileSetModel.create({manifest})`, `readManifest` | `problems`: `[{path, severity: "error", message}]`, `path` a JSON path such as `inputs[0].url` |
| `StacError` | `StacClient` methods, `GeoTiffTileSetModel.create({stac})` | `status` (HTTP status; undefined for network errors, timeouts and selection problems), `url`, `body` (parsed JSON or text), `problems` (for selections that do not fit or find nothing; empty for request errors) |
| `RangeError` | `GeoTiffTileSetModel.create`, `setStyle` on an elevation model, `asElevation`, `resolveAsset`, `toBandInputs`, `ramp`, `presetStyle`, `bboxOf` | `message` names the problem: not exactly one source, invalid band locations or names, missing `elevation.height`, a style with elevation, an invalid `tileSize`, `elevation.tileSize` or `byteCacheSize`, unreadable STAC assets, an unknown ramp or preset (the message lists the names), a geometry without positions |
| `Error` | `GeoTiffTileSetModel.create` (a manifest URL with an HTTP error, a relative manifest URL without a base), `toManifest`, `evaluateCql2` (an unsupported operator) | `message` |

**Causes** of `GeoTiffModelError` (`error.cause`):

| Cause | When | What to do |
|---|---|---|
| `ERROR_LOADING_FILE` | A file cannot be fetched (network, CORS, HTTP status, refused redirect) or is not a TIFF | Check the URL, CORS and credentials; `originalError` says more |
| `BoundsMissing` | A file has no georeferencing, or no EPSG reference (a user-defined projection, GeoKey 32767), no `crsName` and no `.prj` next to it | Give the input's `crsName` (`"EPSG:2056"`; STAC sources take it from `proj:code` / `proj:epsg`), or pass `reference` (`getReference("CRS:1")` for pixel coordinates) |
| `UnknownIdentifier` | LuciadRIA does not know the reference in `identifier` | Pass `resolveReference`, or register its WKT and call `GeoTiffTileSetModel.create` again ([recipe](#unknown-coordinate-references)) |
| `REFERENCE_MISMATCH` | The inputs declare different references | One model per reference |
| `INVALIDELEVATION` | Elevation from data that cannot hold heights (RGB, colour models) | Use imagery, or another band |
| `READ_FAILED` | Only on `GeoTiffReadError` | See `recovery` |

Read error listeners (`onReadError`, `addReadErrorListener`) are shared with twins and receive errors of imagery and
terrain reads. Without any listener, each error is logged once with `console.warn`. Errors thrown by a listener are
caught and logged with `console.error`.

---

## 8. Performance and limits

**What costs requests.** All reads are HTTP range requests of whole 64 KiB blocks; a block read once stays in the
fetched-bytes cache (`byteCacheSize`, 16 MiB per input) until it is pushed out.

| Action | Requests |
|---|---|
| `GeoTiffTileSetModel.create`: opening | The header of each input (usually one block), at most 8 inputs at a time; one `.prj` request per input without an EPSG reference or `crsName` (signed and rewritten as the input) |
| `GeoTiffTileSetModel.create`, `setStyle`, `withStyle` with a statistics-based stretch | The statistics grid: a few blocks per input, from the overview that matches the grid |
| Viewing an area for the first time | The blocks of the tiles in view, from the overview that matches the zoom level |
| `setStyle` over bands already cached | None |
| `setStyle` reading new bands | Their statistics grid and the tiles in view |
| `getValuesAt` | One full-resolution read per input of the requested bands |
| `computeStatistics(bounds)` | The statistics grid over `bounds`, at a finer overview when the region is small |
| STAC `select` | The collection (at most 2), then one per page of 100 items |

**Costs in the browser.** Decoding runs in web workers (`pool`); one decoded block serves several tiles
(`decodedBlocks`). Rendering a 256 × 256 tile from cached bands takes about 0.5–1 ms. 8-bit RGB files with fixed or
statistics stretches take the fast path (about as fast as a plain copy). `model.getPerformance()` reports tile
counts, cache hits and average read and render times.

**Tuning.**

| Goal | Change |
|---|---|
| Fewer, larger reads and renders | `tileSize: 512` |
| Less memory | Lower `cacheSize` (MiB), `decodedBlocks` (count; a 1024 × 1024 Float32 block is 4 MiB) and, for mosaics of many files, `byteCacheSize` (MiB per input) |
| Instant restyling over a large area | Raise `cacheSize` |
| Faster opening of STAC models | Automatic: `create` opens only the assets its style reads; others open when a style first reads them |
| Faster `GeoTiffTileSetModel.create` | A style with fixed stretches (`[min, max]`) needs no statistics reads |
| More precise stretches | Raise `statisticsSize`, or `computeStatistics(bounds)` for the area of interest |
| Files that are slow to read | Convert to COG with overviews and 256 or 512 px blocks ([elevation-to-cog.sh](../scripts/elevation-to-cog.sh) for DEMs) |

**Limits**

- **One elevation layer** at a time in LuciadRIA: use one mosaic model for a tiled DEM.
- **One coordinate reference per model**: no reprojection; items in different UTM zones need one model each
  (`groupItems(items, "crs")`).
- **Axis-aligned grids only** (no rotated GeoTIFFs); no zip archives.
- **CORS**: servers must allow cross-origin range requests, or you need a proxy.
- **Memory grows with inputs**: each input keeps up to `byteCacheSize` (default 16) MiB of fetched bytes; for a
  mosaic of hundreds of files lower it (`byteCacheSize: 2`).

---

## 9. Security and protected data

**Credentials, headers and parameters** are LuciadRIA's `HttpRequestOptions`: `credentials` (`true` = `"include"`,
`false` or unset = `"same-origin"`, or a fetch mode), `requestHeaders` and `requestParameters`. They are accepted in
`GeoTiffTileSetModel.create()`, per input (`BandInput.requestHeaders`, …), in `StacClient.connect`, and as model properties
(`model.requestHeaders = {...}` renews a token for the next requests).

They are sent **only to the origin of a URL the application gave for them**:

| Request | Gets the options? |
|---|---|
| `url`, `inputs[i].url`, the `manifest` URL, STAC item URLs | Yes, on that URL's origin |
| Files a manifest lists on the manifest's origin | Yes |
| Files a manifest lists on another origin | No |
| STAC API requests on the API's origin | The client's options, yes |
| `next` links or other links to another origin | No |
| STAC assets (COGs) | No: signers, or an explicit `stac.assetAccess` hook |
| Token endpoints of signers | No |

A request carrying headers or parameters is sent with `redirect: "manual"`: a redirect on the same origin is followed
(at most 5); one to another origin is an error naming the host the options were withheld from. Browsers hide the
target of a manual redirect, so in a browser **any** redirect of such a request is refused, and `GeoTiffTileSetModel.create` rejects with
`ERROR_LOADING_FILE`. Give the final URL instead. Requests without headers or parameters follow redirects normally.
The `access(url, kind)` hook in `GeoTiffTileSetModel.create` (and `access` in `StacClient.connect`) replaces the rule when given.

**Renewing tokens.** Each kind of request has its own way:

| Requests | How to renew |
|---|---|
| GeoTIFFs of a model (and its twins) | Set `model.requestHeaders`, `model.requestParameters` or `model.credentials`: the next request uses them |
| STAC API requests | No setter: pass an `access` hook to `StacClient.connect`, it runs before every request |
| STAC assets | The `stac.assetAccess` hook, which runs before every request; or an `AssetSigner`, called when the input is opened and after a failed read |
| Manifest and STAC item URLs | Fetched once, during `GeoTiffTileSetModel.create`, with the options given to `GeoTiffTileSetModel.create` |
| `GeoTiffTileSetModel.create`'s `access` hook | Runs before every request it decides on |

**Never stored, never shown**: manifests never contain `requestHeaders` or `requestParameters` (`toManifest` does not
write them, the schema does not allow them); URLs in errors, `getBands()`, `getSource()`, manifests and plans are shown
without the added parameters; plan snippets show `<redacted>` for header values.

**Expressions are not code**: they are parsed by a fixed grammar and compiled from the validated tree; under a Content
Security Policy without `'unsafe-eval'` an interpreter is used. **Manifests are data**: validate manifests from
untrusted sources (`validateManifest`) and consider a `resolve` hook that only allows known hosts.

---

## 10. Compatibility and versioning

| Component | Supported |
|---|---|
| LuciadRIA | 2024.1 or later (tested 2026.1.2), peer dependency |
| geotiff.js | `~3.0.5`, read through a custom HTTP client with an explicit `blockSize` (geotiff.js #516) |
| Browsers | Current Chrome, Edge, Firefox and Safari (ES2022, web workers, `fetch` with range requests) |
| STAC | Core 1.0 and 1.1 metadata (`eo:bands`/`raster:bands` and unified `bands`), STAC API 1.0 |
| Manifest | Version 1 (`"type": "ria-geotiff/stack"`, `"version": 1`) |

The package follows semantic versioning. 1.0.0 replaces the 0.0.x API, see [Migrating from 0.0.x](#migrating-from-00x).

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unknown coordinate reference EPSG:…` | LuciadRIA does not know the CRS | Register its WKT and retry |
| `REFERENCE_MISMATCH` | Inputs in different references | One model per reference |
| `elevation.height is required with several bands` | Terrain from several bands | Name the band or give an expression |
| Nothing loads from another domain; `Failed to fetch` | No CORS headers on the server | Use a proxy (`rewriteUrl`), or host the files with CORS |
| `… redirects to … credentials … withheld` | A protected URL redirects to another host | Give the final URL, or decide with the `access` hook |
| Terrain is flat | Another elevation layer is shown | Only one is shown; switch the other off |
| Washed-out or white image | Stretch from statistics of a much larger area | `computeStatistics(bounds)` for the area of interest |
| `StyleError: render.red: unknown band "nir"` | The model has no band of that name | `getBandNames()`; name bands at creation; for STAC, the items have no asset with that common name (`naming: "asset-key"`, `bandNames`) |
| Planetary Computer returns 409 / 403 | Unsigned or expired URL | Automatic for PC items; for plain URLs use `sign: planetaryComputerSigner()` |
| `StyleError: … unknown band "b1"` on a file you expected to have `b1` | The file has GDAL band descriptions, which become the band names | `getBandNames()`, or name the bands: `bands: {red: "b1", …}` |
| A monthly time series style fails with `unknown band "nir_2024"` | Band names use the period label with `-` replaced by `_` | `nir_2024_07`: build the name from `getSource().periods` |
| `select` rejects: "No … item meets the selection" | No single item contains the whole area (`coverage: "full"`) | `pick: {coverage: "best"}` for a mosaic, or a smaller area |
| Colours change after `computeStatistics(bounds)`, or never adapt to the view | Statistics describe one region: the whole extent until you call it | Call it again for the new view, or without bounds for the whole extent |
| Class codes are blended at edges (values like 4.5) | Bilinear resampling of a class raster | `resampling: "nearest"` on the input |
| Terrain heights look 3.3 times too high | The DEM is in feet | `scale: 0.3048` on the input |
| A whole file is downloaded | The server ignores range requests | Serve the file with HTTP range support |

### Frequently asked questions

#### What does GeoTiffTileSetModel.create() request before it resolves?

In order: the manifest (one request) or the STAC items (one request each) or, for a STAC selection, the catalog
(`connect`, the collection, one request per page of 100 items); then the header of each input (whole 64 KiB blocks,
usually one per input, at most 8 inputs at a time); one `.prj` request per URL input without an EPSG reference or `crsName`; and,
for imagery with a statistics-based stretch (the default style has one), the statistics grid. Nothing else is read
until LuciadRIA requests tiles. With a fixed stretch, or for terrain, `GeoTiffTileSetModel.create` reads no pixel data.

#### Why do (or don't) my colours change when I pan?

They do not change by themselves. Statistics-based stretches use statistics of the whole data extent, computed once.
`computeStatistics(bounds)` replaces them with statistics of a region; the colours then change once, and stay until
the next call. Call it from a map change listener (debounced) for a stretch that follows the view.

#### What happens when I call setStyle while tiles are loading?

The current style keeps drawing until the new style's statistics exist. Then the style switches and the layer is
invalidated. LuciadRIA aborts and re-requests the pending tiles, but their reads continue and are shared with the new
requests, so nothing is read twice. When several `setStyle` calls overlap, the last one wins; earlier promises
resolve without applying their style. A `StyleError` rejects the call and leaves the current style in place.

#### Which bands does a model have, and what are they called?

`model.getBandNames()`. Names come, in this order of precedence, from `options.bands` (locations), each input's
`bands`, the files' GDAL band descriptions, or `b1`…`bN` (one input) and `f1_b1`… (several inputs). STAC models use
EO common names (`red`, `nir`), else asset keys, with a period suffix in a time series. Only the bands that exist
can be styled; unnamed bands are never read.

#### What happens when inputs overlap, differ in resolution, or differ in reference?

Overlap: inputs with the same band name form a mosaic, and the first input with data at a pixel wins. Resolution:
each input is resampled onto the tiles from its best-matching overview; the finest input sets the deepest level.
Reference: all inputs must declare the same one, else `GeoTiffTileSetModel.create` rejects with `REFERENCE_MISMATCH`. There is no
reprojection, but the model itself is shown on a map in any reference: LuciadRIA reprojects the tiles.

#### How do I give the values under the mouse to the user?

Transform the view point to the model's reference and call `getValuesAt(x, y)`, see the
[recipe](#pixel-values-and-a-stretch-adapted-to-the-view). The values are after scale and offset; missing data is
NaN; outside the data the result is null.

#### What if no STAC item covers my area, or the server is limited?

No item containing the whole area: `select` rejects with a `StacError` whose `problems` include `pick.coverage` (how
many items cover only part of it, and the best fraction); use `pick: {coverage: "best"}` for a mosaic. No CQL2: the client uses the Query extension, else filters the returned items itself, and lists this
in `plan.degradations`. No item search at all: `select` rejects with a `StacError`, see [4.8](#48-stac).

#### Which of my credentials go where?

Options given to `GeoTiffTileSetModel.create` go to the URLs you gave (`url`, inputs, the manifest, STAC item URLs) and, for a manifest,
to the files it lists on its own origin. Options given to `StacClient.connect` go to the API's origin. STAC assets get
nothing unless you pass `stac.assetAccess` or a signer. See [section 9](#9-security-and-protected-data).

#### Does a twin cost requests?

`asElevation()` makes no requests. `withStyle(style)` computes the statistics of its style over the whole data
extent, which reads the statistics grid of its bands (often from the fetched bytes in memory). Tiles already decoded
for one model are reused by the other.

#### Can I open a GeoTIFF that is not a COG?

Yes, with `GeoTiffTileSetModel.create`: any GeoTIFF that geotiff.js reads, with georeferencing (or `reference`). A file without overviews
is read at full resolution even when zoomed out, and a file in strips reads more per tile, so both are slower.
`GeoTiffTileSetModel.infoFromURL` reports `isCog`. Convert large files to COGs with GDAL.

#### Is my file a COG?

`(await probeCog(urlOrFile)).isCog` (or `identifySource(urlOrFile)`'s `cog` for a GeoTIFF) answers by reading the header only: one range request (or `Blob` slice) for the
first 64 KiB, and at most one more read when the directories continue beyond it; `bytesRead` says how much. The
required checks are: a TIFF or BigTIFF (`tiff`), tiles rather than strips (`tiled`), every directory before the image
data so the header is read in one go (`headerFirst`), and overviews when the image is larger than one tile
(`overviews`). `gdalLayout` reports GDAL's layout note but is never required. The file name is not a criterion: URLs
often have no extension, signed URLs end in a query, and names can be wrong. `reasons` has one sentence per failed
check, for display. `infoFromURL(...).isCog` and `getModelInfo().isCog` use the same checks. To convert a file:

```bash
gdal_translate -of COG in.tif out.tif
```

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **COG** | Cloud Optimized GeoTIFF: a tiled GeoTIFF with overviews and its header first, readable by range requests |
| **Overview** | A reduced-resolution copy of the image inside the COG, used when zoomed out |
| **Band** | One channel of a raster (red, near-infrared, a month, a class code) |
| **Input** | One file of a model |
| **Mosaic** | One band from several inputs; the first input with data at a pixel wins |
| **Twin** | A second model over the same files and caches, with another style or as terrain |
| **Stretch** | The mapping of data values to the 0..1 display range |
| **Ramp** / **class table** | A colour gradient over the stretch / an exact value-to-colour mapping |
| **STAC** | SpatioTemporal Asset Catalog: JSON catalogs of geospatial data, searchable through STAC APIs |
| **Item / asset** | A STAC scene, and one of its files |
| **Common name** | The EO extension's role name of a band (`red`, `nir`, `swir16`) |
| **CQL2** | OGC Common Query Language, used by STAC filters |
| **Manifest** | A ria-geotiff JSON file holding the options of `GeoTiffTileSetModel.create()` for one model |
| **Source** | What a model is opened from: `url`, `file`, `inputs`, `stac` or `manifest` ([4.2](#42-sources)) |
| **Value source** | A band or expression a style reads; statistics are kept per value source ([4.5](#45-styles)) |
| **Statistics** | Count, min, max, mean, standard deviation and histogram of a value source, from a coarse grid over the data extent |
| **Block** | A tile of the GeoTIFF file itself (for example 512 × 512 pixels); not a LuciadRIA tile |
| **Tile** | A tile of the model's quadtree, as LuciadRIA requests it (`tileSize`, default 256 pixels) |
| **Model reference** | The coordinate reference of the model (`model.reference`), from the files' EPSG code; `getValuesAt` and `computeStatistics` take coordinates in it |
| **Period** / **period label** | A time bucket for STAC items (`day`, `solar-day`, `week`, `month`, `quarter`, `year`) and its label (`2024-07-15`, `2024-W29`, `2024-07`, `2024-Q3`, `2024`) |
| **Solar day** | The local calendar day at an item's centre longitude (UTC shifted by longitude / 15 hours), see `solarLongitude` |
| **item_assets** | The part of a STAC collection that describes the assets its items have |
| **LuciadElev0 PNG** | LuciadFusion's elevation tile encoding: a 16-bit greyscale PNG with a `biNy` chunk giving the height range; sample value 0 is nodata |
| **LTS** | LuciadFusion's tile service, whose elevation tile layout terrain models follow |
