/**
 * The parts of STAC JSON this module reads (STAC 1.0 and 1.1, STAC API 1.0). Unknown fields are kept: every type
 * has an index signature, and the raw objects are passed through unchanged.
 */

/** `[west, south, east, north]` in longitude/latitude (CRS84).
 *
 * @category STAC JSON */
export type Bbox = [number, number, number, number];

/** A GeoJSON Polygon in longitude/latitude (CRS84).
 *
 * @category STAC JSON */
export interface GeoJsonPolygon {
    /** Always `"Polygon"`. */
    type: "Polygon";
    /** Linear rings (outer ring first, then holes) of `[longitude, latitude]` positions. */
    coordinates: number[][][];
}
/** A GeoJSON MultiPolygon in longitude/latitude (CRS84).
 *
 * @category STAC JSON */
export interface GeoJsonMultiPolygon {
    /** Always `"MultiPolygon"`. */
    type: "MultiPolygon";
    /** Polygons, each a list of linear rings of `[longitude, latitude]` positions. */
    coordinates: number[][][][];
}
/** A search or filter area: a GeoJSON Polygon or MultiPolygon in longitude/latitude (CRS84).
 *
 * @category STAC JSON */
export type GeoJsonArea = GeoJsonPolygon | GeoJsonMultiPolygon;

/** A STAC link object, including the STAC API paging fields (`method`, `headers`, `body`, `merge`).
 *
 * @category STAC JSON */
export interface StacLink {
    /** Target URL. */
    href: string;
    /** Relation type, for example `"self"`, `"next"`, `"search"`, `"data"` or `"conformance"`. */
    rel: string;
    /** Media type of the target, for example `"application/geo+json"`. */
    type?: string;
    /** Human-readable title. */
    title?: string;
    /** STAC API paging: the HTTP method of the link (default GET). */
    method?: string;
    /** STAC API paging: headers to send with the request; multiple values are joined with `", "`. */
    headers?: Record<string, string | string[]>;
    /** STAC API paging: the JSON body of a POST request. */
    body?: Record<string, unknown>;
    /** POST paging: merge `body` into the previous request body. */
    merge?: boolean;
    /** Any other link field, kept unchanged. */
    [key: string]: unknown;
}

/** A STAC asset object (a file of an item or collection).
 *
 * @category STAC JSON */
export interface StacAssetJson {
    /** URL of the file: https, or another scheme such as `s3://` (see `alternate`). */
    href: string;
    /** Media type, for example `"image/tiff; application=geotiff; profile=cloud-optimized"`. */
    type?: string;
    /** Human-readable title. */
    title?: string;
    /** Longer description. */
    description?: string;
    /** Asset roles, for example `["data"]`, `["thumbnail"]` or `["overview"]`. */
    roles?: string[];
    /** STAC 1.1 common metadata (unified bands). */
    bands?: Record<string, unknown>[];
    /** Bands of the EO extension (STAC 1.0). */
    "eo:bands"?: Record<string, unknown>[];
    /** Bands of the Raster extension (STAC 1.0): data type, nodata, scale, offset, statistics. */
    "raster:bands"?: Record<string, unknown>[];
    /** Alternate Assets extension: other locations of the same file, by name (for example `https` next to `s3`). */
    alternate?: Record<string, {
        /** URL of the alternate location. */
        href: string;
        /** Any other field of the alternate, kept unchanged. */
        [key: string]: unknown;
    }>;
    /** Any other asset field (extension fields such as `storage:*` or `auth:refs`), kept unchanged. */
    [key: string]: unknown;
}

/** A STAC Item: a GeoJSON Feature with assets.
 *
 * @category STAC JSON */
export interface StacItemJson {
    /** Always `"Feature"`. */
    type: "Feature";
    /** STAC version of the item, for example `"1.0.0"`. */
    stac_version?: string;
    /** Item id, unique within its collection. */
    id: string;
    /** Id of the collection the item belongs to. */
    collection?: string;
    /** Bounding box `[west, south, east, north]` (or 6 values with heights) in longitude/latitude. */
    bbox?: number[];
    /** GeoJSON footprint in longitude/latitude, or null when the item has no geometry. */
    geometry: {
        /** GeoJSON geometry type, for example `"Polygon"`. */
        type: string;
        /** GeoJSON coordinates for that type. */
        coordinates: unknown;
    } | null;
    /** Item properties (common metadata and extension fields). */
    properties: Record<string, unknown> & {
        /** Acquisition time as RFC 3339, or null when the item has `start_datetime` and `end_datetime` instead. */
        datetime?: string | null;
    };
    /** Assets by key. */
    assets: Record<string, StacAssetJson>;
    /** Links of the item. */
    links?: StacLink[];
    /** Any other item field, kept unchanged. */
    [key: string]: unknown;
}

/** A STAC Collection.
 *
 * @category STAC JSON */
export interface StacCollectionJson {
    /** Always `"Collection"` when present. */
    type?: "Collection";
    /** Collection id. */
    id: string;
    /** Human-readable title. */
    title?: string;
    /** Longer description (CommonMark). */
    description?: string;
    /** License identifier (SPDX expression, `"other"` or `"proprietary"`). */
    license?: string;
    /** Keywords. */
    keywords?: string[];
    /** Spatial and temporal extent. */
    extent?: {
        /** Spatial extent. */
        spatial?: {
            /** Bounding boxes in longitude/latitude: the first is the overall extent, the others are subsets. */
            bbox?: number[][];
        };
        /** Temporal extent. */
        temporal?: {
            /** Intervals `[start, end]` as RFC 3339, null for an open end: the first is the overall interval. */
            interval?: (string | null)[][];
        };
    };
    /** Summaries of item properties: value lists, `{minimum, maximum}` ranges or JSON schemas. */
    summaries?: Record<string, unknown>;
    /** Item Assets extension: the assets each item of the collection has, by key, usually without hrefs. */
    item_assets?: Record<string, Omit<StacAssetJson, "href"> & {
        /** Usually absent: item asset definitions have no URL. */
        href?: string;
    }>;
    /** Assets of the collection itself, by key. */
    assets?: Record<string, StacAssetJson>;
    /** Links of the collection. */
    links?: StacLink[];
    /** Any other collection field, kept unchanged. */
    [key: string]: unknown;
}

/** A STAC Catalog, or the landing page of a STAC API.
 *
 * @category STAC JSON */
export interface StacCatalogJson {
    /** `"Catalog"` for a catalog or landing page. */
    type?: string;
    /** Catalog id. */
    id?: string;
    /** Human-readable title. */
    title?: string;
    /** Longer description (CommonMark). */
    description?: string;
    /** STAC version, for example `"1.0.0"`. */
    stac_version?: string;
    /** Conformance class URIs (STAC API landing pages). */
    conformsTo?: string[];
    /** Links: `search`, `data` (collections), `conformance`, children and others. */
    links?: StacLink[];
    /** Any other field, kept unchanged. */
    [key: string]: unknown;
}

/** A page of a search or of `/collections/{id}/items`.
 *
 * @category STAC JSON */
export interface StacItemCollectionJson {
    /** Always `"FeatureCollection"` when present. */
    type?: "FeatureCollection";
    /** Items of the page. */
    features: StacItemJson[];
    /** Links, including `next` for paging. */
    links?: StacLink[];
    /** Total number of items matching the search, when the server reports it. */
    numberMatched?: number;
    /** Number of items in this page. */
    numberReturned?: number;
    /** Deprecated Context extension (still used by INPE BDC and NASA CMR-STAC). */
    context?: {
        /** Total number of matching items. */
        matched?: number;
        /** Number of items in this page. */
        returned?: number;
        /** Page size used by the server. */
        limit?: number;
    };
    /** Any other field, kept unchanged. */
    [key: string]: unknown;
}
