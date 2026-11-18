/**
 * From the source options of `GeoTiffTileSetModel.create()` (url, file, inputs, stac, manifest) to band inputs.
 */
import type {BandInput, CreateModelOptions, ModelSource} from "../GeoTiffTileSetModel.js";
import {originOf} from "../http.js";
import {manifestToOptions, readManifest} from "./manifest.js";

const SOURCES = ["url", "file", "inputs", "stac", "manifest"] as const;

/**
 * The inputs, the model options without the source, and a description of the source.
 *
 * @internal
 *
 * @category Sources
 */
export async function resolveSource(options: CreateModelOptions): Promise<{ inputs: BandInput[]; deferred?: Set<BandInput>; options: CreateModelOptions; source: ModelSource }> {
    if (!options || typeof options !== "object") throw new RangeError("GeoTiffTileSetModel.create needs options with a source");
    const given = SOURCES.filter((k) => options[k] !== undefined);
    if (given.length !== 1) {
        throw new RangeError(`Give exactly one source (url, file, inputs, stac or manifest)${given.length ? `, not ${given.join(" and ")}` : ""}`);
    }
    const {url, file, inputs, stac, manifest, ...rest} = options;
    if (url !== undefined) return {inputs: [{url}], options: rest, source: {kind: "inputs"}};
    if (file !== undefined) return {inputs: [{file}], options: rest, source: {kind: "inputs"}};
    if (inputs !== undefined) return {inputs, options: rest, source: {kind: "inputs"}};
    if (stac !== undefined) {
        const {resolveStac} = await import("../stac/source.js");
        const r = await resolveStac(stac, rest);
        return {inputs: r.inputs, deferred: r.deferred, options: {...rest, style: r.style}, source: {kind: "stac", ...r.info}};
    }
    const {manifest: m, base} = await readManifest(manifest!, rest);
    const fromFile = await manifestToOptions(m, rest.base ?? base, rest.resolve);
    const overrides = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as CreateModelOptions;
    const merged: CreateModelOptions = {...fromFile, ...overrides};
    const {inputs: manifestInputs, stac: manifestStac, ...modelOptions} = merged;
    if (manifestInputs) return {inputs: manifestInputs, options: modelOptions, source: {kind: "manifest", manifest: m}};
    const {resolveStac} = await import("../stac/source.js");
    // Item URLs listed by the manifest get the options only on the manifest's own origin.
    const manifestBase = rest.base ?? base;
    const r = await resolveStac(manifestStac!, modelOptions, manifestBase ? originOf(manifestBase) : null);
    return {inputs: r.inputs, deferred: r.deferred, options: {...modelOptions, style: r.style}, source: {kind: "manifest", manifest: m, ...r.info}};
}
