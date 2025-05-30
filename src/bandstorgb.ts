import {ReadRasterResult} from "geotiff";

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
}

/**
 * Conversion Multiband -> 3 bands conversion.
 */
export function convertBandsTo8BitRGB(raw: ReadRasterResult, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    let  divider = 255;
    switch (options.bits) {
        case 16:
            divider = 255*255;
            break;
        case 32:
            divider = 255*255*255*255;
            break;
    }
    return convertStandardizedBandsTo8BitRGB(raw as any,  { ...options, convert:(x: number) => x/(divider)});
}

function convertStandardizedBandsTo8BitRGB( raw: Uint8Array | Uint16Array | Uint32Array, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    const oldRaw = raw;
    const bandsOut = typeof options.nodata === "undefined" ?  3 : 4;
    const newRaw =  new Uint8Array(oldRaw.length * bandsOut);
    //
    for (let index = 0; index < oldRaw.length; index++) {
        const multibands = oldRaw[index]; // Standardize Gradient from 0 to 1
        const rgba = bandMapping(multibands, options);
        for (let j = 0; j < bandsOut; j++) {
            newRaw[bandsOut * index + j] = rgba[j];
        }
    }
    return newRaw;
}

function bandMapping(multibands, options: ConvertBandsTo8BitRGBOptions) {
    const {bandMapping, nodata} = options;
    const rawData = multibands;
    const onUndefined = (v: number)=> typeof v !== "undefined" ? v : 0;
    const alpha = (rawData === nodata) ? 0 : 1
    const red = rawData[bandMapping.red];
    const green = rawData[bandMapping.green];
    const blue = rawData[bandMapping.blue];
    const rgba = [onUndefined(red), onUndefined(green),onUndefined(blue), alpha];
    return [rgba[0], rgba[1], rgba[2], rgba[3]];
}
