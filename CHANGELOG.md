# Changelog

## 1.0.0 - 2026-11-18

First stable release.

### Added
- **Elevation**: `dataType: RasterDataType.ELEVATION` serves one band of any integer or float type as LuciadRIA
  terrain, exactly like LuciadFusion's LTS elevation: a quadtree of 64 x 64 point samples spanning each tile edge to
  edge, encoded as LuciadElev0 PNG (16-bit + `biNy` chunk, 0.4 m steps), interpolated (bilinear, nodata aware) from
  the most suitable COG image. GDAL scale/offset is applied. Missing data uses LuciadFusion's nodata marker, so
  LuciadRIA falls back to the elevation layers below. Options: `elevation.tileSize`, `elevation.band`,
  `elevation.noDataHeight`.
- **Experimental** `GeoTiffTileSetModel.createFromURLs(urls, {dataType: ELEVATION})`: one elevation model over
  several COGs (a tiled dataset), seamless across file borders. Needed because LuciadRIA shows only one elevation
  layer at a time ("WebGLMap can only have one visible elevation layer"). May change in a minor release.
- **Read error reporting**: problems reading a file's data while serving elevation tiles are reported as
  `GeoTiffReadError` (cause `READ_FAILED`, with `url`, `fileIndex`, `image`, `recovery` and `originalError`) to
  `model.addReadErrorListener(listener)` / `options.onReadError`, once per file and image; without listeners they
  are logged with `console.warn`. The model recovers: a failing overview falls back to a more detailed image of the
  same file, and a file that cannot be read at all is shown as no data while the other files of a mosaic still show.
- `GeoTiffTileSetModel.createFromGeoTIFF(tiff, options)` for files already open with geotiff.js (dropped files,
  ArrayBuffers); they do not need to be COGs.
- Package entry point `ria-geotiff` (the deep import `ria-geotiff/lib/GeoTiffTileSetModel` keeps working).
- `GeoTiffModelError` class (with `cause` and `identifier`), `getModelInfo().canBeElevation`, `options.pool`.
- `scripts/elevation-to-cog.sh`: any elevation file to an elevation COG with GDAL.
- Unit tests (Vitest) with generated COG fixtures, and a `demo/` LuciadRIA app with `demo/fetch-swisstopo.sh`
  (builds a 10 x 8 km Zermatt / Matterhorn test area from swisstopo open data).

### Fixed
- Single-band images without a nodata value were delivered as 4 bytes per pixel declared as `RGB_888` (garbled).
- Multiband images without a nodata value were delivered as 3 bytes per pixel declared as `RGBA_8888`.
- Float single-band gradients ignored `gradient.range`.
- JPEG/YCbCr (and CIELab, CMYK) images were treated as multiband data and shown in gray; they are now converted to RGB.
- RGB nodata made a pixel transparent when *any* band matched; now, as in GDAL, when all bands match.
- Images stored as one block (strips) with 16/32-bit or float samples were truncated to 8 bits.
- Errors while reading tiles were thrown or left tiles pending; they are now reported through `onError`.
- `credentials: true` now sends credentials cross-origin (`include`); `requestParameters` are now applied.
- `infoFromURL` never stored the CRS found in a `.prj` file.
- Files without an EPSG code reported the reference `EPSG:undefined`; they now fail with `BoundsMissing`
  (pass `options.reference`).
- GeoTIFF tie points with a raster offset and `PixelIsPoint` files are georeferenced correctly.
- The decoder worker pool is created on first use in browsers only (not at import time).

### Changed
- `@luciad/ria` is a peer dependency (`>=2024.1`) and is never bundled.
- geotiff.js 3 (`~3.0.5`), with a fix for a geotiff.js regression: since 3.0.4, `fromUrl()` no longer wraps remote
  files in its blocked source unless `blockSize` is passed (geotiff.js #516). Every read then becomes its own small
  range request (27 requests instead of 1 for three tiles of the test fixture), which in browsers ends in refused
  streams and corrupt reads: "Offset is outside the bounds of the DataView". ria-geotiff now always passes
  `blockSize: 65536`. Measured on swisstopo's swissALTI3D COGs: without it 3.0.4 failed in 2 of 3 runs and 3.0.5
  in every run; with it 3.0.5 is clean (5 of 5 runs, and the full 10 x 12 km area with 120 files); 3.0.3 and
  3.1.0-beta.0 are clean either way. A unit test guards it (all range requests are whole, 64 KiB-aligned blocks).
  **Move to geotiff.js 3.1.0 once it is published on npm**: it fixes the regression itself (#530) and the LZW
  decoder (#546). 3.1.0 is tagged but its npm release failed (geotiff.js #540); see README, "geotiff.js version".
- geotiff.js' decoded-tile cache is no longer enabled (its block source already caches the fetched bytes).
- ES module package (`"type": "module"`), strict TypeScript, declarations with source maps.
- `bandMapping.rgb` is the documented property; `isRGB` is accepted as a deprecated alias.
- The license field is MIT, matching the LICENSE file.

### Removed
- The unfinished `createArrow` helper and the internal `RetiledGeoTIFFImage` class.
