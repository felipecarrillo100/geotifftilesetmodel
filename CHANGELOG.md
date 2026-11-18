# Changelog

## 1.0.0

A new model engine and API: streamed Cloud Optimized GeoTIFFs as imagery styled with band math, or as terrain, from
one file, several files, mosaics, STAC items or a manifest. Compared with 0.0.3, the last release on npm.

### Migrating from 0.0.x

| 0.0.x | 1.0.0 |
|---|---|
| `createFromURL(url, {credentials, requestHeaders, requestParameters, reference, dataType})` | `GeoTiffTileSetModel.create({url, credentials, requestHeaders, requestParameters, reference, dataType})` |
| `nodata: -9999` | `GeoTiffTileSetModel.create({inputs: [{url, nodata: -9999}]})` |
| `gradient: {colorMap, range}` | `style: {render: {type: "pseudocolor", band: "b1", stretch: [range.min, range.max], colorMap: {stops: colorMap.map((s) => ({position: s.level, color: s.color}))}}}` |
| `bandMapping: {rgb: true, red: 3, green: 2, blue: 1}` | `style: {render: {type: "rgb", red: "b4", green: "b3", blue: "b2", stretch: [0, 255]}}` (bands are 1-based) |
| `setGradient`, `setBandMapping` / `getGradient`, `getBandMapping` | `model.setStyle(style)` / `model.getStyle()` |
| `setNodata` / `getNodata` | `nodata` per input when the model is created |
| `infoFromURL`, `getModelInfo` | Unchanged |

See the developer guide, "Migrating from 0.0.x", for the full table.

### Added
- **`identifySource(urlOrBlob, options)`**: what a URL or file is (GeoTIFF, manifest, STAC item, item collection,
  collection, static catalog, STAC API, or unknown with a reason), with one range request; the document read is
  returned, and a GeoTIFF comes with `cog`, its COG analysis from the same bytes. **`probeCog(urlOrBlob, options)`**:
  whether a GeoTIFF is a COG, from its header only; `infoFromURL` and `getModelInfo` report the same `isCog`.
- **One error shape**: every library error extends `RiaGeoTiffError`, with `problems` (`RiaGeoTiffProblem`:
  `{path, severity, message}`, also returned by `validateManifest` and `StacClient.check`), `details()` and `toJSON()`.
- **`assetFormat(asset)`**: an asset's display format (`"COG"`, `"GeoTIFF"`, `"GeoTIFF (zipped)"`, `"INTERLIS
  (zipped)"`, `"GeoPackage"`, `"CSV"`, ...) and whether a model can open it, for lists that show every asset and grey
  out the rest. **`StacClient.sampleItem(collection)`**: one item through the items endpoint (not a search, much
  faster on some servers), to see what a collection holds when it declares no `item_assets`.
  **`elevationHint(collection)`**: whether a collection looks like elevation (keywords, title, description, asset
  keys; not vegetation height or relief shading), with the evidence, since STAC has no field for it.
- **`BandInput.crsName`** (`"EPSG:2056"`): the reference of a file that declares no EPSG code; STAC sources set it
  from `proj:code` / `proj:epsg`, and manifests keep it.
- **`StacClient.connect(collectionUrl)`**: the client of the collection's API (its `root` link, when it has item
  search; otherwise the collection is crawled as a static catalog), with `collectionId` set.
- **`select(selection, {signal, onProgress})`** and `search(request, {signal, onProgress})`: aborting stops the
  requests (the promise rejects with the signal's reason); `StacProgress` per page. `select` lists every item found in
  `candidates` (`StacCandidate`: picked or why not, coverage of the area, period); when nothing is left, its
  `problems` say which rule excluded how many items.
- **Choosing items in a user interface**: `itemKey(item)` (`collection/id`, the key for rows and features),
  `itemFootprints(items)` (GeoJSON with those keys), `selectionToRequest(selection)` (the search `select` sends),
  `collections({area, include})`, and `bboxesIntersect` exported.
- **Static catalogs survive broken links**: unreadable documents are skipped and listed in `client.crawlProblems`
  (`crawl.onError: "throw"` rejects instead).
- **OGC API - Features servers without item search** are searched through each collection's `items` endpoint;
  `capabilities.search` (`"item-search"`, `"collection-items"`, `"crawl"`, `"none"`) says how, and
  `identifySource` reports the same value on `stac-catalog`.
- **`onRequest`** on `create`, `identifySource`, `probeCog`, `readManifest` and `StacClient`: every request as a
  `RiaGeoTiffRequest` (URL without secrets, kind, method, range, status, time).
- Empty searches name the requirement tested in the browser that excluded the items (`StacSearch.rejected`);
  `CollectionSummary.bandNaming` replaces `describesRoles`; `BandLocation.isCog` per input.
- **Model lifecycle**: `model.isElevation`, `model.dispose()` (caches shared with twins go with the last one), and
  `CreateModelOptions.resolveReference(identifier)` giving the WKT of references LuciadRIA does not know.
- **STAC models have every band of their items**: `create` opens only the assets its style reads, and `setStyle`,
  `withStyle` and `asElevation` open the assets of the bands they read first (once, shared with twins).
- **Static STAC catalogs** in `StacClient`: `capabilities.staticCatalog`, collections and items found by crawling
  links (`crawl` limits), searches filtered in the browser; relative asset hrefs resolve against the item's URL.
- **`GeoTiffTileSetModel.create(options)`**, the one factory, with exactly one source: `url`, `file` (`Blob`,
  `ArrayBuffer` or `GeoTIFF`), `inputs`, `stac` or `manifest`. It never throws synchronously. Files do not need to
  be COGs.
- **Named bands from one or more files** at different resolutions, resampled (bilinear or nearest) onto one tile
  quadtree, with a decoded tile cache shared by concurrent reads. Band names default to GDAL band descriptions, else
  `b1`…`bN`; `bands: {red: "f1_b3", nir: "f2_b1"}` names them by location.
- **Styles** (`BandStyle`, `setStyle`, `getStyle`, `withStyle`): `rgb` and `pseudocolor` renders over bands or
  expressions, a `custom` render, `mask` rules, stretches (fixed, percentile, standard deviations, min/max) from
  statistics of the whole extent, gamma and saturation, legends (`getLegend`), validation with `StyleError` paths.
  A new style re-renders from the cache without requests when its bands are cached.
- **Expressions**: TiTiler-style strings (`(nir - red) / (nir + red)`, `where()`, `clamp()`, ...) or JSON arrays,
  parsed by a whitelisted grammar (no `eval`), compiled, with a CSP-safe interpreter fallback.
- **Colour maps as data**: ramps (stops over the stretch, smooth or stepped), class tables, colour functions, and
  helpers (`resolveRamp`, `sampleRamp`, `reverseRamp`, `rampFromColors`, `rampFromValues`, `cssGradient`,
  `parseColor`, `formatColor`, `GREY_RAMP`).
- **Elevation**: `dataType: RasterDataType.ELEVATION` serves one band, or `elevation.height` naming a band or an
  expression over several, as LuciadRIA terrain in LuciadFusion's LTS layout: a quadtree of 64 x 64 point samples
  spanning each tile edge to edge, encoded as LuciadElev0 PNG (16-bit + `biNy` chunk, 0.4 m steps), interpolated
  (bilinear, nodata aware) from the most suitable image. GDAL scale/offset is applied; missing data uses
  LuciadFusion's nodata marker (or `elevation.noDataHeight`). Options: `elevation.tileSize`, `elevation.noDataHeight`.
- **Mosaics**: the same band name in several inputs is one band; the first input with data at a pixel wins, the
  extent is the union. One elevation model over many COGs, seamless across file borders (LuciadRIA shows only one
  elevation layer at a time). All inputs must share the reference (`REFERENCE_MISMATCH` otherwise).
- **Twins**: `withStyle(style)` (imagery) and `asElevation(elevation?)` (terrain) share files, downloads, decoded
  blocks and decoded tiles.
- Inspection and diagnostics: `getValuesAt`, `computeStatistics(bounds?)`, `requestStatistics`, `getBands`,
  `getBandNames`, `getSource`, `getElevation`, `getPerformance`; `getModelInfo().canBeElevation`.
- **Read error reporting**: problems reading data while serving tiles are reported as `GeoTiffReadError` (cause
  `READ_FAILED`, with `url`, `fileIndex`, `image`, `recovery`, `originalError`) to `addReadErrorListener` /
  `options.onReadError`, once per file and image, else logged with `console.warn`. A failing overview falls back to
  a more detailed image; a file that cannot be read is shown as no data while the other files still show.
- **Manifests**: the create options as a versioned JSON file (`"type": "ria-geotiff/stack"`, `"version": 1`) with a
  JSON Schema: `readManifest`, `validateManifest`, `toManifest`.
- **`ria-geotiff/stac`**: a STAC API client for browsers (`StacClient`: capabilities, collections, checks,
  selection, search plans per server with verification and fallback, paging), asset resolution and signing
  (`AssetSigner`, Planetary Computer), and STAC sources for `GeoTiffTileSetModel.create({stac: ...})` (items of one
  period are a mosaic, several periods a time series). STAC 1.0 and 1.1 band metadata.
- Optional entry points `ria-geotiff/ramps` and `ria-geotiff/presets` (composites, indices, class styles, cloud
  masks), built with the public API.
- **Protected data**: `credentials`, `requestHeaders`, `requestParameters` (LuciadRIA's `HttpRequestOptions`) in
  `GeoTiffTileSetModel.create`, per input, in `StacClient.connect`, and as model properties (token renewal without
  re-reading). They go only to the origin of a URL the application gave for them; redirects to another origin are
  refused; an `access` hook (and STAC `assetAccess`) overrides the rule. They are never written to manifests or shown
  in messages.
- `GeoTiffModelError` class (with `cause`, `identifier`, `pixelFormat`, `originalError`) and causes
  `INVALIDELEVATION` and `REFERENCE_MISMATCH`.
- Package entry point `ria-geotiff` (deep imports under `ria-geotiff/lib/` keep working).
- Developer guide (`docs/developer-guide.md`), manifest specification (`docs/manifest.md`),
  `scripts/elevation-to-cog.sh`, unit tests (Vitest) with generated COG fixtures, and a `demo/` LuciadRIA app with a
  remote-sensing studio (`demo/studio.html`).

### Changed
- Tiles are always RGBA; single-band, multiband, 16-bit, float, YCbCr/CIELab/CMYK and masked images are rendered
  correctly (0.0.3 garbled single-band and multiband images without nodata, showed JPEG/YCbCr in grey, truncated
  strip images to 8 bits and ignored `gradient.range` for float data). RGB nodata needs all bands to match, as in
  GDAL.
- Tile errors are reported through `onError` instead of being thrown or left pending.
- `@luciad/ria` is a peer dependency (`>=2024.1`) and is never bundled.
- geotiff.js 3 (`~3.0.5`), always read with `blockSize: 65536`: since 3.0.4, `fromUrl()` no longer wraps remote
  files in its blocked source unless `blockSize` is passed (geotiff.js #516), and every read becomes its own small
  range request, which in browsers ends in refused streams and corrupt reads. A unit test guards it. Move to
  geotiff.js 3.1.0 once it is published on npm (see README, "geotiff.js version").
- ES module package (`"type": "module"`), strict TypeScript, declarations with source maps. The decoder worker pool
  is created on first use, in browsers only.
- The license field is MIT, matching the LICENSE file.

### Fixed
- `credentials: true` sends credentials cross-origin (`include`); `requestParameters` are applied.
- `infoFromURL` stores the CRS found in a `.prj` file.
- Files without an EPSG code reported the reference `EPSG:undefined`; they now fail with `BoundsMissing` (pass
  `options.reference`).
- GeoTIFF tie points with a raster offset and `PixelIsPoint` files are georeferenced correctly.
- COGs with a user-defined projection (GeoKey 32767, the name only in a citation) opened from STAC failed with
  `BoundsMissing`, although the asset declares `proj:epsg` (swisstopo's `ch.agroscope.*` collections). New
  `BandInput.crsName` (`"EPSG:2056"`) is used when the file declares no EPSG reference, before the `.prj` lookup;
  STAC sources set it from `proj:code` / `proj:epsg` of the asset, else the item, and manifests keep it. The
  `BoundsMissing` message now names `crsName`.
- `StacClient.select` counted items without any GeoTIFF data asset towards `maxItems` (300): on swisstopo's
  swissALTIRegio, 300 zipped XYZ tiles filled the result and hid the one COG. They are now skipped (new
  `StacSelectionResult.skipped`; the empty-result error names them) and the search reads on, up to
  `SELECT_SCAN_LIMIT` (2000) items.
- A STAC source whose items have no GeoTIFF asset now says what the items hold (`routes.xtf.zip
  (application/x.interlis+zip)`): zipped and vector downloads are not COGs.

### Removed
- `GeoTiffTileSetModel.createFromURL` and `CreateGeotiffFromUrlOptions`: use `GeoTiffTileSetModel.create`.
- `setGradient`, `getGradient`, `setBandMapping`, `getBandMapping`, `setNodata`, `getNodata`: use styles and
  `nodata` per input.
- `BandMapping`, `CogGradient`, `CogGradientColorMap`, `GradientColorMapStep`, `GrayscaleGradient`,
  `TransformToGradientColorMap`, `GrayScaleTransformation`, and the internal modules `bandstorgb`, `bitstorgb`,
  `gradients`, `RetiledGeoTIFFImage` and `createArrow`.
- The `NOTCOG` error cause: `GeoTiffTileSetModel.create` opens any GeoTIFF; `infoFromURL(url).isCog` tells whether
  a file is a COG.

## 0.0.3 - 2025-06-05

`GeoTiffTileSetModel.createFromURL` and `infoFromURL` for Cloud Optimized GeoTIFFs.
