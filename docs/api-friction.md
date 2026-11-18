# API friction found while building the studio's "Add a layer" tab and layer list

Each entry: what the UI needed, what it does instead (demo/src/studio/openData.ts, footprints.ts, studio.ts), and a
proposed API change. Ordered by how much they cost the UI. All 21 findings are fixed; each says how.

## High

### 1. `select()` cannot be cancelled and reports no progress
- **Needed**: a Cancel button and "page 2 of …, 180 items scanned" while a selection runs (a static catalog crawl can
  read up to 2000 item documents).
- **Instead**: Cancel only ignores the result of `select`; its requests keep running. Progress is a fixed text.
  `search()` takes a `signal`, so the "All items found" path can cancel, but it also has no progress callback
  short of iterating `pages()` by hand.
- **Proposal**: `select(selection, {signal, onProgress})` with `onProgress({pages, scanned, kept})`; the same
  `onProgress` on `search().collect()` and on `collections()` for static catalogs.
- **Fixed**: `select(selection, {signal, onProgress})` and `search(request, {signal, onProgress})`; aborting stops the requests and rejects with the signal's reason; `StacProgress` `{step, pages, scanned, kept, matched}`. Static crawls of `collections()` still have no progress.

### 2. `select()` does not say why candidates were left out, nor how much of the area each item covers
- **Needed**: per item, its coverage of the view, and for items not picked the reason (cloud, months, coverage below
  "full", another coordinate reference, ranked lower).
- **Instead**: the UI recomputes coverage with `coverageOf(item, area)` for every row; only the CRS drops are
  explained (`dropped`). Items filtered by `months` or `coverage` are invisible; `found` is a bare count.
- **Proposal**: `StacSelectionResult.candidates: {item, coverage, period?, picked: boolean, reason?: "months" |
  "coverage" | "reference" | "rank"}[]`, and `coverage` on each picked item.
- **Fixed**: `StacSelectionResult.candidates: StacCandidate[]` (`{item, picked, reason?, coverage?, period?}`); an empty selection's `problems` count the items each rule excluded (also covers part of #21).

### 3. Two requests to identify a GeoTIFF and know whether it is a COG
- **Needed**: "✓ GeoTIFF · ✓ COG" in one step.
- **Instead**: `identifySource(url)` then `probeCog(url)`: the first 64 KiB are fetched twice.
- **Proposal**: `identifySource(src, {cog: true})` returning `cog: CogProbe` on `kind: "geotiff"`, computed from the
  bytes already read (plus `probeCog`'s one optional second read); or `probeCog` accepting the identification's bytes.
- **Fixed**: `IdentifiedGeoTiff.cog: CogProbe`, from the bytes already read (one more range request only when the directories continue beyond 64 KiB).

### 4. Models from STAC open only the bands the first style reads
- **Needed**: after "Show on map", the style panel (presets, expression editor) should offer every band of the items.
- **Instead**: the UI passes the bands chosen in step 2 as `stac.bands`; for an item collection or a single item there
  is no band list, so presets that need other bands fail with a `StyleError` until the layer is reopened.
- **Proposal**: `stac.bands: "all"` (open every data asset), or lazy opening of an asset when a style first needs it.
- **Fixed**: lazy opening. The model lists every band of the items (`getBandNames()`); `setStyle`, `withStyle` and `asElevation` open the assets they need first, once, shared with twins. `stac.bands` was removed.

### 5. Four error classes with four shapes
- **Needed**: one error box that shows the message and the useful fields.
- **Instead**: `describeError` switches on `StacError` (`status`, `url`, `problems`), `GeoTiffModelError` (`cause`,
  `identifier`, `pixelFormat`, `originalError`), `ManifestError` (`problems` without severity) and `StyleError`
  (`path`). The trace helper repeats the list of fields.
- **Proposal**: a common base (`GeoTiffLibraryError`) with `details(): Record<string, unknown>` or `toJSON()`, and
  `problems: {path, severity, message}[]` with the same shape for manifests and selections.
- **Fixed**: base class `RiaGeoTiffError` with `problems: RiaGeoTiffProblem[]` (`{path, severity, message}`, replacing `ManifestProblem` and `RequirementProblem`), `details()` and `toJSON()`, for `GeoTiffModelError`, `GeoTiffReadError`, `StacError`, `ManifestError`, `StyleError`, `ColorMapError` and `ExpressionError`.

### 6. A collection URL needs guesswork to become a client
- **Needed**: paste `…/collections/sentinel-2-c1-l2a` and get its API with the collection preselected.
- **Instead**: `identifySource` gives `apiUrl` from the `root` link without checking it; the UI calls
  `StacClient.connect(apiUrl)` and falls back to `StacClient.connect(collectionUrl)` (a static client of one
  collection) when that fails.
- **Proposal**: `StacClient.fromCollection(url): Promise<{client, collection: CollectionDetails}>`, or
  `connect` accepting a collection URL.
- **Fixed**: `StacClient.connect(collectionUrl)` connects to the collection's API (root link with item search; credentials only on the origin given) or crawls the collection itself, with `client.collectionId` set.

## Medium

### 7. Footprints exist only on search pages
- **Needed**: footprints of the items returned by `select` (or an item collection) for a vector layer.
- **Instead**: the UI builds features from `item.geometry ?? {type: "MultiPolygon", coordinates: footprintOf(item)}`;
  `SearchPage.footprints()` is only reachable while iterating pages.
- **Proposal**: an exported `footprints(items)` (the same FeatureCollection as `SearchPage.footprints()`), with a stable
  `key` per feature.
- **Fixed**: `itemFootprints(items)`, feature ids `itemKey(item)`; `SearchPage.footprints()` returns the same.

### 8. Item ids are not unique keys
- **Needed**: a key per row and per footprint feature.
- **Instead**: the list index is the key (ids repeat across collections, and items of different catalogs can share an
  id).
- **Proposal**: document `${collection}/${id}` as the key and give helpers that use it (`dedupeItems` already does
  internally).
- **Fixed**: `itemKey(item)` exported and documented; `dedupeItems` and `itemFootprints` use it; the studio keys rows and features by it.

### 9. The search request of a selection is internal
- **Needed**: "All items found (no pick)" with the same filters as `select`.
- **Instead**: the UI rebuilds `where: {"eo:cloud_cover": {lt: maxCloud}}` from `maxCloud` and copies `area` and
  `datetime` into a `StacSearchRequest`.
- **Proposal**: `selectionToRequest(selection)` exported, or `select({..., pick: "all"})` returning every item found.
- **Fixed**: `selectionToRequest(selection)`, used by `select` itself.

### 10. `collections({area})` cannot keep a preselected collection, and its intersection test is not exported
- **Needed**: "Only collections covering the view" toggled without new requests, and the collection the user pasted
  kept in the list.
- **Instead**: the UI lists all collections once and repeats the bbox test itself (`bboxesIntersect` is internal).
- **Proposal**: export `bboxesIntersect`, or add `collections({area, include: [id]})`.
- **Fixed**: `collections({area, include: [id]})` (no new requests: the list is cached) and `bboxesIntersect` exported.

### 11. Static catalog crawling stops at the first broken link
- **Needed**: list what could be read and say which links failed.
- **Instead**: a failed `child` or `item` document rejects `collections()` or the search with a `StacError`.
- **Proposal**: `crawl.onError: "skip" | "throw"` and `client.crawlProblems: {url, error}[]`.
- **Fixed**: `crawl.onError: "skip"` (default) records unreadable documents in `client.crawlProblems`; `"throw"` rejects.

### 12. "Catalog without search" means two things
- **Needed**: one answer to "can I search this?".
- **Instead**: `identifySource` reports `stac-catalog` for any catalog without item search, but `StacClient` treats an
  API with a collections endpoint and no search (OGC API - Features only) as not static: `search` then throws.
- **Proposal**: crawl `items` links (OGC API - Features) in that case too, or an `IdentifiedStacCatalog.searchable`
  flag computed with the same rule as `capabilities.staticCatalog`.
- **Fixed**: OGC API - Features servers are searched through their collections' `items` endpoints; `capabilities.search` and `IdentifiedStacCatalog.search` give the one answer.

### 13. Terrain models cannot be told apart from imagery without LuciadRIA's enum
- **Needed**: "this layer has no style" in the layer list and the styling area.
- **Instead**: the UI compares `model.dataType === RasterDataType.ELEVATION` (and `isElevation` for other layers).
- **Proposal**: `model.isElevation` (or `model.kind: "image" | "elevation"`), and `setStyle` on terrain rejecting with a
  clear `RangeError` (it is documented for `create`, not for `setStyle`).
- **Fixed**: `model.isElevation`; `setStyle` on terrain already rejects with a documented `RangeError`.

### 14. No way to release a model
- **Needed**: the trash button should free the caches of a removed layer.
- **Instead**: the UI drops its references and relies on garbage collection; the shared decoder pool and tile caches
  are not released explicitly.
- **Proposal**: `model.dispose()` (clears its caches, detaches twins' shared state when the last one goes).
- **Fixed**: `model.dispose()`; the studio disposes models whose layers are removed (and the swipe twin).

### 15. Unknown coordinate references need an application helper
- **Needed**: open the fixtures in UTM 33N (EPSG:32633) and any EPSG code a STAC item names.
- **Instead**: the studio wraps every `create` in its own `withReferenceRetry` (fetch the definition, `addReference`,
  try again); the first attempt is logged as a `GeoTiffModelError` (`UnknownIdentifier`).
- **Proposal**: `CreateModelOptions.resolveReference?: (identifier) => Promise<string /* WKT */>`.
- **Fixed**: `CreateModelOptions.resolveReference(identifier) => Promise<WKT | null>`; the studio's retry helper is gone.

## Low

### 16. No hook to observe the library's calls and requests
- **Needed**: the "Log library calls to the console" feature.
- **Instead**: demo/src/studio/trace.ts wraps each call and rebuilds its TypeScript text and summary by hand.
- **Proposal**: an `onRequest({url (redacted), kind, range, status, ms})` option on `create`, `identifySource`,
  `probeCog` and `StacClient`, for logs and progress.
- **Fixed**: `onRequest` (`RiaGeoTiffRequest`) on `create`, `identifySource`, `probeCog`, `readManifest` and `StacClient`; the studio logs each request with it. Rebuilding the call text stays the studio's job.

### 17. `select` defaults to `coverage: "full"`, which fails for most views
- **Needed**: a sensible first search for "the current view".
- **Instead**: the UI defaults to "best"; with "full" a view larger than a scene rejects with "No item meets the
  selection".
- **Proposal**: keep the default but name the cause in the error (`problems: [{path: "pick.coverage", ...}]`).
- **Fixed**: the default stays `"full"`; an empty result names `pick.coverage`, the share the best item covers, and suggests `"best"` (done with #2).

### 18. Band names of a collection vs. of its items
- **Needed**: the bands the model will have, before the search.
- **Instead**: `CollectionSummary.bands` are asset keys when `describesRoles` is false (INPE); the UI only notes "bands
  are asset keys".
- **Proposal**: `CollectionSummary.bandSource: "common-name" | "asset-key"` and the names `itemBandNames` would give.
- **Fixed**: `CollectionSummary.bandNaming: "common-names" | "asset-keys" | "none"` replaces `describesRoles`; `getBandNames()` of the model is the final answer.

### 19. The style a source chose is read back after create
- **Needed**: the scene's starting style.
- **Instead**: the UI copies `model.getStyle()` after `create` into its scene; fine, but undocumented as the way to
  learn the default style.
- **Proposal**: document it in `create`'s `@returns`, or export `defaultStyleFor(bandNames, source)`.
- **Fixed**: documented in `create`'s `@returns`: the default style, read with `getStyle()`.

### 20. `getModelInfo().isCog` describes the first file only
- **Needed**: "not a COG" for a STAC model where one asset is not a COG.
- **Instead**: the UI probes only the single-file sources.
- **Proposal**: `model.getBands()[i]` (or `getInputs()`) with an `isCog` per input.
- **Fixed**: `BandLocation.isCog` for every input (from the header already read).

### 21. An empty selection does not say which requirement excluded the items

Found while testing the studio against the static sample catalog: `select()` rejected with "No s2-sample item meets
the selection (0 found by the search)". The cause was two defaults together: the date range (the collection's last
year) excluded one item and `maxCloud: 20` the other. The UI could not tell the user which requirement to relax.

- Proposed: when a search or a pick ends empty, `StacError.problems` lists, per requirement (`datetime`, `area`,
  `where.<property>`, `pick.coverage`), how many candidates it excluded, from the candidates the client saw (always
  available for client-side filtering and static catalogs; for server-side filters, from a cheap count request
  without that filter, only when the server reports counts).
- Done in the studio meanwhile: short collections default to their whole period, and the cloud filter is off by
  default.
- **Fixed**: requirements tested in the browser are counted per path (`StacSearch.rejected`) and named in the empty selection's `problems`; server-side filters cannot be seen, so the message then lists the filters to widen (no extra count requests).
