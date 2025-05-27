import {createGradientColorMap} from "@luciad/ria/util/ColorMap";

export const WorldElevationColorMap = createGradientColorMap([
    {level: -15000, color: "#0e1122"},
    {level: -1000, color: "#5ba2d8"},
    {level: -100, color: "#7ebff0"},
    {level: 0, color: "#bfeafe"},
    {level: 0.1, color: "#9bd090"},
    {level: 100, color: "#84bf78"},
    {level: 200, color: "#9dc67b"},
    {level: 300, color: "#b7cc82"},
    {level: 400, color: "#ced796"},
    {level: 500, color: "#e0e49e"},
    {level: 600, color: "#efe9a8"},
    {level: 700, color: "#e8de9f"},
    {level: 800, color: "#ded38d"},
    {level: 900, color: "#d3c688"},
    {level: 1100, color: "#cab46e"},
    {level: 1300, color: "#c3a158"},
    {level: 1500, color: "#b99247"},
    {level: 2000, color: "#aa8042"},
    {level: 2500, color: "#ac946b"},
    {level: 3000, color: "#baa787"},
    {level: 3500, color: "#c9c89c"},
    {level: 4000, color: "#d8cab1"},
    {level: 4500, color: "#e6dbc5"},
    {level: 5000, color: "#f5ecda"},
    {level: 5500, color: "#faf1df"},
    {level: 6000, color: "#fafafa"},
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

export const AdjustedGrayscaleGradientLight = createGradientColorMap([
    { "level": 0, "color": "#333333" },   // Dark Gray instead of Black
    { "level": 0.0667, "color": "#444444" },
    { "level": 0.1333, "color": "#555555" },
    { "level": 0.2, "color": "#666666" },
    { "level": 0.2667, "color": "#777777" },
    { "level": 0.3333, "color": "#888888" },
    { "level": 0.4, "color": "#999999" },
    { "level": 0.4667, "color": "#AAAAAA" },
    { "level": 0.5333, "color": "#BBBBBB" },
    { "level": 0.6, "color": "#CCCCCC" },
    { "level": 0.6667, "color": "#DDDDDD" },
    { "level": 0.7333, "color": "#EEEEEE" },
    { "level": 0.8, "color": "#FFFFFF" }, // White
    { "level": 0.8667, "color": "#FFFFFF" },
    { "level": 0.9333, "color": "#FFFFFF" },
    { "level": 1, "color": "#FFFFFF" }
]);

export function RainbowTransformation (x: number): [number, number, number] {
    const colorString = Rainbow.retrieveColor(x);
    const colorsAsString = colorString.replace(/[^\d,.]/g, '').split(',');
    const rgba = colorsAsString.map(x => Number(x));
    return [rgba[0], rgba[1], rgba[2]];
}

export function GrayScaleTransformation (x: number): [number, number, number] {
    const colorString = AdjustedGrayscaleGradientLight.retrieveColor(x);
    const colorsAsString = colorString.replace(/[^\d,.]/g, '').split(',');
    const rgba = colorsAsString.map(x => Number(x));
    return [rgba[0], rgba[1], rgba[2]];
}
