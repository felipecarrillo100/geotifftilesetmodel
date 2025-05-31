import {ColorMap, createGradientColorMap} from "@luciad/ria/util/ColorMap";

export const GrayscaleGradient = createGradientColorMap([
    { "level": 0, "color": "#000000" },  // Black
    { "level": 0.0667, "color": "#111111" },
    { "level": 0.1333, "color": "#222222" },
    { "level": 0.2, "color": "#333333" },
    { "level": 0.2667, "color": "#444444" },
    { "level": 0.3333, "color": "#555555" },
    { "level": 0.4, "color": "#666666" },
    { "level": 0.4667, "color": "#777777" },
    { "level": 0.5333, "color": "#888888" },
    { "level": 0.6, "color": "#999999" },
    { "level": 0.6667, "color": "#AAAAAA" },
    { "level": 0.7333, "color": "#BBBBBB" },
    { "level": 0.8, "color": "#CCCCCC" },
    { "level": 0.8667, "color": "#DDDDDD" },
    { "level": 0.9333, "color": "#EEEEEE" },
    { "level": 1, "color": "#FFFFFF" }   // White
]);


export function TransformToGradientColorMap(colorMap:ColorMap, range?: {min: number, max: number}) {
    const adaptRange = range ?
        (x: number) => {
            const normalizedValue = (x - range.min) / (range.max - range.min);
            return normalizedValue < 0 ? 0 : (normalizedValue>1 ? 0.999 : normalizedValue);
        } : (x:number)=>x;
    return function(n: number): [number, number, number] {
        const x = adaptRange(n);
        const colorString = colorMap.retrieveColor(x);
        const colorsAsString = colorString.replace(/[^\d,.]/g, '').split(',');
        const rgba = colorsAsString.map(value => Number(value));
        return [rgba[0], rgba[1], rgba[2]];
    };
}

export const GrayScaleTransformation = TransformToGradientColorMap(GrayscaleGradient);
