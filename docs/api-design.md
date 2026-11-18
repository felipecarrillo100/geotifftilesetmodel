# API design: one model, one factory

Status: agreed direction, being implemented on `remote-sensing-styling`.

The workflow the API is built around:

1. **Query capabilities**: what a catalog or a file offers.
2. **Choose** what you are interested in, from what step 1 returned.
3. **Create the model**: one factory.
4. **Add the model to a layer**. Done.
5. **Style** at creation, or later with model updates.

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
const selection = {collection: id, area, datetime: [from, to], where: userFilters, bands: chosenBands};
const problems = catalog.check(selection, collection);      // [] when the request fits the collection
const found = await catalog.select({...selection, pick: {per: "year"}});   // items, periods, plan
const chosenItems = ...;                                     // found.items, or the ones the user ticked

// 3. Model.
const model = await GeoTiffTileSetModel.create({stac: {items: chosenItems}});

// 4. Layer.
map.layerTree.addChild(new RasterTileSetLayer(model, {label: collection.title ?? id}));

// 5. Style.
await model.setStyle({render: {type: "pseudocolor", expression: "(nir - red) / (nir + red)", stretch: [-0.2, 0.9]}});
```

## 1. One model class

`GeoTiffTileSetModel` is the only model. It is the engine of the former `StackedGeoTiffTileSetModel` (inputs,
band names, styles, statistics, legends, shared caches) plus what only the original model did: elevation, mosaics
of tiles, and file inspection. `StackedGeoTiffTileSetModel`, `openCog` and `openManifest` were never released and
are removed.

LuciadRIA fixes a model's `dataType` when it is constructed (`RasterTileSetModel.dataType` has no setter), so a
model is imagery or terrain for its whole life. That is an option, not a second class.

## 2. One factory: `GeoTiffTileSetModel.create(options)`

```ts
static create(options: CreateModelOptions): Promise<GeoTiffTileSetModel>
```

Exactly one source:

| Source option | Type | Meaning |
|---|---|---|
| `url` | `string \| URL` | One GeoTIFF by URL (shortcut for `inputs: [{url}]`). |
| `file` | `Blob \| ArrayBuffer \| GeoTIFF` | One GeoTIFF from memory or a `<input type="file">` (shortcut for `inputs: [{file}]`). |
| `inputs` | `BandInput[]` | Several GeoTIFFs: as bands (different names) and/or as a mosaic (the same name). |
| `stac` | `StacModelSource` | STAC items the user chose, or a selection to search and pick. |
| `manifest` | `string \| URL \| Blob \| StackManifest` | A manifest: these same options saved as JSON. |

Options common to every source:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `bands` | `Record<string, string>` | | Names by location, 1-based: `{red: "f1_b3", nir: "f2_b1"}`; `b3` = `f1_b3` with one file. |
| `style` | `BandStyle \| (bandNames: string[]) => BandStyle` | `autoStyle` | Imagery only. |
| `dataType` | `RasterDataType` | `IMAGE` | `ELEVATION` for terrain. |
| `elevation` | `ElevationOptions` | | Terrain only: `height`, `tileSize` (64), `noDataHeight`. |
| `reference` | `CoordinateReference` | the files' | Overrides the reference of every input. |
| `tileSize` | `number` | 256 | Imagery tile size in pixels, an integer from 16 to 4096 (`RangeError` otherwise). |
| `byteCacheSize` | `number` | 16 | MiB of fetched bytes kept per input. |
| `cacheSize`, `decodedBlocks`, `statisticsSize`, `pool`, `onReadError` | | as today | |
| `signers`, `rewriteUrl` | `AssetSigner[]`, `(url) => string` | Planetary Computer signer | Applied to every URL, not only STAC ones. |
| `credentials`, `requestHeaders`, `requestParameters` | | | HTTP options, applied to every request (manifests and STAC items too). |

Rules that fill the gaps:

- **Band names.** Without names: GDAL band descriptions, else `b1…bN` for one file, `f1_b1…` for several. With
  `bands`, only the bands named there exist.
- **Mosaic = same band name in several inputs.** Where inputs overlap, the first input with data at a pixel wins:
  input order is priority. The extent is the union. All inputs of a band must share the model reference
  (`REFERENCE_MISMATCH` otherwise; reprojection is out of scope). This is how
  several STAC items of one date (adjacent tiles) become one picture.
- **Elevation.** With `dataType: ELEVATION` the model serves heights in metres. One band: that band is the height.
  Several bands: `elevation.height` names one (`"dem_2024"`) or combines them with an expression
  (`"where(isnan(lidar), national, lidar)"`); missing, `create` rejects with a `RangeError` listing the bands.
  `style` with elevation is rejected (`RangeError`).
- **Twins.** `model.withStyle(style)` returns an imagery twin; `model.asElevation(elevation?)` an elevation twin.
  Both share files, downloads and decoded blocks, so showing one DEM as terrain and as a hillshade reads nothing
  twice.
- **Errors.** `create` never throws synchronously: every problem rejects the promise, with a library error
  (`GeoTiffModelError` with a cause, `StyleError` with a path, `ManifestError` with problems, `StacError`, or
  `RangeError` for invalid options).
- **What was opened.** `model.getSource()` returns `{kind: "inputs" | "stac" | "manifest", items?, periods?, plan?,
  found?, manifest?}`: the UI reads periods for a time slider, items for a list.

### STAC source

```ts
type StacModelSource =
  | {items: StacItemJson[] | string[]; per?: Period; assets?: string[]; naming?: "common-name" | "asset-key";
     bandNames?: Record<string, string | string[]>; resampling?: Record<string, Resampling>}
  | StacSelection & {catalog: StacClient | string};
```

- With `items`: the items the user chose (objects, or item URLs that are fetched). They are grouped by period
  (`per`, default `"day"`): items of the same period are a **mosaic** (bands `red`, `nir`); several periods are a
  **time series** (bands `red_2024`, `nir_2024`, …; periods in `getSource().periods`).
- With `catalog` and a selection: `create` runs `catalog.select(selection)` and then the above.
- Only the assets the style reads are opened.

### Manifest source

A manifest is `create` options as JSON plus `type: "ria-geotiff/stack"`, `version: 1`, `title`, `description`,
`attribution`, `styles`; relative URLs resolve against the manifest's URL (or `base`). Options passed next to
`manifest` override the manifest's. `toManifest(model, details?)` saves a model, including `sign` and `nodata`.

## 3. `StacClient`: capabilities and choice

```ts
static connect(url: string, options?: StacClientOptions): Promise<StacClient>
readonly capabilities: StacCapabilities
collections(filter?: {area?: Bbox | GeoJsonArea; datetime?: [string | null, string | null]; q?: string}): Promise<CollectionSummary[]>
collection(id: string): Promise<CollectionDetails>        // summary + queryables + assets + raw JSON
check(selection: StacSelection, collection?: CollectionDetails): RiaGeoTiffProblem[]
select(selection: StacSelection & {pick?: Pick}): Promise<StacSelectionResult>   // {items, periods?, found, plan}
search(request: StacSearchRequest): StacSearch            // raw paging, for power users
plan(request: StacSearchRequest): SearchPlan              // what would be sent, without sending
```

`describeCatalog`, `checkRequirements`, `openStacSource`, `createItemModel`, `createTimeSeriesModel`,
`createFromStacItem` and `fetchStacItem` are removed (unreleased). Selection helpers (`coverArea`,
`bestPerPeriod`, `itemsCovering`, `groupItems`, …), `toBandInputs`, CQL2 and planning functions stay for power
users.

## 4. Compatibility

1.0.0 is the first real release, so it ships one API and no deprecated calls. The 0.0.x calls
(`createFromURL`, the gradient, band-mapping and nodata setters) are removed; the guide's
"Migrating from 0.0.x" table maps each to `GeoTiffTileSetModel.create` and a style. `infoFromURL` and
`getModelInfo` stay: they are step 1 for a single file.

## 5. Bugs fixed on the way

Found while documenting: synchronous throws in the STAC model helpers; CQL2 timestamp comparisons in the
client-side filter; `closestTo` across the new year; `toManifest` dropping `sign`/`nodata`; STAC manifests ignoring
model options and `bands`; read-error
listeners not reaching imagery reads or twins; `listCollections` caching a failure; `matched()` fetching the first
page twice; the Planetary Computer signer matching every Azure blob; `computeStatistics` counting ±Infinity;
`ramp(name)` returning `undefined`; expression JSON errors escaping as `SyntaxError`/`TypeError`; `sampleRamp` at
`+Infinity`; ramp LUT truncation; the `nir` / B8A wording in two presets. A second pass fixed the "Possible code
issues" of [review-findings.md](review-findings.md): `stac.bands` in every time series, one solar-day rule, one
reference group in `select` (with `dropped`), the `.prj` lookup through `rewriteUrl` and signing, typed
`StacError.problems`, option validation (`tileSize`, `elevation.tileSize`, `byteCacheSize`), twins sharing the
statistics region, `reference` in manifests, mixed content, antimeridian bboxes, class tables in float32, and
consistent NaN handling of mask rules.

## 6. Protected data: credentials, headers and parameters

Some URLs need a login, a token or a key. They are passed as LuciadRIA passes them, and they reach only the
server they were given for.

### The options, as in LuciadRIA

The same three options as LuciadRIA's `HttpRequestOptions` (`@luciad/ria/util/HttpRequestOptions.js`, types only),
with the same meaning:

| Option | Type | Meaning |
|---|---|---|
| `credentials` | `boolean \| RequestCredentials` | `true` = `"include"`, `false` or unset = `"same-origin"`, or a fetch mode. Cookies and HTTP authentication. |
| `requestHeaders` | `HttpRequestHeaders \| null` | Headers on every request: `{Authorization: "Bearer …"}`, `{"X-API-Key": "…"}`. |
| `requestParameters` | `HttpRequestParameters \| null` | Query parameters on every request: `{token: "…"}`, `{key: "…"}`. |

They are accepted in the same places LuciadRIA models accept them:

- in `create()` options, for the source given there (`url`, `inputs`, `manifest`, `stac`);
- per input (`BandInput.credentials`, `.requestHeaders`, `.requestParameters`), overriding the model's for that input;
- in `StacClient.connect(url, options)` (replacing its `headers` option), for the STAC API;
- as model properties with getters and setters (`model.requestHeaders = {...}`), so an application renews an expiring
  token without rebuilding the model. New requests use the new values; nothing is re-read.

### Where they go: the intended server only

Credentials, headers and parameters are sent **only to the origin (scheme, host and port) of a URL the application
gave for them**, never to a URL the library discovered:

| Request | Gets the model's credentials, headers, parameters? |
|---|---|
| `url`, `inputs[i].url`, the `manifest` URL | Yes, on that URL's origin. |
| Files a manifest lists on the manifest's origin | Yes (same server). |
| Files a manifest lists on another origin | No. |
| STAC API requests (landing, collections, search, `next` links) on the API's origin | The client's options, yes. |
| `next` links or other links pointing to another origin | No. |
| STAC assets (COGs) on the asset storage's own origin | No: the API's token is not the storage's. Assets get access through `signers` (Planetary Computer and custom), or through an explicit `assetAccess` rule (below). |
| Token endpoints of signers (Planetary Computer) | No: only what the signer itself sends. |
| Redirects | A request carrying headers or parameters is sent with `redirect: "manual"`. A redirect is followed only when it stays on the same origin; one to another origin is reported as an error naming the host the credentials were withheld from, so the application can decide. |

Power users decide per URL with one hook, which replaces the rule above when given:

```ts
access?: (url: URL, kind: "file" | "manifest" | "stac-api" | "stac-asset") => HttpRequestOptions | null
```

returning the options for that request (`null` = none). `assetAccess` in a STAC source is the same hook, for assets only.

### Never stored, never shown

- `toManifest` never writes `requestHeaders` or `requestParameters`, and manifests may not contain them (they are not
  in the schema): secrets are passed when opening, never saved in a file. `credentials` (a mode, not a secret) may be
  in a manifest.
- URLs in errors (`GeoTiffReadError.url`, `StacError.url`), in `getBands()`, `getSource()`, `toManifest` and in the
  plan's `code` (curl/fetch snippets) are shown **without** the added `requestParameters`, and headers are never shown.
  The plan's snippets put `<redacted>` where a header value would be.
- Statistics, caches and twins share data, not options: a twin made with `withStyle` or `asElevation` keeps the
  options of the model it came from.

### Tests

A local server records what each origin received: the token goes to the intended origin only, never to a second
origin (another input, an asset host, a `next` link on another host, a cross-origin redirect); errors and manifests
contain no token; changing `model.requestHeaders` affects the next requests.
