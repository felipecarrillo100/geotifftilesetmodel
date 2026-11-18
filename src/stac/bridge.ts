/**
 * From STAC items to GeoTiffTileSetModel inputs: band names, scale/offset/nodata from the catalog, nearest
 * resampling for classes and bit masks, signing, and only the assets a style reads.
 */
import type {BandInput} from "../GeoTiffTileSetModel.js";
import {compileStyle} from "../rs/render.js";
import type {BandStyle} from "../rs/style.js";
import {DEFAULT_SIGNERS, resolveAsset, type AssetSigner} from "./assets.js";
import {assetBands, bandIdentifier, isDataAsset, nameAssetBands} from "./bands.js";
import type {StacItemJson} from "./json.js";

/** Asset roles that mean class or mask values (STAC best-practice roles). */
const MASK_ROLES = /^(cloud|cloud-shadow|snow-ice|water-mask|land-water|data-mask|saturation|classification)$/i;
/**
 * Fallback for catalogs that declare nothing: asset keys of well-known class and quality bands. Sentinel-2's SCL,
 * for one, is described only as `roles: ["data"]` by Earth Search and INPE.
 */
const CATEGORICAL_KEYS = /^(scl|qa_pixel|qa_radsat|qa_aerosol|qa|fmask|lulc|landcover)$/i;

/**
 * Whether an asset holds classes or bit flags (resampled with nearest neighbour): the classification extension or
 * mask roles first, then the key fallback.
 *
 * An asset is categorical when it (or one of its `bands` / `raster:bands`) declares `classification:classes` or
 * `classification:bitfields`, when one of its roles is `cloud`, `cloud-shadow`, `snow-ice`, `water-mask`,
 * `land-water`, `data-mask`, `saturation` or `classification`, or when its key is a well-known class or quality
 * band (`scl`, `qa_pixel`, `qa_radsat`, `qa_aerosol`, `qa`, `fmask`, `lulc`, `landcover`; case-insensitive).
 *
 * @param key The asset key in the item.
 * @param asset The asset.
 * @returns `true` for class or bit-flag data, `false` for continuous values.
 * @example
 * ```ts
 * const item: StacItemJson = searchResult; // an item returned by a search
 * const masks = Object.keys(item.assets).filter((key) => isCategoricalAsset(key, item.assets[key]));
 * ```
 *
 * @category Assets and bands
 */
export function isCategoricalAsset(key: string, asset: StacItemJson["assets"][string]): boolean {
    if (asset["classification:classes"] !== undefined || asset["classification:bitfields"] !== undefined) return true;
    const bands = (asset.bands ?? asset["raster:bands"] ?? []) as Record<string, unknown>[];
    if (bands.some((b) => b["classification:classes"] !== undefined || b["classification:bitfields"] !== undefined)) return true;
    if ((asset.roles ?? []).some((r) => MASK_ROLES.test(r))) return true;
    return CATEGORICAL_KEYS.test(key);
}

/**
 * Options for turning an item's assets into model bands ({@link toBandInputs}, {@link assetBandMap}).
 *
 * @category Assets and bands
 */
export interface ItemBandsOptions {
    /** Asset keys to use. Default: every single-band COG data asset (or only those `style` reads). */
    assets?: string[];
    /** Open only the assets this style reads. */
    style?: BandStyle;
    /**
     * Band names: the EO common name (`red`, `nir`, ... so presets work on every catalog), or the asset key.
     * Default common-name, falling back to the asset key. Landsat's nir08 / lwir11 become nir / lwir when free.
     */
    naming?: "common-name" | "asset-key";
    /**
     * Band names per asset key, overriding the catalog's: one name for a single-band asset, a list for a
     * multiband one (`{tci: ["red", "green", "blue"]}` when the catalog does not describe the bands).
     */
    bandNames?: Record<string, string | string[]>;
    /** Renames bands after naming, e.g. for time series (`(band) => band + "_2024"`). */
    rename?: (band: string, assetKey: string) => string;
    /** Signers for assets that need tokens. Default: Planetary Computer. */
    signers?: AssetSigner[];
    /** Rewrites asset URLs (a CORS proxy, for example). */
    rewriteUrl?: (url: string) => string;
    /** Resampling per asset key, overriding the metadata-based choice ({@link isCategoricalAsset}). */
    resampling?: Record<string, "nearest" | "bilinear">;
}

/**
 * Band names of an item's data assets: asset key → band name.
 *
 * Only single-band (or undescribed) data assets are named ({@link isDataAsset}). With `"common-name"`, an asset
 * takes its EO common name when no other asset of the item shares it (Sentinel-2's three `rededge` assets keep
 * their keys); otherwise, and with `"asset-key"`, it takes its key. Names are made valid identifiers (other
 * characters become `_`, a leading digit gets a `_` prefix), and Landsat's `nir08` / `lwir11` become `nir` / `lwir`
 * when no band of the item has those names. The rule is the one of {@link "ria-geotiff/stac"!collectionBands |
 * collectionBands} (for a collection's item_assets) and {@link assetBandMap}.
 *
 * @param item The STAC item.
 * @param naming `"common-name"` (default) or `"asset-key"`.
 * @returns Asset key to band name, for every single-band data asset.
 * @example
 * ```ts
 * const item: StacItemJson = searchResult; // an item returned by a search
 * const names = itemBandNames(item);       // for example {B04: "red", B08: "nir", SCL: "SCL", ...}
 * ```
 *
 * @category Assets and bands
 */
export function itemBandNames(item: StacItemJson, naming: "common-name" | "asset-key" = "common-name"): Record<string, string> {
    const named = nameItemAssets(item, naming);
    const out: Record<string, string> = {};
    for (const [key, names] of Object.entries(named)) if (assetBands(item.assets[key]).length <= 1) out[key] = names[0];
    return out;
}

/** The names of every data asset of an item (single-band and multiband), in asset order. */
function nameItemAssets(item: StacItemJson, naming: "common-name" | "asset-key" | undefined): Record<string, string[]> {
    const assets = Object.keys(item.assets).filter((k) => isDataAsset(k, item.assets[k])).map((key) => ({key, bands: assetBands(item.assets[key])}));
    return nameAssetBands(assets, naming);
}

/**
 * Band names of each data asset of an item (asset key → names, one per band of the file), after `bandNames` and
 * `rename`. Single-band assets use the common name (or key); multiband assets one name per described band.
 *
 * Without `options.assets` the result covers the single-band data assets (named by {@link itemBandNames}), the
 * multiband data assets, and the assets named in `bandNames`. A multiband band is named by its common name (unless
 * `naming` is `"asset-key"`), else its name, else `{key}_b{n}` (1-based). Every name is made a valid identifier
 * before `rename`.
 *
 * @param item The STAC item.
 * @param options Naming options ({@link ItemBandsOptions} without `style`, `signers` and `rewriteUrl`). Default `{}`.
 * @returns Asset key to band names, in band order of the file.
 * @example
 * ```ts
 * const item: StacItemJson = searchResult; // an item returned by a search
 * const map = assetBandMap(item, {bandNames: {visual: ["red", "green", "blue"]}, rename: (b) => `${b}_2024`});
 * // {..., visual: ["red_2024", "green_2024", "blue_2024"]}
 * ```
 *
 * @category Assets and bands
 */
export function assetBandMap(item: StacItemJson, options: Omit<ItemBandsOptions, "style" | "signers" | "rewriteUrl"> = {}): Record<string, string[]> {
    const named = nameItemAssets(item, options.naming);
    const rename = options.rename ?? ((b: string) => b);
    const dataKeys = Object.keys(named);
    const multiband = (k: string) => assetBands(item.assets[k]).length > 1;
    const keys = options.assets ?? [...dataKeys.filter((k) => !multiband(k)), ...dataKeys.filter(multiband),
        ...Object.keys(options.bandNames ?? {}).filter((k) => item.assets[k] && !(k in named))];
    const out: Record<string, string[]> = {};
    for (const key of [...new Set(keys)]) {
        const given = options.bandNames?.[key];
        const bands = assetBands(item.assets[key] ?? {});
        const names = given !== undefined ? (Array.isArray(given) ? given : [given]).map(bandIdentifier)
            : named[key] ?? (bands.length > 1 ? nameAssetBands([{key, bands}], options.naming)[key] : [bandIdentifier(key)]);
        out[key] = names.map((b) => rename(b, key));
    }
    return out;
}

/**
 * Band inputs for an item's assets, ready for `GeoTiffTileSetModel.create({inputs})`. Single-band assets give one band
 * each; a multiband asset (NAIP's 4-band image) gives one input with a name per band, from its common names.
 *
 * Each input gets the asset's readable URL (an https href or alternate, passed through `rewriteUrl`), a `sign`
 * function when a signer matches, scale, offset and nodata of the asset's first band, and nearest resampling for
 * categorical assets ({@link isCategoricalAsset}), bilinear otherwise, unless `resampling` says otherwise. With
 * `style` and without `assets`, only the assets holding bands the style reads are kept.
 *
 * @param item The STAC item.
 * @param options Which assets, how to name their bands, signing and URL rewriting ({@link ItemBandsOptions}).
 *   Default `{}`: every data asset, common names, the Planetary Computer signer.
 * @returns One input per asset, in the order of `options.assets` or of the band map.
 * @throws `RangeError` when an asset of `options.assets` is not in the item, or when an asset cannot be read from a
 *   browser (an `s3://` href without http(s) alternate, requester-pays storage, an `http://` URL on an https page
 *   without `rewriteUrl`). With `rewriteUrl`, an http URL on an https page is accepted: the rewritten URL (a proxy)
 *   is expected to be https.
 * @throws {@link "ria-geotiff"!StyleError | StyleError} when `options.style` is given and is invalid for the band names (for example it reads a band
 *   the item does not have).
 * @example
 * ```ts
 * const item: StacItemJson = searchResult; // an item returned by a search
 * const assets = ["...", "..."];          // asset keys chosen by the application
 * const style: BandStyle = userStyle;      // a style reading the bands of those assets
 * const inputs = toBandInputs(item, {assets});
 * const model = await GeoTiffTileSetModel.create({inputs, style});
 * map.layerTree.addChild(new RasterTileSetLayer(model, {label: item.id})); // map: your LuciadRIA WebGLMap
 * ```
 *
 * @category Assets and bands
 */
export function toBandInputs(item: StacItemJson, options: ItemBandsOptions = {}): BandInput[] {
    return bandInputsOf(item, options, options.rewriteUrl !== undefined);
}

/**
 * {@link toBandInputs}, with `rewritten` saying whether the URLs are rewritten later (by the model's `rewriteUrl`),
 * so that http URLs on an https page are accepted.
 *
 * @internal
 *
 * @category Assets and bands
 */
export function bandInputsOf(item: StacItemJson, options: ItemBandsOptions, rewritten: boolean): BandInput[] {
    const map = assetBandMap(item, options);
    const namesOf = (key: string) => map[key] ?? assetBandMap(item, {...options, assets: [key]})[key];
    let keys = options.assets ?? Object.keys(map);
    if (options.style && !options.assets) {
        const needed = new Set(compileStyle(options.style, keys.flatMap(namesOf)).requiredBands);
        keys = keys.filter((k) => namesOf(k).some((n) => needed.has(n)));
    }
    return keys.map((key) => {
        if (!item.assets[key]) throw new RangeError(`STAC item ${item.id} has no asset "${key}"`);
        const resolved = resolveAsset(item, key, options.signers ?? DEFAULT_SIGNERS);
        if (resolved.readable === "no" && !(rewritten && resolved.reason === "mixed content")) throw new RangeError(`Asset "${key}" of ${item.id} cannot be read from a browser: ${resolved.reason}`);
        const band = resolved.bands[0] ?? {};
        const categorical = isCategoricalAsset(key, item.assets[key]);
        const url = options.rewriteUrl ? options.rewriteUrl(resolved.href) : resolved.href;
        const bandList = namesOf(key);
        return {
            url,
            bands: bandList.length === 1 ? bandList[0] : bandList,
            scale: band.scale, offset: band.offset,
            nodata: band.nodata,
            resampling: options.resampling?.[key] ?? (categorical ? "nearest" : "bilinear"),
            sign: resolved.sign && (options.rewriteUrl ? async (u: string) => options.rewriteUrl!(await resolved.sign!(u)) : resolved.sign),
            crsName: crsNameOf(item, key),
        } satisfies BandInput;
    });
}

/**
 * The coordinate reference a STAC asset declares (projection extension): `proj:code` (`"EPSG:2056"`), else
 * `proj:epsg` (`2056`), on the asset, else on the item. Undefined when neither says (or `proj:epsg` is null).
 *
 * @internal
 */
export function crsNameOf(item: StacItemJson, key: string): string | undefined {
    for (const holder of [item.assets[key] as Record<string, unknown> | undefined, item.properties as Record<string, unknown> | undefined]) {
        if (!holder) continue;
        const code = holder["proj:code"];
        if (typeof code === "string" && code.trim()) return code.trim();
        const epsg = holder["proj:epsg"];
        if (typeof epsg === "number" && Number.isInteger(epsg) && epsg > 0) return `EPSG:${epsg}`;
    }
    return undefined;
}
