/**
 * What the pixel values of a GeoTIFF represent, as detected from its TIFF tags. Reported as
 * {@link GeoTiffTileSetModelInfo.pixelMeaning}.
 *
 * @category Model
 */
export enum PixelMeaningEnum {
    /** One band of 8 bits per pixel. */
    Grayscale8 = "Grayscale8",
    /** One band of 16 bits per pixel. */
    Grayscale16 = "Grayscale16",
    /** One band of 32 bits per pixel (integer or floating point). */
    Grayscale32 = "Grayscale32",
    /** 8-bit RGB, also YCbCr, CIELab or CMYK data that is converted to RGB when read. */
    RGB = "RGB",
    /** 8-bit RGB with an alpha band. */
    RGBA = "RGBA",
    /** RGB with 32 bits per band. */
    RGB96 = "RGB96",
    /** More than one band that is none of the layouts above. */
    Multiband = "Multiband",
    /** A single-band layout not listed above (for example 1-bit or 64-bit data). */
    Unknown = "Unknown",
}
