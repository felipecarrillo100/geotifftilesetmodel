import {addReference, isValidReferenceIdentifier, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";

/**
 * Definitions of coordinate references LuciadRIA does not ship, as WKT (from `gdalsrsinfo -o wkt1 EPSG:<code>`,
 * plus a TOWGS84 datum shift: LuciadRIA needs it for datums it does not know by name).
 * For LV95 the projection is named `Swiss_Oblique_Mercator`, LuciadRIA's dedicated implementation: its generic
 * `Hotine_Oblique_Mercator_Azimuth_Center` (GDAL's name) cannot handle the 90 degree azimuth and throws
 * OutOfBoundsError for every point.
 * Applications usually fetch these from their own service; the demo keeps the ones its sample data needs.
 */
const WKT: Record<string, string> = {
    // CH1903+ / LV95: swisstopo swissALTI3D and SWISSIMAGE. TOWGS84 = EPSG:1676 (CH1903+ to ETRS89, ~1 m).
    "EPSG:2056": 'PROJCS["CH1903+ / LV95",GEOGCS["CH1903+",DATUM["CH1903+",SPHEROID["Bessel 1841",6377397.155,299.1528128,AUTHORITY["EPSG","7004"]],TOWGS84[674.374,15.056,405.346,0,0,0,0],AUTHORITY["EPSG","6150"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4150"]],PROJECTION["Swiss_Oblique_Mercator"],PARAMETER["latitude_of_center",46.9524055555556],PARAMETER["longitude_of_center",7.43958333333333],PARAMETER["azimuth",90],PARAMETER["rectified_grid_angle",90],PARAMETER["scale_factor",1],PARAMETER["false_easting",2600000],PARAMETER["false_northing",1200000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","2056"]]',
};

/**
 * The WKT of a coordinate reference LuciadRIA does not ship, for `GeoTiffTileSetModel.create({resolveReference})`:
 * from the table above, or generated for UTM zones. Null when unknown.
 */
export async function referenceWkt(identifier: string): Promise<string | null> {
    return WKT[identifier] ?? utmWkt(identifier) ?? null;
}

/**
 * Makes sure LuciadRIA knows `identifier`, registering it from the table above when needed.
 * @returns true when the reference was registered now, false when it was already known or is not in the table
 */
export function ensureReference(identifier: string): boolean {
    const wkt = WKT[identifier] ?? utmWkt(identifier);
    if (!wkt || isValidReferenceIdentifier(identifier)) return false;
    const [authority, code] = identifier.split(":");
    addReference(parseWellKnownText(wkt, authority, code), identifier);
    return true;
}

/**
 * WKT of the UTM zones used by satellite imagery: WGS 84 / UTM (EPSG:326zz north, 327zz south; Sentinel-2, Landsat)
 * and NAD83 / UTM (EPSG:269zz; NAIP). Generated, as there are 180 of them.
 */
export function utmWkt(identifier: string): string | undefined {
    const match = /^EPSG:(326|327|269)(\d{2})$/.exec(identifier);
    if (!match) return undefined;
    const [, prefix, z] = match;
    const zone = Number(z);
    if (zone < 1 || zone > 60) return undefined;
    const south = prefix === "327";
    const nad83 = prefix === "269";
    const geogcs = nad83
        ? 'GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'
        : 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    return `PROJCS["${nad83 ? "NAD83" : "WGS 84"} / UTM zone ${zone}${south ? "S" : "N"}",${geogcs},PROJECTION["Transverse_Mercator"],`
        + `PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${6 * zone - 183}],PARAMETER["scale_factor",0.9996],`
        + `PARAMETER["false_easting",500000],PARAMETER["false_northing",${south ? 10000000 : 0}],UNIT["metre",1],`
        + `AUTHORITY["EPSG","${prefix}${z}"]]`;
}
