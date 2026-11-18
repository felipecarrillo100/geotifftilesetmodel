/**
 * Logs the library (and LuciadRIA) calls the studio makes, so that developers can learn the workflow from the
 * browser console: one collapsed group per call, headed by the call as copy-pasteable TypeScript with its real
 * arguments, holding a summary of the result and the duration. Secrets are shown as "<redacted>".
 */
import {RiaGeoTiffError, type RiaGeoTiffRequest} from "ria-geotiff";
export type Step = "1 Capabilities" | "2 Choose" | "3 Create" | "4 Layer" | "5 Style";

let enabled = true;

/**
 * The library's own report of each request (its `onRequest` option): one console line per request while logging is
 * on. URLs come without signing or added parameters, so nothing secret is printed.
 */
export function logRequest(r: RiaGeoTiffRequest): void {
    if (!enabled) return;
    console.debug(`[ria-geotiff request] ${r.method} ${r.kind} ${r.url}${r.range ? ` ${r.range}` : ""} → ${r.status ?? r.error} (${Math.round(r.ms)} ms)`);
}

/** Switches the logging on or off (the "Log library calls" checkbox). */
export function setTracing(on: boolean) {
    enabled = on;
}

const SECRET_KEYS = /^(requestheaders|authorization|token|apikey|api_key|password|secret|requestparameters)$/i;
const SIGNED_QUERY = /[?&](sig|se|sp|sv|token|signature|x-amz-signature|x-goog-signature|access_token|api_key)=/i;

/** A value as TypeScript source: JSON-like, long arrays summarised, functions by name, secrets redacted. */
export function code(value: unknown, depth = 0): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") {
        const shown = SIGNED_QUERY.test(value) ? `${value.split("?")[0]}?<redacted>` : value;
        return JSON.stringify(shown);
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "function") return value.name || "(function)";
    if (typeof File !== "undefined" && value instanceof File) return `file /* ${value.name}, ${value.size} bytes */`;
    if (typeof Blob !== "undefined" && value instanceof Blob) return `blob /* ${value.size} bytes */`;
    if (value instanceof URL) return `new URL(${code(value.toString())})`;
    if (Array.isArray(value)) {
        const ids = value.map((v) => (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null));
        if (value.length > 6 || (depth > 0 && ids.every((id) => id !== null) && value.length > 0)) {
            const named = ids.filter((id): id is string => id !== null);
            return `[/* ${value.length} ${named.length === value.length ? `items: ${named.slice(0, 4).join(", ")}${value.length > 4 ? ", …" : ""}` : "values"} */]`;
        }
        return `[${value.map((v) => code(v, depth + 1)).join(", ")}]`;
    }
    if (typeof value === "object") {
        const ctor = (value as object).constructor?.name;
        if (ctor && ctor !== "Object") return `/* ${ctor} */`;
        if (depth > 4) return "{…}";
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
        return `{${entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${SECRET_KEYS.test(k) ? redacted(v) : code(v, depth + 1)}`).join(", ")}}`;
    }
    return String(value);
}

function redacted(v: unknown): string {
    if (v && typeof v === "object") return `{${Object.keys(v).map((k) => `${JSON.stringify(k)}: "<redacted>"`).join(", ")}}`;
    return '"<redacted>"';
}

/** The fields of an error worth showing: the library's errors all have the same shape (see RiaGeoTiffError.toJSON). */
function errorFields(e: unknown): Record<string, unknown> {
    if (e instanceof RiaGeoTiffError) return e.toJSON();
    return e instanceof Error ? {name: e.name, message: e.message} : {value: e};
}

/**
 * Runs a call and logs it. `call` is the TypeScript of the call (build it with {@link code} for the arguments);
 * `summary` turns the result into what is worth seeing.
 */
export async function trace<T>(step: Step, call: string, run: () => Promise<T> | T, summary?: (result: T) => unknown): Promise<T> {
    const start = performance.now();
    try {
        const result = await run();
        if (enabled) {
            console.groupCollapsed(`[ria-geotiff ${step}] ${call}`);
            console.log("result:", summary ? summary(result) : result);
            console.log(`duration: ${(performance.now() - start).toFixed(0)} ms`);
            console.groupEnd();
        }
        return result;
    } catch (e) {
        if (enabled) {
            console.groupCollapsed(`[ria-geotiff ${step}] ${call}  ✗`);
            console.error(`${(e as Error)?.constructor?.name ?? "Error"}:`, errorFields(e));
            console.log(`duration: ${(performance.now() - start).toFixed(0)} ms`);
            console.groupEnd();
        }
        throw e;
    }
}

/** {@link trace} for synchronous calls. */
export function traceSync<T>(step: Step, call: string, run: () => T, summary?: (result: T) => unknown): T {
    const start = performance.now();
    try {
        const result = run();
        if (enabled) {
            console.groupCollapsed(`[ria-geotiff ${step}] ${call}`);
            if (result !== undefined) console.log("result:", summary ? summary(result) : result);
            console.log(`duration: ${(performance.now() - start).toFixed(1)} ms`);
            console.groupEnd();
        }
        return result;
    } catch (e) {
        if (enabled) console.error(`[ria-geotiff ${step}] ${call}  ✗`, errorFields(e));
        throw e;
    }
}
