# Documentation review findings

A review of the ria-geotiff documentation from the point of view of a developer who has not seen the library. Phase 1
used only the documentation: `docs/developer-guide.md`, `docs/manifest.md`, `README.md` and the TSDoc comments in
`src/` (the API reference). Phase 2 checked each gap against the code and fixed the documentation.

Verdicts:

- **ANSWERED**: the documentation answers the question precisely.
- **GUESS**: the documentation says something, but a reader must guess part of the answer (a default, a unit, a
  coordinate system, sync or async, which requests).
- **UNCLEAR**: the answer is missing, ambiguous or contradicted elsewhere.

"Status" says where the gap was fixed in phase 2.

## Questions

| # | Question | Verdict | Where (phase 1) | Gap | Status |
|---|---|---|---|---|---|
| 1 | How do I open one COG and show it? | ANSWERED | README Usage; guide 3 "From a single file"; `create` example | |n/a (already answered) |
| 2 | Which band names do I get by default, and why? | ANSWERED | guide 4.3; `BandInput.bands` | |n/a (already answered) |
| 3 | Which style do I get by default, and why? | GUESS | guide 4.5; `autoStyle`; `CreateModelOptions.style` | "First three bands" does not say what happens with 2 bands, nor that a palette file gets its table, nor what the STAC default is (README hints "of the last period"). |Fixed: guide 4.5 default-style table; `autoStyle`; `CreateModelOptions.style` |
| 4 | What exactly is `bands: {red: "f1_b3"}`? | ANSWERED | guide 4.3; `CreateModelOptions.bands` | |n/a (already answered) |
| 5 | What happens to bands I do not name in `bands: {...}`? | GUESS | guide 4.3 "only the named bands exist" | Not said whether unnamed bands can be read by `getValuesAt`, are opened at all, or cost requests. |Fixed: guide 4.3 "Bands you do not name"; `CreateModelOptions.bands`; `BandInput.bands` |
| 6 | The quick-start single-file example uses `b1`, `b2`, `b3`: does it work on every file? | UNCLEAR | guide 3 "From a single file" | A file with GDAL band descriptions gets other names, so the example's style then rejects with `StyleError`. Not warned. |Fixed: guide 3 single-file example rewritten (uses `getBandNames()`), warning added; troubleshooting row |
| 7 | What does `create()` do over the network before it resolves? | UNCLEAR | `create` ("Only headers are read"), guide 8 ("the first 64 KiB"), 4.7 (statistics) | Contradiction: "only headers" vs statistics computed before resolving (they read data). The `.prj` lookup, manifest and STAC item fetches, and the number of requests per input are not listed. |Fixed: `GeoTiffTileSetModel.create` (numbered request list); FAQ "What does create() request"; guide 8 table |
| 8 | How much is read per input when opening, and when? | GUESS | guide 8 "first 64 KiB" | Not said whether more is read for large headers, nor that reads are whole 64 KiB blocks. |Fixed: `create` step 2; guide 8 (whole 64 KiB blocks, 16 MiB fetched-bytes cache per input) |
| 9 | What happens when two inputs overlap? | ANSWERED | guide 4.3; `BandInput` | |n/a (already answered) |
| 10 | What happens when inputs have different resolutions? | GUESS | guide 4.1 "resampled (bilinear, or nearest for classes)" | Reads as if nearest is chosen automatically for classes; for plain inputs the default is always bilinear. Which image (overview) is read per tile is not said. |Fixed: `Resampling`; `BandInput.resampling`; guide 4.1, 4.3 |
| 11 | What happens when inputs have different CRS? | ANSWERED | guide 4.3, `REFERENCE_MISMATCH` | |n/a (already answered) |
| 12 | What is the tile grid of an imagery model (levels, origin, tile size)? | GUESS | guide 4.1 | The coarsest level and the number of levels are not described; "aligned with the north-west corner" vs model bounds is unclear. |Fixed: guide 4.1; class comment of `GeoTiffTileSetModel` |
| 13 | What is a "source" of a style? | UNCLEAR | guide 4.5 pipeline; `getStatistics` | "Source" also names the input kinds of `create` (guide 4.2 "Sources") and `getSource()`. Defined only inside `getStatistics`. Terms used inconsistently. |Fixed: guide 4.2 terminology note, 4.5 "value sources"; `getStatistics`; glossary |
| 14 | What are statistics, when are they computed, over what area, from which data? | UNCLEAR | guide 4.5 "coarse sample (≤ 512 px)"; `stats.ts` module "coarse overview (≤ 1024 px wide)"; `statisticsSize` default 512 | Contradiction 512 vs 1024. Which overview is read, how many requests it costs, and whether masks/nodata are excluded are scattered or missing. |Fixed: `stats.ts` module comment (512, not 1024); `statisticsSize`; `computeStatistics`; guide 4.7 |
| 15 | Why do my colours change when I pan? Do they? | UNCLEAR | guide 11 "Washed-out image" | Not said that statistics are global and do not follow the view unless `computeStatistics(bounds)` is called. |Fixed: guide 4.7, FAQ "Why do (or don't) my colours change"; `computeStatistics` |
| 16 | What happens if I call `setStyle` while tiles are loading? | GUESS | `setStyle`; guide 4.7 | Overlapping calls are covered, in-flight tile reads are covered in 4.7, but not tied together. |Fixed: `setStyle`; FAQ "setStyle while tiles are loading" |
| 17 | Is `setStyle` synchronous? What can it throw and how? | GUESS | `setStyle` | `@throws RangeError` for elevation models: thrown or rejected? Not said whether validation errors are sync. |Fixed: `setStyle` (never throws, all rejections); guide 7 sync/async paragraph |
| 18 | How do I get the values under the mouse? In which coordinates? | UNCLEAR | `getValuesAt`; guide 5 "Pixel values" | "Model reference" only. No recipe converting a mouse event to model coordinates; the recipe uses undefined `x`, `y`. |Fixed: `getValuesAt` example with view-to-model transformation; guide 5 recipe rewritten |
| 19 | What does `getValuesAt` cost in requests? | GUESS | `getValuesAt` "read at full resolution" | Not said whether it uses the tile cache or makes new requests. |Fixed: `getValuesAt`; guide 5 recipe; guide 8 table |
| 20 | How do elevation models differ from imagery? | ANSWERED | guide 4.1, 4.4 | |n/a (already answered) |
| 21 | Which options apply to elevation models, and which are ignored? | GUESS | guide 4.4; `CreateModelOptions` | `tileSize`, `cacheSize`, `statisticsSize`, `resampling` for elevation: not said. |Fixed: guide 4.4 "Options that apply / Ignored"; `ElevationOptions.tileSize`; `Resampling` |
| 22 | In which units are heights? Is anything converted? | GUESS | "heights in metres" everywhere | Not said that values are used as stored (after scale/offset), so feet stay feet unless `scale` converts. |Fixed: `ElevationOptions.height`; guide 4.4 Units; troubleshooting row |
| 23 | What is delivered where elevation has no data? | GUESS | `ElevationOptions.noDataHeight` | "LuciadFusion's own nodata marker": value not given; what LuciadRIA shows is not said. |Fixed: `ElevationOptions.noDataHeight`; guide 4.4 No data |
| 24 | What is a "LuciadElev0 PNG"? | UNCLEAR | README; guide 4.1; `getTileData` | Jargon, never defined (not in the glossary). |Fixed: glossary (LuciadElev0 PNG, LTS); guide 4.1 |
| 25 | What does `StacClient.connect()` request? | ANSWERED | `connect` | |n/a (already answered) |
| 26 | What if the server has no `/search`? | GUESS | `plan`, `search` throw `StacError` | Not said what `select()` and `create({stac: {catalog}})` do then, nor whether the error is sync or a rejection. |Fixed: guide 4.8 "A server without item search"; `StacError`; `select` @throws |
| 27 | What if the server lacks CQL2? | ANSWERED | guide 4.8; `Degradation` | |n/a (already answered) |
| 28 | What does `select()` return exactly? | ANSWERED | `StacSelectionResult` | |n/a (already answered) |
| 29 | What does `pick` do; in which order are its steps applied? | GUESS | `select`, `Pick` | One long sentence; the order (months, coverage, per, rank) and the CRS rule are hard to follow. |Fixed: `Pick` (order of steps); `select` numbered steps; guide 4.8 |
| 30 | What is a "period"? What do period labels look like? | GUESS | `Period`, `periodOf` (reference only) | The guide never shows the label formats (`2024-Q3`, `2024-W29`) nor defines "solar-day". |Fixed: `Period`; `ModelSource.periods`; guide 4.8; glossary; manifest.md |
| 31 | How are time-series band names formed? | UNCLEAR | README `red_2024_01`; guide `red_2024`; `periods` `"2024-01"` | Not said that `-` becomes `_`. Guide step 5 builds `nir_${last}`, which breaks for monthly periods (`nir_2024-01` is a subtraction). |Fixed: `StacItemsSource.per`; `ModelSource.periods`; guide 3 step 5 and time-series recipe; manifest.md; troubleshooting row |
| 32 | What happens if no item covers my area? | GUESS | `select` @throws | Says "no item is left after picking" rejects; does not suggest `coverage: "best"`, and the error's `problems` property is not on `StacError`'s documented fields. |Fixed: `select`; `StacError` (`problems`); guide 4.8 "When nothing fits"; FAQ |
| 33 | What is the difference between `StacSelection.bands` and `stac.bands`? | UNCLEAR | `StacSelection.bands` ("roles you need"), `StacItemOptions.bands` ("opened besides the style's") | `StacCatalogSource` extends both, so one property has two meanings. |Fixed: `StacSelection.bands`; `StacItemOptions.bands`; manifest.md |
| 34 | How many items does a search fetch per page? | UNCLEAR | `StacSelection.maxItems` "fetched 100 per page" vs `pageSize` default 50 | Contradiction. |Fixed: `StacSelection.maxItems` (select uses 100), `StacClientOptions.pageSize` |
| 35 | Which requests get my token? | ANSWERED | guide 9 table | |n/a (already answered) |
| 36 | How do I give a token to the asset storage (S3, Azure) of STAC items? | GUESS | guide 9 "signers, or an explicit `stac.assetAccess` hook" | No example of `assetAccess` or of a custom `AssetSigner`. |Fixed: `StacItemOptions.assetAccess` example; guide 5 recipe "A token for a STAC API, and another for its asset storage"; custom `AssetSigner` recipe |
| 37 | How do I renew a token? | GUESS | guide 5 recipe; `requestHeaders` setter | Covered for models; not said for `StacClient` (no setter documented), nor for manifests and STAC items. |Fixed: guide 9 "Renewing tokens" table; `StacClientOptions.access`; `requestHeaders` setter; `AssetSigner.sign` (corrected: not per request) |
| 38 | What happens on redirects in the browser? | ANSWERED | guide 9 | |n/a (already answered) |
| 39 | Errors of `create`: which, with which fields, sync or async? | GUESS | guide 7; `create` @throws | Guide 7 lists `NOTCOG` for `create`, `create` does not. Whether `create` rejects with `NOTCOG` is unclear. |Fixed: `create` @throws (no `NOTCOG`; `Error`, `SyntaxError` added); `GeoTiffModelErrorCause`; guide 7; README |
| 40 | Errors of `StacClient` methods: sync or async? | GUESS | `@throws` per method | `plan()` and `search()` throw synchronously, others reject; not summarised. `check()` never throws? not said. |Fixed: `StacError` class comment; guide 7 |
| 41 | What fields does `StacError` have? | GUESS | `StacError`; guide 7 lists `problems` | `problems` is not a documented property of the class. |Fixed: `StacError` class comment; guide 7 |
| 42 | What fields does `ExpressionError` have; what is `position`? | GUESS | guide 7 | 0-based character offset? Not said in the guide. |Fixed: guide 4.6 and 7 |
| 43 | What happens with read errors while browsing? | ANSWERED | `GeoTiffReadError`, `addReadErrorListener` | |n/a (already answered) |
| 44 | Tile size: what values are allowed, what does it change? | GUESS | `tileSize` "Default 256" | Allowed values (power of two?) and the cost trade-off are not said. |Fixed: `CreateModelOptions.tileSize`; guide 8 tuning |
| 45 | Cache sizes: what are `cacheSize` and `decodedBlocks` in, and how do they relate? | GUESS | `CreateModelOptions` | Two caches plus a third (fetched bytes) mentioned only in guide 1; units and per-file vs per-model not clear. |Fixed: `cacheSize`, `decodedBlocks`; guide 4.7 caches table |
| 46 | What costs requests? How do I tune? | GUESS | guide 8 | No tuning advice: what to change for slow networks, memory limits, many inputs. |Fixed: guide 8 (requests table and tuning table) |
| 47 | Manifests: what is saved by `toManifest`, what is not? | GUESS | manifest.md API; guide 9 | What happens with `file` inputs, custom renders, colour functions, custom signers: not said. |Fixed: `toManifest`; guide 4.9; manifest.md API |
| 48 | Relative URLs in manifests: relative to what? | ANSWERED | manifest.md; `base` | |n/a (already answered) |
| 49 | Is each option of `CreateModelOptions` clear (type, default, effect)? | GUESS | `CreateModelOptions` | `rewriteUrl` (applies to `.prj`, manifest, items?), `pool`, `signers` with a `file`, `access` kinds. |Fixed: `rewriteUrl`, `pool`, `signers`, `access`, `reference` in `CreateModelOptions` |
| 50 | Is each option of `BandInput` clear? | GUESS | `BandInput` | `scale`/`offset` default when the file has none (1/0), `nodata: null` vs absent, `sign` with `file`. |Fixed: `BandInput.scale`, `offset`, `nodata`, `sign`, `file` |
| 51 | Is each option of `StacClientOptions` clear? | ANSWERED | `StacClientOptions` | |n/a (already answered) |
| 52 | Is each field of `StacSelection` clear? | GUESS | `StacSelection` | `datetime` year forms in which time zone; `maxCloud` with items without cloud cover. |Fixed: `StacSelection.datetime`, `maxCloud`, `area` |
| 53 | Is each field of `Pick` clear? | GUESS | `Pick` | `coverage` without an area; ties in `rank`. |Fixed: `Pick.coverage`, `Pick.rank` |
| 54 | Does a recipe or example use undefined variables? | UNCLEAR | guide 5 | "Time series" (`catalog`, `id`, `area`, `from`, `to`), "Pixel values" (`x`, `y`, `minX`...), "Class raster" (`model` with band `landcover`), "Terrain and coloured" (`ramp` not imported). |Fixed: every recipe of guide 5 defines its variables and imports |
| 55 | What is a "twin" and what does it share? | ANSWERED | guide 4.1; glossary | |n/a (already answered) |
| 56 | What does `credentials: true` do? | ANSWERED | guide 9 | |n/a (already answered) |
| 57 | What does `getSource()` return for a manifest with a STAC source? | ANSWERED | `ModelSource` | |n/a (already answered) |
| 58 | How do I open a dropped file and its `.prj`? | GUESS | `BandInput.url` with `file` | The `.prj` lookup with `file` only: not said that a dropped `.prj` needs `options.reference`. |Fixed: `BandInput.file` |
| 59 | What is "solar day"? | UNCLEAR | manifest.md `pick.per`; `Period` | Jargon in the guide and manifest doc without a definition there. |Fixed: `Period`; guide 4.8; glossary; manifest.md |
| 60 | What happens when STAC items of one period use different CRS? | UNCLEAR | `Pick.per` ("largest group with one CRS") | Only for `select` with `per`; for `create({stac: {items}})` not said. |Fixed: `StacItemsSource.items`; `Pick.per`; guide 4.8 |
| 61 | What is the "8-bit fast path" and does it change results? | GUESS | guide 4.7 | Whether the output differs (no resampling) is not said. |Fixed: guide 4.7 (same colours, conditions listed) |
| 62 | What is `infoFromURL` reading, and is it the same as `create`? | GUESS | `infoFromURL` | Requests not described. |Fixed: `infoFromURL` |
| 63 | Are statistics recomputed after `setStyle`? Which region? | ANSWERED | `computeStatistics` "Later style changes ... same region" | |n/a (already answered) |
| 64 | Does `withStyle` re-read headers or statistics? | GUESS | `withStyle` | Statistics per twin: says computed, not whether it costs requests. |Fixed: `withStyle`; FAQ "Does a twin cost requests?" |

## Other findings

- **Jargon before definition**: "twin" (guide 4.1, defined only in the glossary), "source" (two meanings), "LuciadElev0",
  "LTS", "solar-day", "item_assets", "common name" (used in 4.8 before the glossary).
- **Inconsistent terms**: "tile" means both a LuciadRIA tile and a GeoTIFF block ("tiles of one dataset" also means
  files of a tiled dataset); "colour" vs "color" in property names (the API uses `color`, the prose `colour`).
- **Contradictions**: statistics sample size (512 vs 1024); page size (100 vs 50); `NOTCOG` for `create` (guide 7 vs
  `create`); "only headers are read" vs statistics before resolving.
- **Examples that do not run**: guide 5 recipes listed in question 54; guide 3 step 5 with monthly periods
  (question 31).

Phase 2 also fixed the "Other findings": jargon is defined before use or in the glossary (twin, source and value
source, LuciadElev0, LTS, solar day, item_assets, block vs tile); the four contradictions are resolved in favour of the
code; the examples of question 54 and 31 now run as written. `create` is written `GeoTiffTileSetModel.create`
throughout.

## Possible code issues

Behaviour found while reading the code (items 1–11 by this review, 12–34 by earlier reviews). Each was checked
against the code and, where it still existed, fixed with a regression test (`test/review.test.ts`, by item number,
unless another test file is named). The documentation describes the fixed behaviour.

| # | Issue | Status |
|---|---|---|
| 1 | `stac.bands` matched time-series names only with `per: "year"` (`red_2024_07` never matched `red`) | Fixed: the period suffix of each slice is removed exactly, for every period |
| 2 | `create({stac: {items, per: "solar-day"}})` grouped by UTC day; `select` used the area's longitude | Fixed: one rule everywhere, each item's centre longitude (`solarLongitude`, new): `create`, `select`, `bestPerPeriod`, `groupItems` |
| 3 | `select` could return several references (`coverage: "best"` without `per`), or dropped smaller reference groups silently (with `per`) | Fixed: when the result can hold several items, one reference group is chosen deterministically (most area covered, then most candidates, then the reference that sorts first); the rest is in the new `StacSelectionResult.dropped` and a `pick` warning in `problems` |
| 4 | The `.prj` lookup ignored `rewriteUrl`, signing and the access rules | Fixed: the `.prj` URL is signed with the input's signer, rewritten with `rewriteUrl` and requested with the input's HTTP options; `getReferenceFromPrjFile` takes a `prepare` function |
| 5 | `StacClientOptions.rewriteUrl` documented an `"asset"` kind that was never used | Fixed: the kind is removed; the signature is `(url) => string`, as `create`'s own `rewriteUrl` (the client never requests assets) |
| 6 | `StacError.problems` was not declared | Fixed: a typed, documented `problems` (fifth constructor parameter); since then `RiaGeoTiffProblem[]` on every library error |
| 7 | An invalid `elevation.tileSize` threw a plain `Error` | Fixed: `RangeError`, checked before any request (also by `asElevation`) |
| 8 | Imagery `tileSize` was not validated | Fixed: an integer from 16 to 4096, else `RangeError` before any request |
| 9 | The fetched-bytes cache was a fixed 16 MiB per input | Fixed: new option `byteCacheSize` (MiB per input, default 16), also in manifests |
| 10 | `withStyle` twins did not take over the `computeStatistics(bounds)` region | Fixed: a twin starts with its model's region and a copy of its statistics |
| 11 | `toManifest` did not save `reference` | Fixed: written as its identifier when the model was opened with `options.reference`; manifests accept `reference` and resolve it when opened |
| 12 | `listCollections` cached a rejected promise | Already fixed (test in `sources.test.ts`) |
| 13 | `matched()` then `pages()` fetched the first page twice | Already fixed (test in `sources.test.ts`) |
| 14 | `resolveAsset` accepted `http://` hrefs, blocked as mixed content on https pages | Fixed: an https URL is preferred; an http-only asset is `readable: "no"`, reason `"mixed content"`, on https pages, readable elsewhere; `toBandInputs` and STAC sources accept it when a `rewriteUrl` is given |
| 15 | Collection area filters used plain bbox overlap, wrong across the antimeridian | Fixed: `bboxesIntersect` splits boxes with `west > east`; `findCollections`, `collections` and `check` use it |
| 16 | `evaluateCql2` compared datetime properties with `{timestamp}` / `{date}` literals as string vs number | Already fixed (test in `stac.test.ts`) |
| 17 | `evaluateCql2` threw for unsupported operators only when the property existed | Fixed: unsupported operators always throw |
| 18 | `pick.rank: {closestTo: "MM-DD"}` measured the distance within the item's year only | Already fixed: the nearest occurrence in the year before, of or after the item (test in `sources.test.ts`) |
| 19 | `collectionBands` and `itemBandNames` applied the naming rules differently | Fixed: both use one implementation (identifiers, ambiguity, aliases, multiband names) |
| 20 | `footprintOf` misread 3D bboxes; `bboxOf` of a geometry without polygons returned infinities | Fixed: 3D bboxes are read as `[w, s, zmin, e, n, zmax]`; `bboxOf` reads the positions of any geometry and throws `RangeError` when there are none |
| 21 | Expression JSON errors escaped as `SyntaxError` / `TypeError` | Already fixed in `toExpressionNode` (test in `bands.test.ts`); the stale `@throws SyntaxError` of `compileExpression` is corrected |
| 22 | `StyleError` with an empty path gave a message starting with `": "` | Fixed: the bare message |
| 23 | Class tables matched Float32 pixels exactly against double keys (`0.1` never matched) | Fixed: keys are rounded to float32 (`Math.fround`) |
| 24 | Band mask rules never hid NaN pixels, inverted expression rules did | Fixed: a rule hides the pixels where it has no data (NaN in its band, in a band its expression reads, or as its result), inverted or not |
| 25 | `sampleRamp(+Infinity)` gave the colour at 0, and returned the ramp's own stop object | `+Infinity` already fixed (test in `bands.test.ts`); fixed now: a copy is returned |
| 26 | Compiled and vectorised expressions differed for infinite literals (`1e999`) | Fixed: the compiled code keeps infinite literals infinite, as the interpreter does |
| 27 | `ramp(name)` returned undefined for unknown names; `presetStyle` threw a plain `Error` | `ramp` already fixed (test in `bands.test.ts`); fixed now: `presetStyle` throws a `RangeError` listing the ids |
| 28 | `computeStatistics` skipped NaN but not ±Infinity | Already fixed (test in `bands.test.ts`) |
| 29 | A `ColorFunction` got the pre-gamma position as `value` when `gamma` ≠ 1 | Fixed: `value` is the data value of the pixels drawn at `t` |
| 30 | `CompiledStyle.render` threw for an `out` whose byte offset is not a multiple of 4 | Fixed: renders aside and copies |
| 31 | `swir` and `atmospheric` presets said "B8A" but use `nir` (B8) | Already fixed: the descriptions say B8, which is what `nir` is on Earth Search (B8A is `nir08`) |
| 32 | `readManifest` fetched without the HTTP options and access rules; `getReferenceFromPrjFile` treated a `#fragment` as part of the query | `readManifest` already fixed (it uses the HTTP options or `access`); fixed now: the `.prj` URL keeps the query and drops the fragment |
| 33 | Imagery read failures did not reach `addReadErrorListener` listeners, and twins did not share them | Already fixed (tests in `sources.test.ts` and `mosaic.test.ts`) |
| 34 | The ramp lookup table truncated interpolated channels | Partly fixed earlier (the pixel-to-entry index is rounded); fixed now: the channels of each entry are rounded too |
