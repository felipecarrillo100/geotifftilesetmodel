# The ria-geotiff manifest (version 1)

A manifest is the options of `GeoTiffTileSetModel.create()` saved as a JSON file, so a dataset (its files, band
names, data type and styles) can be shared, versioned and opened by an application in one call:

```ts
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";
import {GeoTiffTileSetModel} from "ria-geotiff";

const map = ...;           // your LuciadRIA WebGLMap
const manifestUrl = ...;   // URL of the manifest file
const model = await GeoTiffTileSetModel.create({manifest: manifestUrl});
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Dataset"}));
```

It uses the same keys as the options, plus what only a file needs. The GeoTIFFs stay where they are and are
streamed by range requests; the manifest only describes them. Options given next to `manifest` override the
manifest's (`GeoTiffTileSetModel.create({manifest, tileSize: 512})`).

JSON Schema: [`schema/ria-geotiff-stack-1.schema.json`](../schema/ria-geotiff-stack-1.schema.json) (in the
package; editors validate and complete the file when `$schema` points to it).

## Recognising the format

Two required fields identify a manifest and its version:

```json
{"type": "ria-geotiff/stack", "version": 1}
```

- `type` names what the manifest opens: `"ria-geotiff/stack"` is a `GeoTiffTileSetModel`, and its keys are the
  options of `GeoTiffTileSetModel.create()`.
- `version` is the version of the format, independent of the library's version. It changes only when keys change
  incompatibly.

A reader rejects any other `type`, and any `version` it does not know, instead of guessing. Unknown properties are
errors too, so typos are reported rather than ignored.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `type` | `"ria-geotiff/stack"` | Required. Identifies the format. |
| `version` | `1` | Required. Format version. |
| `$schema` | string | Optional. URL of the JSON Schema, for editors. |
| `title`, `description`, `attribution` | string | Optional, for user interfaces. |
| `inputs` | array of inputs | The GeoTIFFs (or `stac`, not both). The same band name in several inputs is a mosaic. |
| `stac` | object | STAC items, or a STAC selection, that give the GeoTIFFs when the manifest is opened (or `inputs`). |
| `bands` | object | Optional. Band names by location, as the `bands` option: `{"red": "f1_b3", "nir": "f2_b1"}`. |
| `dataType` | `"image"` or `"elevation"` | Optional. Default `"image"`; `"elevation"` opens terrain (then no `style`). |
| `reference` | string | Optional. The model reference as a LuciadRIA identifier (`"EPSG:32633"`, `"CRS:1"` for pixel coordinates), as the `reference` option; default the files' own. |
| `elevation` | object | Optional. `height` (a band or an expression), `tileSize`, `noDataHeight`, as the `elevation` option. |
| `style` | style | Optional. The style shown first; default an automatic one (true colour when red, green and blue exist). |
| `styles` | object | Optional. Further named styles, for a style picker. |
| `tileSize`, `cacheSize`, `byteCacheSize`, `statisticsSize`, `decodedBlocks`, `credentials` | | Model options, as in `GeoTiffTileSetModel.create()` (`tileSize`: an integer from 16 to 4096). |

`requestHeaders` and `requestParameters` are **never** part of a manifest: they hold secrets, which are passed when
opening (`GeoTiffTileSetModel.create({manifest, requestHeaders})`). They are sent to the manifest's own server and to the files it lists
on that server, never to files on other servers. `credentials` (a mode, not a secret) may be in a manifest.

### Inputs

Each input is a `BandInput` in JSON:

| Field | Type | Meaning |
|---|---|---|
| `url` | string | Required. URL of the GeoTIFF, absolute or **relative to the manifest**. |
| `bands` | string, or list of strings and nulls | Band names: one name, or names in file order (`null` skips a band). Default: GDAL band descriptions, else `b1`…`bN`. |
| `scale`, `offset` | number | `value = raw × scale + offset`. Default: the file's GDAL tags. |
| `nodata` | number, `"nan"` or `null` | Raw value meaning no data. Default: the file's GDAL_NODATA. |
| `resampling` | `"nearest"` or `"bilinear"` | Default bilinear; nearest for classes and bit masks. |
| `sign` | `"planetary-computer"` | Sign the URL with a Planetary Computer SAS token (renewed automatically). |

JSON cannot hold functions or NaN, so two values have JSON stand-ins: `"sign": "planetary-computer"` for a signing
function, and `"nodata": "nan"` for NaN. Applications needing other signing pass a `resolve` hook to `GeoTiffTileSetModel.create`.

Name bands one way: per input (`bands` inside inputs), or by location at the top level (`bands`). With top-level
`bands`, only the bands named there exist in the model.

### A STAC source

Either STAC items by URL (absolute, or relative to the manifest):

```json
{"type": "ria-geotiff/stack", "version": 1,
 "stac": {"items": ["items/S2B_23KPT_20240715.json", "items/S2B_23KQT_20240715.json"], "per": "day"},
 "style": {"render": {"type": "rgb", "red": "red", "green": "green", "blue": "blue", "stretch": [0, 0.3]}}}
```

or a catalog and a selection, searched when the manifest is opened:

```json
{
  "type": "ria-geotiff/stack", "version": 1,
  "title": "Vale Águas Claras mine, one Sentinel-2 scene per year",
  "stac": {
    "catalog": "https://earth-search.aws.element84.com/v1",
    "collection": "sentinel-2-c1-l2a",
    "area": [-43.927, -19.99, -43.861, -19.946],
    "datetime": ["2018", null],
    "maxCloud": 3,
    "bands": ["red", "green", "blue", "nir", "swir16"],
    "pick": {"coverage": "full", "months": [6, 7, 8, 9], "per": "year"}
  }
}
```

| Field | Meaning |
|---|---|
| `items` | URLs of STAC items (instead of `catalog`). |
| `per` | With `items`: the period that groups them, default `day`. Items of one period are a mosaic; several periods a time series. Band names get the period label with `-` replaced by `_`: `red_2024`, `red_2024_07`, `red_2024_Q3`. |
| `assets`, `naming`, `bandNames`, `resampling` | Which assets, how bands are named, resampling per asset. |
| `catalog`, `collection` | The STAC API and the collection (instead of `items`). |
| `area` | `[west, south, east, north]` or a GeoJSON (Multi)Polygon, in longitude/latitude. |
| `datetime` | `"2024"`, `"2024-06"`, an interval `"2018/2026"`, or `[start, end]` with `null` for an open end. |
| `where`, `maxCloud` | Property filters (`{"eo:cloud_cover": {"lt": 5}}`); `maxCloud` is the cloud-cover shorthand. |
| `bands` | Band roles you need (`["red", "nir"]`): checked against the collection before searching, and opened besides those the style reads. In a time series give the names without the period (`"nir"` opens `nir_2024`, `nir_2024_07`, …, for any `per`). |
| `pick.coverage` | `"full"` (default with an area): items whose footprint contains the whole area; opening fails when there is none. `"best"`: the fewest items that cover it (a mosaic, in one coordinate reference as with `pick.per`). Ignored without an area. |
| `pick.rank` | `"least-cloud"` (default, then newest), `"newest"`, `"oldest"`, or `{"closestTo": "07-15"}` (a day of the year, or a date). |
| `pick.per` | The best item per `day`, `solar-day` (the local day at each item's centre longitude), `week` (ISO 8601), `month`, `quarter` or `year`, in UTC: a time series. Only the items of one coordinate reference are used: the one covering most of the area, then the one with most items. |
| `pick.months` | Keep items of these months only (1–12, UTC): a season. |
| `maxItems` | Search budget, default 300 items, fetched 100 per page. |

Before searching, the selection is checked against the collection (extent, period, bands, described properties);
errors stop with a list of problems. Model options of the manifest (`tileSize`, `bands`, …) apply to STAC sources too.

## Examples

A 4-band file, NDVI with a second style:

```json
{
  "$schema": "https://unpkg.com/ria-geotiff/schema/ria-geotiff-stack-1.schema.json",
  "type": "ria-geotiff/stack", "version": 1,
  "title": "NAIP 60 cm, Santa Cruz 2024",
  "attribution": "USDA Farm Service Agency, NAIP",
  "inputs": [{"url": "https://naipeuwest.blob.core.windows.net/naip/v002/ca/2024/ca_060cm_2024/36122/m_3612208_ne_10_060_20240529.tif",
              "bands": ["red", "green", "blue", "nir"]}],
  "style": {"render": {"type": "rgb", "red": "nir", "green": "red", "blue": "green", "stretch": {"type": "percentile", "low": 1, "high": 99}}},
  "styles": {"ndvi": {"render": {"type": "pseudocolor", "expression": "(nir - red) / (nir + red)", "stretch": [-0.2, 0.8]}}}
}
```

Separate files next to the manifest, named by location:

```json
{
  "type": "ria-geotiff/stack", "version": 1,
  "inputs": [{"url": "rgb.tif"}, {"url": "nir.tif"}],
  "bands": {"red": "f1_b1", "green": "f1_b2", "blue": "f1_b3", "nir": "f2_b1"}
}
```

## API

- `GeoTiffTileSetModel.create({manifest, ...})`: a URL, File/Blob, JSON string or object → a model. Options next to
  it override the manifest's; `base` (for relative URLs when the manifest is not opened from a URL) and `resolve(url)`
  (map URLs yourself: local files, a proxy) apply to manifests only. `model.getSource().manifest` is the manifest.
- `readManifest(source, httpOptions?)`, `validateManifest(json)` (problems with JSON paths).
- `toManifest(model, {title, styles})`: the manifest of a model opened from URLs (to save a session), with `nodata`,
  `sign`, `tileSize`, `reference` (when the model was opened with one) and, for terrain, `dataType` and `elevation`;
  never headers or parameters. Also not written: `credentials`, `cacheSize`, `byteCacheSize`, `statisticsSize`,
  `decodedBlocks`, function options (custom signers,
  `rewriteUrl`, `resolve`, `access`). A STAC source is written as its asset inputs. It throws an `Error` for inputs
  opened from a `File` or `ArrayBuffer`, and for styles with functions.
