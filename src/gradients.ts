import {ColorMap, createGradientColorMap} from "@luciad/ria/util/ColorMap";

export const WorldElevationColorMap= createGradientColorMap([
    { level: 0.0, color: "#006a6a" },// Deep ocean (-400 m)
    { level: 0.2, color: "#009999" },// Deep ocean (-400 m)
    { level: 0.37, color: "#94D4D4" }, // Shallow water (400 m)
    { level: 0.402, color: "#567C41" }, // Coastal lowlands (1200 m)
    { level: 0.45, color: "#77A85A" }, // Lowlands (2700 m)
    { level: 0.65, color: "#f2d671" }, // Highlands (4000 m)
    { level: 0.78, color: "#ff8000" }, // Mountains (5300 m)
    { level: 0.88, color: "#a6421c" }, // Very high mountains (6600 m)
    { level: 0.96, color: "#9f9f9f" }, // Very high mountains (6600 m)
    { level: 1.0, color: "#ffffff" }   // Extreme elevations (8000 m)

]);

export const Rainbow = createGradientColorMap([
    { "level": 0, "color": "#ff0000" },
    { "level": 0.0667, "color": "#ff9c00" },
    { "level": 0.1333, "color": "#fff700" },
    { "level": 0.2, "color": "#9cff00" },
    { "level": 0.2667, "color": "#00ff24" },
    { "level": 0.3333, "color": "#00ffb4" },
    { "level": 0.4, "color": "#00f0ff" },
    { "level": 0.4667, "color": "#009eff" },
    { "level": 0.5333, "color": "#0048ff" },
    { "level": 0.6, "color": "#4400ff" },
    { "level": 0.6667, "color": "#ae00ff" },
    { "level": 0.7333, "color": "#ff00d7" },
    { "level": 0.8, "color": "#ff008c" },
    { "level": 0.8667, "color": "#ff0049" },
    { "level": 0.9333, "color": "#ff001d" },
    { "level": 1, "color": "#ff0000" }
]);

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
