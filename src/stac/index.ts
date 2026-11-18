/**
 * ria-geotiff/stac: find Cloud Optimized GeoTIFFs through STAC APIs and turn them into stacked models.
 *
 * Steps 1 and 2 of the workflow: connect to an API (StacClient.connect), learn what it offers (collections,
 * collection), check a selection (check) and pick items (select). The items then go to
 * `GeoTiffTileSetModel.create({stac: {items}})`. Power users plan and run searches themselves (search, plan,
 * StacSearch), choose items (coverArea, bestPerPeriod, ...), and resolve and sign assets (resolveAsset,
 * toBandInputs). Everything is plain JSON in and out.
 *
 * @packageDocumentation
 * @module ria-geotiff/stac
 */
export {StacClient, StacSearch, StacError, describe as describeCollectionJson, followNext} from "./client.js";
export type {CollectionDescription, PageCursor, Queryable, SearchPage, StacClientOptions, StacProgress} from "./client.js";
export {parseCapabilities, emptyProfile} from "./capabilities.js";
export type {ServerProfile, StacCapabilities} from "./capabilities.js";
export {planSearch, normaliseDatetime, itemMatches, requestFilter} from "./plan.js";
export type {Degradation, FilterEncoding, HttpRequestSpec, SearchPlan, StacSearchRequest} from "./plan.js";
export {evaluateCql2, toCql2Text, whereToCql2, whereToQuery} from "./cql2.js";
export type {Cql2Json, WhereComparison} from "./cql2.js";
export {bestPerPeriod, coverArea, dedupeItems, defaultScore, groupItems, itemFootprints, itemKey, itemsCovering, periodOf, solarLongitude, sortItems} from "./select.js";
export type {Period} from "./select.js";
export {DEFAULT_SIGNERS, isPlanetaryComputerItem, isPlanetaryComputerUrl, planetaryComputerSigner, resolveAsset} from "./assets.js";
export type {AssetSigner, ResolvedAsset} from "./assets.js";
export {assetBands, assetFormat, isDataAsset, isGeoTiffAsset, type AssetFormat} from "./bands.js";
export type {BandDescriptor} from "./bands.js";
export {bboxesIntersect, bboxOf, coverageOf, footprintOf, intersectsArea} from "./geometry.js";
export {assetBandMap, isCategoricalAsset, itemBandNames, toBandInputs} from "./bridge.js";
export type {ItemBandsOptions} from "./bridge.js";
export type {Bbox, GeoJsonArea, StacAssetJson, StacCatalogJson, StacCollectionJson, StacItemCollectionJson, StacItemJson, StacLink} from "./json.js";
export {collectionBands, elevationHint, SELECT_SCAN_LIMIT, selectionToRequest} from "./catalog.js";
export type {CollectionDetails, CollectionSummary, Pick, StacCandidate, StacSelection, StacSelectionResult} from "./catalog.js";
export type {StacCatalogSource, StacItemOptions, StacItemsSource, StacModelSource} from "./source.js";
