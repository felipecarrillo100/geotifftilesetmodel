/**
 * LuciadRIA autodetected possible Value of the pixel
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
 * Defines a single color stop in the colormap.
 */
export interface GradientColorMapStep {
    /**
     * A normalized value representing the position of the color stop within the gradient.
     * Should be a float between 0.0 and 1.0, where 0.0 is the start and 1.0 is the end of the gradient.
     */
    level: number;

    /**
     * The color associated with this stop in the gradient, represented as a hex color string.
     * For example, "#ffffff" for white.
     */
    color: string;
}

/**
 * Represents the entire colormap as an array of color stops.
 * Each color stop is defined by the `GradientColorMapStep` interface.
 */
export type CogGradientColorMap = GradientColorMapStep[];

export interface CogGradient {
    colorMap: CogGradientColorMap;
    range?: {
        min: number;
        max: number;
    }
}
