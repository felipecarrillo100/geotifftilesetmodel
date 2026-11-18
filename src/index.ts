/**
 * ria-geotiff: Cloud Optimized GeoTIFF support for LuciadRIA.
 *
 * LuciadRIA is a peer dependency: this package only imports it, the application provides it.
 */
export {GeoTiffTileSetModel} from "./GeoTiffTileSetModel.js";
export type {
    CreateGeotiffFromUrlOptions,
    GeoTiffElevationOptions,
    GeoTiffTileSetModelInfo,
    GetInfoGeotiffFromUrlOptions,
} from "./GeoTiffTileSetModel.js";
export {GeoTiffModelError, GeoTiffReadError} from "./errors.js";
export type {GeoTiffModelErrorCause, GeoTiffReadErrorListener, GeoTiffReadRecovery} from "./errors.js";
export {PixelMeaningEnum} from "./interfaces.js";
export type {BandMapping, CogGradient, CogGradientColorMap, GradientColorMapStep, ResolvedBandMapping} from "./interfaces.js";
export type {HttpAccessOptions} from "./fileutils.js";
export {GrayscaleGradient} from "./gradients.js";
export {DEFAULT_ELEVATION_TILE_SIZE} from "./elevation.js";
