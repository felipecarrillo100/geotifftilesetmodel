import {ReadRasterResult} from "geotiff";
import {GrayScaleTransformation} from "./gradients";

export interface BandMapping {
    red: number,
    green: number,
    blue: number,
    gray: number,
    rgb: boolean;
}

interface ConvertBandsTo8BitRGBOptions {
    bits: number;
    bands: number;
    bandMapping: BandMapping;
    nodata: number;
    convert?: (x:number) => number;
    transformation?: (x: number) => [number, number, number],
}

/**
 * Conversion Multiband -> 3 bands conversion.
 */
export function convertBandsTo8BitRGB(raw: ReadRasterResult, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    let  divider = 1;
    switch (options.bits) {
        case 16:
            divider = 255;
            break;
        case 32:
            divider = 255*255*255;
            break;
    }
    return convertStandardizedBandsTo8BitRGB(raw as any,  { ...options, convert:(x: number) => x/(divider)});
}

function convertStandardizedBandsTo8BitRGB( raw: Uint8Array | Uint16Array | Uint32Array, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    const oldRaw = raw;
    const bandsOut = typeof options.nodata === "undefined" ?  3 : 4;
    const maxIndex = oldRaw.length / options.bands;
    const newRaw =  new Uint8Array(maxIndex * bandsOut);
    // Create an array multibands and the type depends on the number of bits. Multibands is a reusable array
    const typeMap = { 8: Uint8Array, 16: Uint16Array, 32: Uint32Array };
    const ArrayType = typeMap[options.bits];
    const multibands = ArrayType ? new ArrayType(options.bands) : undefined;

    for (let index = 0; index < maxIndex; index++) {
        // Get all the bands
        const baseIndex = index * options.bands;
        for (let j = 0; j < options.bands; ++j) {
            multibands[j] = oldRaw[baseIndex + j]; // Standardize Gradient from 0 to 1
        }
        // Create a RGB color per pixel
        const rgba = bandMapping(multibands, options);
        // Assign the RGB to newRaw
        const outputBaseIndex = bandsOut * index;
        for (let j = 0; j < bandsOut; j++) {
            newRaw[outputBaseIndex + j] = rgba[j];
        }
    }
    return newRaw;
}

function bandMapping(multibands, options: ConvertBandsTo8BitRGBOptions) {
    const {bandMapping, nodata} = options;
    const rawData = multibands;
    const onUndefinedConvert = (v: number)=> typeof v !== "undefined" ? options.convert(v) : 0;
    if (options.bandMapping.rgb) {
        const { red, green, blue } = bandMapping;

        const redValue = rawData[red];
        const greenValue = rawData[green];
        const blueValue = rawData[blue];

        const zeroCount = [redValue, greenValue, blueValue].filter(value => value === nodata).length;
        const alpha = 255 * (1 - (zeroCount / 3)); // 0 if all are zero, 1 if none are zero

        return [
            onUndefinedConvert(redValue),
            onUndefinedConvert(greenValue),
            onUndefinedConvert(blueValue),
            alpha
        ];
    } else {
        const gray = rawData[bandMapping.gray];
        const alpha = gray === nodata ? 0 : 255;
        const rgbTransformation = options.transformation ? options.transformation : GrayScaleTransformation;
        const x = onUndefinedConvert(gray)/255;
        const rgb = rgbTransformation(x);
        return [rgb[0],rgb[1],rgb[2],alpha];
    }
}
