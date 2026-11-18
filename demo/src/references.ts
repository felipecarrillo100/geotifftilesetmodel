import {addReference, isValidReferenceIdentifier, parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider.js";
import {GeoTiffModelError} from "ria-geotiff";

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
 * Runs `create`; when it fails because LuciadRIA does not know the GeoTIFF's coordinate reference
 * (`GeoTiffModelError` with cause `UnknownIdentifier`), registers the definition and tries once more.
 */
export async function withReferenceRetry<T>(create: () => Promise<T>, log: (message: string) => void): Promise<T> {
    try {
        return await create();
    } catch (error) {
        const identifier = error instanceof GeoTiffModelError && error.cause === "UnknownIdentifier" ? error.identifier : undefined;
        if (!identifier || !ensureReference(identifier)) throw error;
        log(`registered ${identifier} from WKT, retrying`);
        return await create();
    }
}

/**
 * Makes sure LuciadRIA knows `identifier`, registering it from the table above when needed.
 * @returns true when the reference was registered now, false when it was already known or is not in the table
 */
export function ensureReference(identifier: string): boolean {
    const wkt = WKT[identifier];
    if (!wkt || isValidReferenceIdentifier(identifier)) return false;
    const [authority, code] = identifier.split(":");
    addReference(parseWellKnownText(wkt, authority, code), identifier);
    return true;
}
