import {GrayScaleTransformation} from "./gradients";
import {ReadRasterResult} from "geotiff";

/**
 * Downscale a Uint16Array (16-bit samples) to Uint8Array (8-bit samples).
 * @param input - The 16-bit input data (e.g., grayscale or interleaved RGB).
 * @returns A Uint8Array with 8-bit samples.
 */
export function downscale16to8bits(input: Uint16Array): Uint8Array {
    const output = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] >> 8; // Convert from 0–65535 to 0–255
    }
    return output;
}


interface ConvertTo8BitRGBOptions {
    bits: number;
    convert?: (x:number) => number,
    samplesPerPixel?: number,
    transformation?: (x: number) => [number, number, number],
    nodata?: number
}


/**
 * Conversion but also Grayscale8 -> 3 bands conversion.
 */
export function convertSingleBandTo8BitRGB(raw: ReadRasterResult, options: ConvertTo8BitRGBOptions): Uint8Array {
    let  divider = 1;
    switch (options.bits) {
        case 16:
            divider = 256;  // 2^8
            break;
        case 32:
            divider = 16777216;   // 2^24
            break;
    }
    return convertTo8BitRGB(raw as Uint8Array | Uint16Array | Uint32Array, { ...options, convert:(x: number) => x/divider});
}

/**
 * Conversion but also Grayscale8 -> 3 bands conversion, it will return 4 bands if nodata.
 */
export function convertTo8BitRGB( oldRaw: Uint8Array | Uint16Array | Uint32Array, options: ConvertTo8BitRGBOptions): Uint8Array {
    const bands = typeof options.nodata === "undefined" ?  3 : 4;
    const newRaw =  new Uint8Array(oldRaw.length * bands);
    //
    for (let index = 0; index < oldRaw.length; index++) {
        const normalizedValue = options.convert(oldRaw[index]) / 255; // Standardize Gradient from 0 to 1
        const rgb = options.transformation ? options.transformation(normalizedValue) : GrayScaleTransformation(normalizedValue);
        for (let j = 0; j < bands; j++) {
            if (j<3) {
                newRaw[bands * index + j] = rgb[j];
            }  else {
                newRaw[bands * index + j] =  (oldRaw[index] === options.nodata) ? 0 : 255;
            }
        }
    }
    return newRaw;
}


/**
 * Converts 32 bit values to 8 bit values.
 * Also takes care of converting 1 band to 3 bands, if necessary.
 * Also takes the nodata value into account to correctly handle NaNs.
 */
export function convert32FloatTo8BitRGB(
    raw: Float32Array,
    samplesPerPixel: number,
    nodata: number | null,
    transformation?: (x: number) => [number, number, number]
): Uint8Array {
    const nodataPresent = nodata !== null;

    const getByteValue = (rawValue: number): { value: number; equalsNodata: boolean } => {
        const equalsNodata = nodataPresent && equals(rawValue, nodata);
        const value = equalsNodata ? 0 : Math.round(rawValue * 255);
        return { value, equalsNodata }; // Assume floats in [0, 1];
    };

    if (samplesPerPixel === 1) {
        const newNumberOfChannels = nodataPresent ? 4 : 3;
        const newRaw = new Uint8Array(newNumberOfChannels * raw.length);

        for (let index = 0; index < raw.length; index++) {
            const { value, equalsNodata } = getByteValue(raw[index]);
            let r = value, g = value, b = value;

            if (transformation && !equalsNodata) {
                [r, g, b] = transformation(raw[index]);
            }

            newRaw[index * newNumberOfChannels] = r;
            newRaw[index * newNumberOfChannels + 1] = g;
            newRaw[index * newNumberOfChannels + 2] = b;

            if (nodataPresent) {
                newRaw[index * newNumberOfChannels + 3] = equalsNodata ? 0 : 255;
            }
        }

        return newRaw;
    } else {
        const getByteValues = (x: number, y: number, z: number): { values: number[]; anyEqualsNodata: boolean } => {
            const { value: byteValue1, equalsNodata: equalsNodata1 } = getByteValue(x);
            const { value: byteValue2, equalsNodata: equalsNodata2 } = getByteValue(y);
            const { value: byteValue3, equalsNodata: equalsNodata3 } = getByteValue(z);
            const anyEqualsNodata = equalsNodata1 || equalsNodata2 || equalsNodata3;
            return { values: anyEqualsNodata ? [0, 0, 0] : [byteValue1, byteValue2, byteValue3], anyEqualsNodata };
        };

        const newNumberOfChannels = samplesPerPixel === 3 && nodataPresent ? 4 : samplesPerPixel;
        const newRaw = new Uint8Array(raw.length * newNumberOfChannels / samplesPerPixel);

        for (let index = 0; index < raw.length / samplesPerPixel; index++) {
            const { values, anyEqualsNodata } = getByteValues(
                raw[index * samplesPerPixel],
                raw[index * samplesPerPixel + 1],
                raw[index * samplesPerPixel + 2]
            );

            newRaw.set(values, index * newNumberOfChannels);

            if (samplesPerPixel === 3 && nodataPresent) {
                newRaw[index * newNumberOfChannels + 3] = anyEqualsNodata ? 0 : 255;
            } else if (samplesPerPixel === 4) {
                const { value, equalsNodata } = getByteValue(raw[index * samplesPerPixel + 3]);
                newRaw[index * newNumberOfChannels + 3] = anyEqualsNodata || equalsNodata ? 0 : value;
            }
        }

        return newRaw;
    }
}

function equals(a: number, b: number): boolean {
    return a === b || (isNaN(a) && isNaN(b));
}


/**
 * Returns whether the given value is a number
 */
function isNumber(value: any, canBeNaN: boolean = true): value is number {
    return typeof value === "number" && (canBeNaN || !isNaN(value));
}

