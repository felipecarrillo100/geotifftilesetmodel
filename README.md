# ria-geotiff

Cloud Optimized GeoTIFF (COG) support for [LuciadRIA](https://www.luciad.com/): a `RasterTileSetModel` that streams
a COG straight from a URL with HTTP range requests, and shows it as **imagery** or uses it as **terrain**.

- **Imagery**: RGB(A), JPEG/YCbCr orthophotos, palette images, 8/16/32-bit and float single-band data colored with a
  gradient, and multiband data with a band mapping. Each image of the COG (full resolution and overviews) is one
  level of the tile set.
- **Elevation** (`dataType: RasterDataType.ELEVATION`): one band of any integer or float type is served as terrain,
  in the same tile layout LuciadFusion uses for its elevation coverages (see [Elevation](#elevation)).

LuciadRIA is **not** included: it is a peer dependency, the application provides it.

## Requirements

- LuciadRIA 2024.1 or later (peer dependency; built and tested with 2026.1.2).
- An ES module bundler (Vite, webpack, ...) or TypeScript.

## Install

```bash
npm install ria-geotiff
```

## Usage

```ts
import {GeoTiffTileSetModel} from "ria-geotiff";
import {RasterTileSetLayer} from "@luciad/ria/view/tileset/RasterTileSetLayer.js";

const model = await GeoTiffTileSetModel.createFromURL("https://example.com/orthophoto.tif");
map.layerTree.addChild(new RasterTileSetLayer(model, {label: "Orthophoto"}));
```

The file must be a COG (tiled, with its header at the start of the file) and served with HTTP range support; for
cross-origin URLs the server must allow CORS (`Access-Control-Allow-Origin`, and `Range` in
`Access-Control-Allow-Headers`). For files that are already open, such as a dropped file, use
`createFromGeoTIFF`, which also accepts GeoTIFFs that are not COGs:

```ts
import {fromBlob} from "geotiff";
const model = await GeoTiffTileSetModel.createFromGeoTIFF(await fromBlob(file));
```

### Elevation

```ts
import {RasterDataType} from "@luciad/ria/model/tileset/RasterDataType.js";

const terrain = await GeoTiffTileSetModel.createFromURL("https://example.com/dem.tif", {
    dataType: RasterDataType.ELEVATION,
});
map.layerTree.addChild(new RasterTileSetLayer(terrain, {label: "Terrain"}));
```

Elevation tiles are delivered to LuciadRIA exactly as LuciadFusion delivers its elevation (LTS) tiles:

- a quadtree with **64 x 64 samples** per tile (`elevation.tileSize`);
- **point sampling**: the samples of a tile span its bounds edge to edge, so neighbouring tiles share the samples on
  their common edge and the terrain has no seams;
- encoded as LuciadFusion's **LuciadElev0 PNG**: 16-bit grayscale plus a private `biNy` chunk with the offset `p`
  and range `q`, `height = p + v * (q - p) / 65535`, 0.4 m steps, `v = 0` = no data. This is the format LuciadRIA's
  terrain decodes natively (raw `FLOAT_32` tile data is not accepted by its WebGL terrain painter).

The heights are interpolated (bilinear, nodata aware) from the most suitable image of the COG, so the COG itself can
use any tile size, data type (Int16, UInt16, Int32, Float32, Float64...) and overview layout. GDAL scale/offset
metadata is applied. LuciadRIA treats the heights as metres above the geoid.

| Option                    | Default | Meaning                                                                    |
|---------------------------|---------|----------------------------------------------------------------------------|
| `elevation.tileSize`      | 64      | Samples along each side of a tile.                                          |
| `elevation.band`          | 0       | Band holding the heights.                                                   |
| `elevation.noDataHeight`  | none    | Height used where the file has no data. By default missing data is sent as LuciadFusion's nodata marker, and LuciadRIA shows the elevation of the layers below it there (for example a world elevation layer). |
| `nodata`                  | file's GDAL_NODATA | Value that marks missing data.                                   |

**One elevation layer only.** LuciadRIA shows a single elevation layer at a time: it hides the others (console:
"WebGLMap can only have one visible elevation layer"). For a dataset published as many files, create one model over
all of them (experimental):

```ts
const terrain = await GeoTiffTileSetModel.createFromURLs(tileUrls, {dataType: RasterDataType.ELEVATION});
```

Imagery has no such limit: show image files as one layer each, for example in a `LayerGroup`.

To turn any elevation file into a suitable COG, use [`scripts/elevation-to-cog.sh`](scripts/elevation-to-cog.sh)
(GDAL): a single Float32 band with nodata, optional reprojection, 256 x 256 tiles, DEFLATE and averaged overviews.

```bash
scripts/elevation-to-cog.sh dem.hgt dem-cog.tif
scripts/elevation-to-cog.sh "tiles.vrt" dem-3857.tif --t-srs EPSG:3857
```

### Coordinate references

The model uses the EPSG code in the GeoTIFF (or a `.prj` file next to it, or `options.reference`). When LuciadRIA
does not know the code, `createFromURL` rejects with a `GeoTiffModelError` whose `cause` is `"UnknownIdentifier"`
and whose `identifier` is the code: register its definition and try again.

```ts
import {addReference, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {GeoTiffModelError} from "ria-geotiff";

try {
    model = await GeoTiffTileSetModel.createFromURL(url);
} catch (error) {
    if (error instanceof GeoTiffModelError && error.cause === "UnknownIdentifier") {
        addReference(parseWellKnownText(await fetchWkt(error.identifier!)), error.identifier);
        model = await GeoTiffTileSetModel.createFromURL(url);
    } else throw error;
}
```

Error causes: `ERROR_LOADING_FILE`, `NOTCOG`, `UnknownIdentifier`, `BoundsMissing`, `INVALIDELEVATION`,
`READ_FAILED`.

### Read errors while browsing

Once a model is created, reading its data can still fail (a request fails, a block of a file is damaged). For
elevation the model recovers: it falls back to a more detailed image of the same file, or shows that file's area as
no data while the other files of a mosaic still show. Each problem is reported once, as a `GeoTiffReadError`, so the
application can log it or show it to the user:

```ts
const terrain = await GeoTiffTileSetModel.createFromURLs(urls, {
    dataType: RasterDataType.ELEVATION,
    onReadError: (error) => showWarning(`${error.url}: ${error.message}`), // error.recovery: "finerImage" | "nodata"
});
const handle = terrain.addReadErrorListener((error) => console.log(error.image, error.originalError));
handle.remove();
```

Without listeners the model logs them with `console.warn`.

### Gradients

Single-band imagery is colored with a gradient: color stops from level 0 to 1 and the data `range` they span.
Without a range the full range of the data type is used (for float data: the GDAL statistics in the file, or 0..1).

```ts
const gradient = {
    colorMap: [
        {level: 0, color: "#0000FF"},
        {level: 500 / 8848, color: "#00FF00"},
        {level: 2000 / 8848, color: "#FFFF00"},
        {level: 4000 / 8848, color: "#A52A2A"},
        {level: 1, color: "#FFFFFF"},
    ],
    range: {min: 0, max: 8848},
};
const model = await GeoTiffTileSetModel.createFromURL(url, {gradient});
model.setGradient(otherGradient); // later
```

### Bands

```ts
// Combine three bands into a color image
await GeoTiffTileSetModel.createFromURL(url, {bandMapping: {red: 3, green: 2, blue: 1, rgb: true}});
// Color one band of a multiband file with a gradient
await GeoTiffTileSetModel.createFromURL(url, {gradient, bandMapping: {gray: 2, rgb: false}});
model.setBandMapping({red: 0, green: 1, blue: 2, rgb: true}); // later
```

### HTTP options

`credentials` (send cookies cross-origin), `requestHeaders` and `requestParameters` (added to the query string) apply
to every request. `infoFromURL(url)` reads only the header and reports size, bands, data type, CRS, tiling and
whether the file is a COG.

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
