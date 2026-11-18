/**
 * ria-geotiff: Cloud Optimized GeoTIFF support for LuciadRIA.
 *
 * LuciadRIA is a peer dependency: this package only imports it, the application provides it.
 *
 * @packageDocumentation
 * @module ria-geotiff
 */
export {GeoTiffTileSetModel} from "./GeoTiffTileSetModel.js";
export type {
    BandInfo, BandInput, BandLocation, CreateModelOptions, ElevationOptions, ModelPerformance, ModelSource, Resampling,
    ResolvedInput, GeoTiffTileSetModelInfo, GetInfoGeotiffFromUrlOptions,
} from "./GeoTiffTileSetModel.js";
export type {StacModelSource, StacItemsSource, StacCatalogSource, StacItemOptions} from "./stac/source.js";
export {GeoTiffModelError, GeoTiffReadError, RiaGeoTiffError} from "./errors.js";
export type {GeoTiffModelErrorCause, GeoTiffReadErrorListener, GeoTiffReadRecovery, RiaGeoTiffProblem} from "./errors.js";
export {PixelMeaningEnum} from "./interfaces.js";
export type {HttpAccessOptions} from "./fileutils.js";
export type {AccessHook, AccessKind, RiaGeoTiffRequest, RiaGeoTiffRequestListener} from "./http.js";
export {DEFAULT_ELEVATION_TILE_SIZE} from "./elevation.js";

// Styles and band math. Ready-made ramps and styles are separate, optional entry points: `ria-geotiff/ramps` and
// `ria-geotiff/presets`; STAC capabilities, selection and asset helpers are in `ria-geotiff/stac`.
export type {BandStyle, ChannelSpec, CustomRender, MaskRule, PseudocolorRender, RenderSpec, RgbRender} from "./rs/style.js";
export {StyleError, DEFAULT_STRETCH} from "./rs/style.js";
export {compileStyle, legendOf} from "./rs/render.js";
export type {ColorFunction, CompiledStyle, Legend} from "./rs/render.js";
export {computeStatistics, percentile, resolveStretch} from "./rs/stats.js";
export type {BandStatistics, ResolvedStretch, StretchSpec} from "./rs/stats.js";
export {
    buildRampLut, ColorMapError, cssGradient, formatColor, GREY_RAMP, isColorTable, LUT_SIZE, parseColor, rampFromColors,
    rampFromValues, resolveColorTable, resolveRamp, reverseRamp, sampleRamp,
} from "./rs/colormaps.js";
export type {ColorMapSpec, ColorTableJSON, RampJSON, RampStop, ResolvedRamp, Rgba} from "./rs/colormaps.js";
export {compileExpression, ExpressionError, expressionBands, formatExpression, parseExpression, toExpressionNode} from "./rs/expression.js";
export type {CompiledExpression, ExpressionArray, ExpressionNode} from "./rs/expression.js";

// What a URL or file is (one box for any source).
export {identifySource, IDENTIFY_MAX_JSON_BYTES, IDENTIFY_PROBE_BYTES} from "./sources/identify.js";
export type {
    IdentifiedBase, IdentifiedGeoTiff, IdentifiedManifest, IdentifiedSource, IdentifiedStacApi, IdentifiedStacCatalog,
    IdentifiedStacCollection, IdentifiedStacItem, IdentifiedStacItemCollection, IdentifiedUnknown, IdentifySourceOptions, SourceKind,
} from "./sources/identify.js";
export {probeCog} from "./sources/cog.js";
export type {CogProbe, ProbeCogOptions} from "./sources/cog.js";

// The default style, and manifests (the create options as a JSON file).
export {autoStyle} from "./sources/autoStyle.js";
export {MANIFEST_TYPE, ManifestError, readManifest, toManifest, validateManifest} from "./sources/manifest.js";
export type {StackManifest, ManifestInput, ManifestStacSource} from "./sources/manifest.js";
