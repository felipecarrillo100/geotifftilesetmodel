/**
 * The default style of imagery models.
 */
import type {BandStyle} from "../rs/style.js";

/**
 * A sensible first style for a set of band names: true colour when bands named `red`, `green` and `blue` exist,
 * else the first three bands as RGB (in band order), else (one or two bands) the first band in grey; stretched
 * 2–98 % (percentile clip, which needs statistics). The true colour style also uses gamma 1.2. The default `style`
 * of {@link GeoTiffTileSetModel.create}, except for a single-band palette file (its colour table) and STAC time
 * series (true colour of the last period).
 *
 * Bands named `b1`, `b2`, `b3` are shown as red, green and blue, which is right for most RGB files but not for
 * files that store blue first: name the bands, or give a style.
 *
 * @param bandNames the band names of the model, in order
 * @returns the style
 *
 * @example
 * ```ts
 * autoStyle(["red", "green", "blue", "nir"]);   // true colour, 2–98 % stretch, gamma 1.2
 * autoStyle(["elevation"]);                      // the band in grey
 * ```
 *
 * @category Sources
 */
export function autoStyle(bandNames: string[]): BandStyle {
    const stretch = {type: "percentile" as const, low: 2, high: 98};
    if (["red", "green", "blue"].every((b) => bandNames.includes(b))) {
        return {render: {type: "rgb", red: "red", green: "green", blue: "blue", stretch, gamma: 1.2}};
    }
    if (bandNames.length >= 3) return {render: {type: "rgb", red: bandNames[0], green: bandNames[1], blue: bandNames[2], stretch}};
    return {render: {type: "pseudocolor", band: bandNames[0], stretch}};
}
