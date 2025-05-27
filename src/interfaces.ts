export enum PhotometricInterpretation {
    WhiteIsZero = 0,
    BlackIsZero = 1,
    RGB = 2,
    PaletteColor = 3,
    TransparencyMask = 4,
    CMYK = 5,
    YCbCr = 6,
    CIELab = 8,
    ICCLab = 9,
    ITULab = 10,
    ColorFilterArray = 32803,
    PixarLogL = 32844,
    PixarLogLuv = 32845,
    LinearRaw = 34892,
    Depth = 51177,
    DepthAndConfidence = 51178,
}

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
