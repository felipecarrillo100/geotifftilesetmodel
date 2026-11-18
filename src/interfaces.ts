/**
 * What the pixel values of a GeoTIFF represent, as detected from its TIFF tags.
 */
export enum PixelMeaningEnum {
    Grayscale8 = "Grayscale8",
    Grayscale16 = "Grayscale16",
    Grayscale32 = "Grayscale32",
    RGB = "RGB",
    RGBA = "RGBA",
    RGB96 = "RGB96",
    Multiband = "Multiband",
    Unknown = "Unknown",
}

/**
 * A single color stop of a gradient.
 */
export interface GradientColorMapStep {
    /**
     * Position of the stop in the gradient, between 0.0 (start) and 1.0 (end).
     */
    level: number;

    /**
     * Color at this stop, as a CSS color string such as `"#ffffff"` or `"rgb(255,0,0)"`.
     */
    color: string;
}

/**
 * A gradient as an ordered list of color stops, from level 0.0 to level 1.0.
 */
export type CogGradientColorMap = GradientColorMapStep[];

/**
 * A gradient and the data range it is stretched over.
 */
export interface CogGradient {
    colorMap: CogGradientColorMap;
    /**
     * Data values mapped to level 0.0 (`min`) and level 1.0 (`max`).
     * When omitted the range of the data type is used, or for floating point data the
     * `STATISTICS_MINIMUM` / `STATISTICS_MAXIMUM` that GDAL stored in the file (0..1 when absent).
     */
    range?: {
        min: number;
        max: number;
    };
}

/**
 * Which bands of a multiband raster are shown, and how.
 */
export interface BandMapping {
    /** Zero-based index of the band shown as red (when `rgb` is true). Default 0. */
    red?: number;
    /** Zero-based index of the band shown as green (when `rgb` is true). Default 0. */
    green?: number;
    /** Zero-based index of the band shown as blue (when `rgb` is true). Default 0. */
    blue?: number;
    /** Zero-based index of the band colored with the gradient (when `rgb` is false). Default 0. */
    gray?: number;
    /**
     * `true` to combine `red`, `green` and `blue` into a color image, `false` to color the `gray` band with the
     * gradient. Default false.
     */
    rgb?: boolean;
    /**
     * @deprecated Alias of {@link rgb}, kept because earlier documentation used this name.
     */
    isRGB?: boolean;
}

/** {@link BandMapping} with every default applied. */
export interface ResolvedBandMapping {
    red: number;
    green: number;
    blue: number;
    gray: number;
    rgb: boolean;
}
