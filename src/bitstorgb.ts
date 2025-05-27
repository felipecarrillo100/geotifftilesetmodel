import {GrayScaleTransformation} from "./gradients";

/**
 * Takes care of the bit conversion but also 1 -> 3 bands conversion.
 */
export function convert32To8BitRGB(raw: Uint16Array,
                                   samplesPerPixel?: number,
                                   transformation?: (x: number) => [number, number, number]): Uint8Array {
    return convertTo8BitRGB(raw, (x: number) => x/(255*255*255*255), samplesPerPixel, transformation);
}


/**
 * Takes care of the bit conversion but also 1 -> 3 bands conversion.
 */
export function convert16To8BitRGB(raw: Uint16Array,
                            samplesPerPixel?: number,
                            transformation?: (x: number) => [number, number, number]): Uint8Array {
    return convertTo8BitRGB(raw, (x: number) => x/(255*255), samplesPerPixel, transformation);
}

/**
 * Takes care of 1 -> 3 bands conversion.
 */
export function convert8To8BitRGB(raw: Uint8Array,
                           samplesPerPixel?: number,
                           transformation?: (x: number) => [number, number, number]): Uint8Array {
    return convertTo8BitRGB(raw, (x: number) => x/255, samplesPerPixel, transformation);
}

export function convertTo8BitRGB(raw: Uint8Array | Uint16Array | Uint32Array, convert: (x:number) => number, samplesPerPixel?: number,
                          transformation?: (x: number) => [number, number, number]): Uint8Array {
    const oldRaw = raw;
    const newRaw = new Uint8Array(oldRaw.length*3);
    for (let index = 0; index < oldRaw.length; index++) {
        const normalizedValue = convert(oldRaw[index]); // Standardize Gradient from 0 to 1
        const rgb = transformation ? transformation(normalizedValue) : GrayScaleTransformation(normalizedValue);
        for (let j = 0; j < 3; j++) {
            newRaw[3 * index + j] = rgb[j];
        }
    }
    return newRaw;
}


/**
 * Converts 32 bit values to 8 bit values.
 * Also takes care of converting 1 band to 3 bands, if necessary.
 * Also takes the nodata value into account to correctly handle NaNs.
 */
export function convert32FloatTo8BitRGB(raw: Float32Array, samplesPerPixel: number, nodata: number | null,
                                        transformation?: (x: number) => [number, number, number]): Uint8Array {
    const oldRaw = raw;
    const nodataPresent = isNumber(nodata);

    const getByteValue = (rawValue: number): {value: number, equalsNodata: boolean} => {
        const equalsNodata = nodataPresent && equals(rawValue, nodata);
        const value = equalsNodata ? 0 : rawValue;
        return {value: Math.round(value * 255), equalsNodata}; // Assume floats in [0, 1];
    };

    if (samplesPerPixel === 1) {
        const newNumberOfChannels = nodataPresent ? 4 : 3;
        const newRaw = new Uint8Array(newNumberOfChannels * oldRaw.length);
        for (let index = 0; index < oldRaw.length; index++) {
            const {value, equalsNodata} = getByteValue(oldRaw[index]);
            if (transformation && !equalsNodata) {
                const color = transformation(oldRaw[index]);
                newRaw[index * newNumberOfChannels] = color[0];
                newRaw[index * newNumberOfChannels + 1] = color[1];
                newRaw[index * newNumberOfChannels + 2] = color[2];
            } else {
                newRaw[index * newNumberOfChannels] = value;
                newRaw[index * newNumberOfChannels + 1] = value;
                newRaw[index * newNumberOfChannels + 2] = value;
            }
            if (nodataPresent) {
                newRaw[index * newNumberOfChannels + 3] = equalsNodata ? 0 : 255;
            }
        }
        return newRaw;
    } else {
        const getByteValues = (x: number, y: number, z: number): {values: number[], anyEqualsNodata: boolean} => {
            const {value: byteValue1, equalsNodata: equalsNodata1} =  getByteValue(x);
            const {value: byteValue2, equalsNodata: equalsNodata2} =  getByteValue(y);
            const {value: byteValue3, equalsNodata: equalsNodata3} =  getByteValue(z);
            const anyEqualsNodata = equalsNodata1 || equalsNodata2 || equalsNodata3;
            return {values: anyEqualsNodata ? [0, 0, 0] : [byteValue1, byteValue2, byteValue3], anyEqualsNodata};
        };

        const newNumberOfChannels = samplesPerPixel === 3 && nodataPresent ? 4 : samplesPerPixel;
        const newRaw = new Uint8Array(raw.length * newNumberOfChannels / samplesPerPixel);
        for (let index = 0; index < raw.length / samplesPerPixel; index++) {
            const {values, anyEqualsNodata} =  getByteValues(oldRaw[index * samplesPerPixel],
                oldRaw[index * samplesPerPixel + 1],
                oldRaw[index * samplesPerPixel + 2]);
            newRaw.set(values, index * newNumberOfChannels);
            if (samplesPerPixel === 3 && nodataPresent) {
                newRaw[index * newNumberOfChannels + 3] = anyEqualsNodata ? 0 : 255;
            } else if (samplesPerPixel === 4) {
                const {value, equalsNodata} = getByteValue(oldRaw[index * samplesPerPixel + 3]);
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

