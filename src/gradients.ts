import {ColorMap, createGradientColorMap} from "@luciad/ria/util/ColorMap";

export const WorldElevationColorMap = createGradientColorMap([
    { level: 0, color: "#0e1122" },
    { level: 0.6667, color: "#5ba2d8" },
    { level: 0.7081, color: "#7ebff0" },
    { level: 0.7143, color: "#bfeafe" },
    { level: 0.7143, color: "#9bd090" },
    { level: 0.7190, color: "#84bf78" },
    { level: 0.7238, color: "#9dc67b" },
    { level: 0.7286, color: "#b7cc82" },
    { level: 0.7333, color: "#ced796" },
    { level: 0.7381, color: "#e0e49e" },
    { level: 0.7429, color: "#efe9a8" },
    { level: 0.7476, color: "#e8de9f" },
    { level: 0.7524, color: "#ded38d" },
    { level: 0.7571, color: "#d3c688" },
    { level: 0.7667, color: "#cab46e" },
    { level: 0.7762, color: "#c3a158" },
    { level: 0.7857, color: "#b99247" },
    { level: 0.8095, color: "#aa8042" },
    { level: 0.8333, color: "#ac946b" },
    { level: 0.8571, color: "#baa787" },
    { level: 0.8810, color: "#c9c89c" },
    { level: 0.9048, color: "#d8cab1" },
    { level: 0.9286, color: "#e6dbc5" },
    { level: 0.9524, color: "#f5ecda" },
    { level: 0.9762, color: "#faf1df" },
    { level: 1, color: "#fafafa" }
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


export function TransformToGradientColorMap(colorMap:ColorMap) {
    return function(x: number): [number, number, number] {
        const colorString = colorMap.retrieveColor(x);
        const colorsAsString = colorString.replace(/[^\d,.]/g, '').split(',');
        const rgba = colorsAsString.map(value => Number(value));
        return [rgba[0], rgba[1], rgba[2]];
    };
}

export const GrayScaleTransformation = TransformToGradientColorMap(GrayscaleGradient);
