import type {GeoTIFF, GeoTIFFImage} from "geotiff";

/**
 * Access to TIFF tags and GeoKeys. All reads of geotiff.js internals go through here.
 *
 * Works with geotiff.js 2.x (plain `fileDirectory` object, `geoKeys` property) and 3.x (`ImageFileDirectory`
 * with `getValue()`, `getGeoKeys()`), so upgrading geotiff.js later only needs a dependency bump.
 * Only "eager" tags are read: image structure, georeferencing, GDAL_NODATA and GDAL_METADATA.
 */
export function tag<T = unknown>(image: GeoTIFFImage, name: string): T | undefined {
    const fd = image.fileDirectory as unknown as { getValue?: (name: string) => unknown } & Record<string, unknown>;
    const value = typeof fd.getValue === "function" ? fd.getValue(name) : fd[name];
    return (value === null ? undefined : value) as T | undefined;
}

export function hasTag(image: GeoTIFFImage, name: string): boolean {
    return tag(image, name) !== undefined;
}

/** Parsed GeoKey directory (`{}` when the image has none; overviews normally have none). */
export function geoKeysOf(image: GeoTIFFImage): Record<string, unknown> {
    try {
        const img = image as unknown as { getGeoKeys?: () => unknown; geoKeys?: unknown };
        const keys = typeof img.getGeoKeys === "function" ? img.getGeoKeys() : img.geoKeys;
        return (keys ?? {}) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Byte offset of the first image directory. */
export function firstIFDOffsetOf(tiff: GeoTIFF): number | undefined {
    const offset = (tiff as unknown as { firstIFDOffset?: unknown }).firstIFDOffset;
    return typeof offset === "number" ? offset : undefined;
}

/** NewSubfileType bit 2: the image is a transparency mask. */
export function isMaskImage(image: GeoTIFFImage): boolean {
    return ((tag<number>(image, "NewSubfileType") ?? 0) & 0b100) !== 0;
}

/** PhotometricInterpretation (2 = RGB, 3 = palette, ...). */
export function photometricOf(image: GeoTIFFImage): number | undefined {
    return tag<number>(image, "PhotometricInterpretation");
}

/** Palette (`ColorMap` tag) of palette images: 3 * 2^bits entries, all reds, then greens, then blues. */
export function colorMapOf(image: GeoTIFFImage): ArrayLike<number> | null {
    return photometricOf(image) === 3 ? (tag<ArrayLike<number>>(image, "ColorMap") ?? null) : null;
}

async function gdalMetadata(image: GeoTIFFImage, band: number): Promise<Record<string, unknown>> {
    try {
        // Synchronous in geotiff.js 2.x, asynchronous in 3.x: await handles both.
        return ((await image.getGDALMetadata(band)) ?? {}) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** GDAL band scale and offset (`value = raw * scale + offset`), `{scale: 1, offset: 0}` when absent. */
export async function gdalScaleOffset(image: GeoTIFFImage, band = 0): Promise<{ scale: number; offset: number }> {
    const metadata = await gdalMetadata(image, band);
    const scale = Number(metadata.SCALE);
    const offset = Number(metadata.OFFSET);
    return {scale: Number.isFinite(scale) && scale !== 0 ? scale : 1, offset: Number.isFinite(offset) ? offset : 0};
}

/**
 * `STATISTICS_MINIMUM` / `STATISTICS_MAXIMUM` written by GDAL (for example by `gdalinfo -stats`), if present.
 */
export async function gdalStatisticsRange(image: GeoTIFFImage, band = 0): Promise<{ min: number; max: number } | null> {
    const metadata = await gdalMetadata(image, band);
    const min = Number(metadata.STATISTICS_MINIMUM);
    const max = Number(metadata.STATISTICS_MAXIMUM);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? {min, max} : null;
}
