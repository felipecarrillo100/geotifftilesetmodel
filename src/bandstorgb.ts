import {ReadRasterResult} from "geotiff";
import {GrayScaleTransformation} from "./gradients";

/**
 * Represents the mapping of color bands in a raster image.
 */
export interface BandMapping {
    /**
     * The zero-based index of the band used for the red channel.
     * This specifies which band in the raster data corresponds to the red color.
     */
    red: number;

    /**
     * The zero-based index of the band used for the green channel.
     * This specifies which band in the raster data corresponds to the green color.
     */
    green: number;

    /**
     * The zero-based index of the band used for the blue channel.
     * This specifies which band in the raster data corresponds to the blue color.
     */
    blue: number;

    /**
     * The zero-based index of the band used for the gray scale channel.
     * This specifies which band in the raster data corresponds to the gray scale representation.
     */
    gray: number;

    /**
     * Indicates whether the mapping is for an RGB image.
     * If `true`, the red, green, and blue properties are used to form an RGB image.
     * If `false`, the gray is a single band to be mapped to an RGB gradient.
     */
    rgb: boolean;
}

interface ConvertBandsTo8BitRGBOptions {
    bits: number;
    bands: number;
    bandMapping: BandMapping;
    nodata: number;
    convert?: (x:number) => number;
    transformation?: (x: number) => [number, number, number],
    nativeRange?: {
        min: number;
        max: number;
    }
}

/**
 * Converts multi-band raster data into an 8-bit RGB image.
 * This function supports mapping specific bands to RGB channels or normalizing values
 * based on the native range or bit depth of the input data.
 *
 * @param {ArrayBuffer | Uint8Array | Uint16Array | Uint32Array} raw - The input raster data to be converted.
 * @param {Object} options - Configuration options for the conversion.
 * @param {number} options.bits - The number of bits per sample in the input data (e.g., 8, 16, or 32).
 * @param {number} options.bands - The number of bands in the input raster data.
 * @param {Object} options.bandMapping - An object defining the mapping of bands to RGB channels.
 * @param {boolean} options.bandMapping.rgb - If `true`, indicates that the input raster has bands to be mapped as RGB bands.
 * @param {number} options.nodata - A value representing "no data" in the input raster.
 * @param {Function} [options.convert] - A function to normalize input values to the range [0, 1].
 * @param {Function} [options.transformation] - A function to transform normalized values to RGB.
 * @param {Object} [options.nativeRange] - The native range of the raster data.
 * @param {number} options.nativeRange.min - The minimum value of the native range.
 * @param {number} options.nativeRange.max - The maximum value of the native range.
 * @returns {Uint8Array} - The resulting 8-bit RGB image data, where each pixel is represented by three consecutive values (Red, Green, and Blue).
 *
 * @example
 * const rawRasterData = new Uint16Array([0, 32768, 65535, 0, 32768, 65535, 0, 32768, 65535]); // Example multi-band raster data
 * const options = {
 *     bits: 16,
 *     bands: 3,
 *     bandMapping: { rgb: false },
 *     nativeRange: {
 *         min: 0,
 *         max: 65535
 *     }
 * };
 * const rgbData = convertBandsTo8BitRGB(rawRasterData, options);
 * console.log(rgbData);
 * // Output: Uint8Array([...]) - Normalized and converted RGB data
 */
export function convertBandsTo8BitRGB(raw: ReadRasterResult, options: ConvertBandsTo8BitRGBOptions): Uint8Array {
    const range = options.nativeRange;
    let  divider = 1;
    switch (options.bits) {
        case 16:
            divider = 256;  // 2^8
            break;
        case 32:
            divider = 16777216;  // 2^24
            break;
    }
    let convert = (x: number) => x/(divider)
    if (!options.bandMapping.rgb) {
        convert = (x: number) => (x - range.min) / (range.max - range.min);
    }
    return convertStandardizedBandsTo8BitRGB(raw as any,  { ...options, convert});
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

        const alpha = (redValue !== nodata || greenValue !== nodata || blueValue !== nodata) ? 255 : 0;

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
        const x = onUndefinedConvert(gray);
        const rgb = rgbTransformation(x);
        return [rgb[0],rgb[1],rgb[2],alpha];
    }
}

interface CreateArrowOptions {
    tileWidth: number;
    tileHeight: number;
    bits: number;
    bands: number;
    bandMapping: BandMapping; // The band containing the value to be used as wind
    nodata: number;
    convert?: (x:number) => number;
    transformation?: (x: number) => [number, number, number],
    nativeRange?: {
        min: number;
        max: number;
    }
}

export function createArrow(raw: ReadRasterResult, options: CreateArrowOptions) {
    const {
        tileWidth,
        tileHeight,
        bands,
        bandMapping,
        nodata,
        convert,
        transformation,
        nativeRange,
    } = options;

    // Define the grid size for the matrix of arrows
    const gridSize = 15; // 10x10 arrows
    const arrowSpacingX = tileWidth / gridSize; // Horizontal spacing between arrows
    const arrowSpacingY = tileHeight / gridSize; // Vertical spacing between arrows

    // Create a canvas to draw the arrows
    const canvas = document.createElement('canvas');
    canvas.width = tileWidth;
    canvas.height = tileHeight;
    const ctx = canvas.getContext('2d')!;

    // Clear the canvas for a transparent background
    ctx.clearRect(0, 0, tileWidth, tileHeight);

    // Loop through the grid positions
    for (let row = 0; row < gridSize; row++) {
        for (let col = 0; col < gridSize; col++) {
            // Calculate the position of the current arrow
            const posX = Math.floor(col * arrowSpacingX + arrowSpacingX / 2);
            const posY = Math.floor(row * arrowSpacingY + arrowSpacingY / 2);

            // Convert the 2D grid position to a 1D pixel index
            const pixelIndex = posY * tileWidth + posX;

            // Calculate the index for the target band in interleaved data
            const centerIndexU = pixelIndex * bands + bandMapping.gray;
            const centerIndexV = pixelIndex * bands + (bandMapping.gray + 1);

            // Get the wind direction value from the target band
            let U = raw[centerIndexU] as number;
            let V = raw[centerIndexV] as number;

        // Calculate magnitude
            const magnitude = Math.sqrt(U*U + V*V);

        //# Calculate orientation in degrees
            let windDirection = Math.atan2(V, U) * (180 / Math.PI);

            // Handle nodata values
            if (windDirection === nodata) {
                continue; // Skip this arrow if the value is nodata
            }

            // Apply conversion function if provided
            if (!options.bandMapping.rgb) {
                // const convertX = (x: number) => (x - nativeRange.min) / (nativeRange.max - nativeRange.min);
                // windDirection = convertX(windDirection);
            }


            // Normalize the value to a range if nativeRange is provided
            // if (nativeRange) {
            //     const { min, max } = nativeRange;
            //     windDirection = (windDirection - min) / (max - min); // Normalize to 0-1
            //     windDirection = windDirection * 360; // Scale to 0-360 degrees
            // }
            windDirection = V - 180;

            // Debugging: Log the wind direction value
            console.log(`Wind direction at position (${posX}, ${posY}):`, windDirection);

            // Draw the arrow at the current position
            const arrowLength = Math.min(arrowSpacingX, arrowSpacingY) / 2.5; // Arrow size relative to spacing
            const angle = (windDirection * Math.PI) / 180; // Convert degrees to radians

            ctx.save();
            ctx.translate(posX, posY);
            ctx.rotate(angle);

            // Draw the arrow (white with black border)
            ctx.beginPath();
            ctx.moveTo(0, -arrowLength); // Start of the arrow (tip)
            ctx.lineTo(-arrowLength / 4, arrowLength / 4); // Left wing
            ctx.lineTo(arrowLength / 4, arrowLength / 4); // Right wing
            ctx.closePath();
            ctx.fillStyle = 'white'; // White arrow
            ctx.strokeStyle = 'black'; // Black border
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    // Extract pixel data from the canvas
    const imageData = ctx.getImageData(0, 0, tileWidth, tileHeight);
    const data = new Uint8Array(imageData.data.buffer);

    return data; // Return the RGBA data for the arrows
}
