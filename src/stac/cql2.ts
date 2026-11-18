/**
 * The CQL2 subset a STAC search needs, without a dependency: building CQL2-JSON from portable `where` predicates,
 * writing CQL2-text for GET-only servers, and evaluating against items in the browser (to verify that a server
 * applied a filter, or to apply it when the server cannot).
 *
 * Supported: = <> < <= > >=, and / or / not, like, in, between, isNull, s_intersects (geometry, bbox), t_intersects
 * and t_before / t_after with timestamps and intervals. Applications needing more can pass their own CQL2 and an
 * evaluator (for example from the `ogc-cql2` package).
 */
import {containsPoint, intersectsArea, isBbox, polygonsOf} from "./geometry.js";
import type {GeoJsonArea, StacItemJson} from "./json.js";

/**
 * A CQL2-JSON expression: an operation with arguments, or a boolean literal (`true` matches everything).
 *
 * Arguments are nested expressions, literals (numbers, strings, `null`, arrays), property references
 * `{property: "eo:cloud_cover"}`, temporal literals `{timestamp: "..."}`, `{date: "..."}`, `{interval: [start, end]}`
 * (`".."` for an open end), and spatial literals `{bbox: [w, s, e, n]}` or GeoJSON geometries.
 *
 * @example
 * ```ts
 * const filter: Cql2Json = {op: "and", args: [
 *     {op: "<", args: [{property: "eo:cloud_cover"}, 20]},
 *     {op: "=", args: [{property: "platform"}, "sentinel-2a"]},
 * ]};
 * ```
 *
 * @category Search
 */
export type Cql2Json = {
    /** The operator, case-insensitive: `and`, `or`, `not`, `=`, `<>`, `<`, `<=`, `>`, `>=`, `like`, `in`, `between`, `isNull`, `s_intersects`, `t_intersects`, `t_before`, `t_after`, ... */
    op: string;
    /** The operands, in the order the operator defines (for comparisons: the property first, then the value). */
    args: unknown[];
} | boolean;

/**
 * A portable predicate on one property (the Query extension's shape). Every operator given must hold (they are
 * ANDed). Dates are compared as RFC 3339 strings, for example `{gte: "2024-01-01T00:00:00Z"}`.
 *
 * @example
 * ```ts
 * const where: Record<string, WhereComparison> = {
 *     "eo:cloud_cover": {lt: 20},
 *     "platform": {in: ["sentinel-2a", "sentinel-2b"]},
 * };
 * ```
 *
 * @category Search
 */
export interface WhereComparison {
    /** Equal to this value (CQL2 `=`). */
    eq?: unknown;
    /** Not equal to this value (CQL2 `<>`). */
    neq?: unknown;
    /** Less than (CQL2 `<`). */
    lt?: number | string;
    /** Less than or equal (CQL2 `<=`). */
    lte?: number | string;
    /** Greater than (CQL2 `>`). */
    gt?: number | string;
    /** Greater than or equal (CQL2 `>=`). */
    gte?: number | string;
    /** Equal to one of these values (CQL2 `in`, or an `or` of `=` without advanced-comparison support). */
    in?: unknown[];
    /** Between `[low, high]`, both inclusive (CQL2 `between`, or `>=` and `<=`). */
    between?: [number | string, number | string];
    /**
     * Matches a CQL2 `like` pattern: `%` for any run of characters, `_` for one character (case-sensitive). Has no
     * Query extension equivalent, so a `where` using it cannot be sent through the Query extension.
     */
    like?: string;
}

const prop = (name: string) => ({property: name});

/**
 * CQL2-JSON for `where`; `in` and `between` are rewritten to basic comparisons when `advanced` is false.
 *
 * Each operator of each property becomes one comparison on `{property: name}`; several comparisons are joined with
 * `and`.
 *
 * @param where Predicates per property name (`"eo:cloud_cover"`, `"platform"`, ...).
 * @param advanced Whether the server conforms to CQL2 advanced comparison operators. When `false`, `in` becomes `=`
 *   (one value) or an `or` of `=`, and `between` an `and` of `>=` and `<=`. Default `true`.
 * @returns The expression: a single comparison, an `and` of several, or `undefined` when `where` holds no operator.
 * @example
 * ```ts
 * const maxCloud = 20; // percent, from a slider
 * const filter = whereToCql2({"eo:cloud_cover": {lt: maxCloud}});
 * // {op: "<", args: [{property: "eo:cloud_cover"}, 20]}
 * ```
 *
 * @category Search
 */
export function whereToCql2(where: Record<string, WhereComparison>, advanced = true): Cql2Json | undefined {
    const parts: Cql2Json[] = [];
    for (const [name, c] of Object.entries(where)) {
        const p = prop(name);
        if (c.eq !== undefined) parts.push({op: "=", args: [p, c.eq]});
        if (c.neq !== undefined) parts.push({op: "<>", args: [p, c.neq]});
        if (c.lt !== undefined) parts.push({op: "<", args: [p, c.lt]});
        if (c.lte !== undefined) parts.push({op: "<=", args: [p, c.lte]});
        if (c.gt !== undefined) parts.push({op: ">", args: [p, c.gt]});
        if (c.gte !== undefined) parts.push({op: ">=", args: [p, c.gte]});
        if (c.like !== undefined) parts.push({op: "like", args: [p, c.like]});
        if (c.in) {
            parts.push(advanced ? {op: "in", args: [p, c.in]}
                : c.in.length === 1 ? {op: "=", args: [p, c.in[0]]} : {op: "or", args: c.in.map((v) => ({op: "=", args: [p, v]}))});
        }
        if (c.between) {
            parts.push(advanced ? {op: "between", args: [p, ...c.between]}
                : {op: "and", args: [{op: ">=", args: [p, c.between[0]]}, {op: "<=", args: [p, c.between[1]]}]});
        }
    }
    return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : {op: "and", args: parts};
}

/**
 * The Query extension form of `where`, or undefined when a predicate has no Query equivalent (`like`).
 *
 * Operators map one to one (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`); `between` becomes `gte` and `lte`.
 *
 * @param where Predicates per property name.
 * @returns A Query object such as `{"eo:cloud_cover": {lt: 20}}`, or `undefined` when any property uses `like`.
 *
 * @category Search
 */
export function whereToQuery(where: Record<string, WhereComparison>): Record<string, Record<string, unknown>> | undefined {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, c] of Object.entries(where)) {
        if (c.like !== undefined) return undefined;
        const q: Record<string, unknown> = {};
        if (c.eq !== undefined) q.eq = c.eq;
        if (c.neq !== undefined) q.neq = c.neq;
        if (c.lt !== undefined) q.lt = c.lt;
        if (c.lte !== undefined) q.lte = c.lte;
        if (c.gt !== undefined) q.gt = c.gt;
        if (c.gte !== undefined) q.gte = c.gte;
        if (c.in) q.in = c.in;
        if (c.between) { q.gte = c.between[0]; q.lte = c.between[1]; }
        out[name] = q;
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ CQL2-text

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function wkt(g: { type: string; coordinates: unknown }): string {
    const ring = (r: number[][]) => `(${r.map((c) => c.join(" ")).join(", ")})`;
    const poly = (p: number[][][]) => `(${p.map(ring).join(", ")})`;
    switch (g.type) {
        case "Point": return `POINT(${(g.coordinates as number[]).join(" ")})`;
        case "Polygon": return `POLYGON${poly(g.coordinates as number[][][])}`;
        case "MultiPolygon": return `MULTIPOLYGON(${(g.coordinates as number[][][][]).map(poly).join(", ")})`;
        default: throw new Error(`No CQL2-text for geometry ${g.type}`);
    }
}

function textArg(a: unknown): string {
    if (a === null) return "NULL";
    if (typeof a === "number" || typeof a === "boolean") return String(a);
    if (typeof a === "string") return quote(a);
    if (Array.isArray(a)) return `(${a.map(textArg).join(", ")})`;
    if (typeof a === "object") {
        const o = a as Record<string, unknown>;
        // CQL2 identifiers may contain ":" and "." (eo:cloud_cover, properties.datetime); quote anything else.
        if (typeof o.property === "string") return /^[A-Za-z_][A-Za-z0-9_.:]*$/.test(o.property) ? o.property : `"${o.property}"`;
        if (typeof o.timestamp === "string") return `TIMESTAMP(${quote(o.timestamp)})`;
        if (typeof o.date === "string") return `DATE(${quote(o.date)})`;
        if (Array.isArray(o.interval)) return `INTERVAL(${(o.interval as string[]).map((v) => (v === ".." ? quote("..") : quote(v))).join(", ")})`;
        if (Array.isArray(o.bbox)) return `BBOX(${(o.bbox as number[]).join(", ")})`;
        if (typeof o.type === "string" && "coordinates" in o) return wkt(o as { type: string; coordinates: unknown });
        if (typeof o.op === "string") return `(${toCql2Text(o as Cql2Json)})`;
    }
    throw new Error(`No CQL2-text for ${JSON.stringify(a)}`);
}

/**
 * CQL2-text of a CQL2-JSON expression (the supported subset). Throws for anything else.
 *
 * Used for servers that accept only GET. Strings are single-quoted, property names are written bare when they are
 * identifiers (letters, digits, `_`, `.`, `:`) and double-quoted otherwise, nested expressions are parenthesised,
 * and geometries become WKT (`POINT`, `POLYGON`, `MULTIPOLYGON`) or `BBOX(...)`.
 *
 * @param e The expression. Supported operators: `and`, `or`, `not`, `=`, `<>`, `<`, `<=`, `>`, `>=`, `like`, `in`,
 *   `between`, `isNull`, and any spatial or temporal function `s_*` / `t_*` with two arguments.
 * @returns The CQL2-text string, for the `filter` parameter with `filter-lang=cql2-text`.
 * @throws `Error` when the expression uses another operator, an argument with no text form (an object that is not
 *   a property, temporal or spatial literal or an expression), or a geometry other than Point, Polygon or
 *   MultiPolygon.
 * @example
 * ```ts
 * const text = toCql2Text({op: "and", args: [
 *     {op: "<", args: [{property: "eo:cloud_cover"}, 20]},
 *     {op: "in", args: [{property: "platform"}, ["sentinel-2a", "sentinel-2b"]]},
 * ]});
 * // "(eo:cloud_cover < 20) AND (platform IN ('sentinel-2a', 'sentinel-2b'))"
 * ```
 *
 * @category Search
 */
export function toCql2Text(e: Cql2Json): string {
    if (typeof e === "boolean") return e ? "TRUE" : "FALSE";
    const [a, b, c] = e.args;
    switch (e.op.toLowerCase()) {
        case "and": case "or": return e.args.map((x) => `(${toCql2Text(x as Cql2Json)})`).join(` ${e.op.toUpperCase()} `);
        case "not": return `NOT (${toCql2Text(a as Cql2Json)})`;
        case "=": case "<>": case "<": case "<=": case ">": case ">=": return `${textArg(a)} ${e.op} ${textArg(b)}`;
        case "like": return `${textArg(a)} LIKE ${textArg(b)}`;
        case "in": return `${textArg(a)} IN ${textArg(b)}`;
        case "between": return `${textArg(a)} BETWEEN ${textArg(b)} AND ${textArg(c)}`;
        case "isnull": return `${textArg(a)} IS NULL`;
        default:
            if (/^[st]_[a-z]+$/i.test(e.op)) return `${e.op.toUpperCase()}(${textArg(a)}, ${textArg(b)})`;
            throw new Error(`No CQL2-text for operator ${e.op}`);
    }
}

// ------------------------------------------------------------------------------------------------ evaluation

function value(item: StacItemJson, a: unknown): unknown {
    if (a && typeof a === "object" && !Array.isArray(a)) {
        const o = a as Record<string, unknown>;
        if (typeof o.property === "string") {
            const name = o.property.replace(/^properties\./, "");
            if (name === "id") return item.id;
            if (name === "collection") return item.collection;
            if (name === "geometry") return item.geometry;
            return item.properties[name];
        }
        if (typeof o.timestamp === "string") return Date.parse(o.timestamp);
        if (typeof o.date === "string") return Date.parse(o.date);
    }
    return a;
}

const isTemporalLiteral = (a: unknown): boolean => !!a && typeof a === "object" && !Array.isArray(a)
    && (typeof (a as Record<string, unknown>).timestamp === "string" || typeof (a as Record<string, unknown>).date === "string");

/** An instant in milliseconds: numbers as they are, strings parsed as dates. */
const toTime = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v)));

const cmp = (x: unknown, y: unknown): number => {
    if (typeof x === "string" && typeof y === "string") {
        const dx = Date.parse(x), dy = Date.parse(y);
        if (!Number.isNaN(dx) && !Number.isNaN(dy) && /\d{4}-\d{2}/.test(x)) return dx - dy;
        return x < y ? -1 : x > y ? 1 : 0;
    }
    return Number(x) - Number(y);
};

function timeRange(item: StacItemJson): [number, number] {
    const p = item.properties;
    const start = Date.parse(String(p.start_datetime ?? p.datetime ?? ""));
    const end = Date.parse(String(p.end_datetime ?? p.datetime ?? ""));
    return [start, Number.isNaN(end) ? start : end];
}

function intervalOf(a: unknown): [number, number] | undefined {
    const o = a as Record<string, unknown>;
    if (o && Array.isArray(o.interval)) {
        const [s, e] = o.interval as string[];
        return [s === ".." ? -Infinity : Date.parse(s), e === ".." ? Infinity : Date.parse(e)];
    }
    if (o && (typeof o.timestamp === "string" || typeof o.date === "string")) {
        const t = Date.parse(String(o.timestamp ?? o.date));
        return [t, t];
    }
    return undefined;
}

/**
 * Evaluates the supported CQL2 subset against an item. Unsupported operators throw.
 *
 * Property references read `item.properties` (a `properties.` prefix is ignored), except `id`, `collection` and
 * `geometry`, which read the item itself. A comparison on a missing or `null` property is `false`. Two strings that
 * both parse as dates (and look like `YYYY-MM...`) compare as instants, other strings lexically, everything else as
 * numbers; a comparison with a `{timestamp}` or `{date}` literal parses the property as a date. `like` matches
 * the whole value, case-sensitively. `s_intersects` tests the item's footprint against a
 * bbox literal or geometry (approximately, see {@link intersectsArea}); `t_intersects`, `t_before` and `t_after`
 * use the item's `start_datetime`/`end_datetime`, else its `datetime`, against a timestamp, date or interval.
 *
 * @param e The expression, as built by {@link whereToCql2} or given by the application.
 * @param item The STAC item to test.
 * @returns `true` when the item satisfies the expression. Temporal operators give `false` for items without a
 *   parsable datetime.
 * @throws `Error` for an unsupported operator (such as `t_during` or `a_contains`), whatever the item holds: also
 *   when the property is missing or the item has no datetime.
 * @example
 * ```ts
 * const items: StacItemJson[] = page.features; // items returned by a server
 * const clear = items.filter((item) => evaluateCql2({op: "<", args: [{property: "eo:cloud_cover"}, 20]}, item));
 * ```
 *
 * @category Search
 */
export function evaluateCql2(e: Cql2Json, item: StacItemJson): boolean {
    if (typeof e === "boolean") return e;
    const [a, b, c] = e.args;
    const op = e.op.toLowerCase();
    switch (op) {
        case "and": return e.args.every((x) => evaluateCql2(x as Cql2Json, item));
        case "or": return e.args.some((x) => evaluateCql2(x as Cql2Json, item));
        case "not": return !evaluateCql2(a as Cql2Json, item);
        case "isnull": { const v = value(item, a); return v === null || v === undefined; }
    }
    if (op === "s_intersects") {
        const g = (b as Record<string, unknown>);
        const area = Array.isArray(g?.bbox) ? g.bbox as [number, number, number, number] : g as unknown as GeoJsonArea;
        if (g && (g as {type?: string}).type === "Point") {
            const [x, y] = (g as unknown as {coordinates: number[]}).coordinates;
            return containsPoint(polygonsOf(item.geometry), x, y);
        }
        return intersectsArea(item, isBbox(area) ? area : area);
    }
    // Unsupported operators throw whatever the item holds, before a missing value could make them false.
    if (!SUPPORTED.has(op)) throw new Error(`Cannot evaluate CQL2 operator ${e.op}`);
    if (op.startsWith("t_")) {
        const [s, en] = timeRange(item), other = intervalOf(b);
        if (!other || Number.isNaN(s)) return false;
        if (op === "t_intersects") return s <= other[1] && en >= other[0];
        if (op === "t_before") return en < other[0];
        return s > other[1];   // t_after
    }
    // A timestamp or date literal on either side compares instants: the property is parsed as a date too.
    const temporal = [a, b, c].some(isTemporalLiteral) || (op === "in" && Array.isArray(b) && b.some(isTemporalLiteral));
    const raw = value(item, a);
    if (raw === undefined || raw === null) return false;
    const x = temporal ? toTime(raw) : raw;
    const v = (arg: unknown) => (temporal ? toTime(value(item, arg)) : value(item, arg));
    switch (op) {
        case "=": return cmp(x, v(b)) === 0;
        case "<>": return cmp(x, v(b)) !== 0;
        case "<": return cmp(x, v(b)) < 0;
        case "<=": return cmp(x, v(b)) <= 0;
        case ">": return cmp(x, v(b)) > 0;
        case ">=": return cmp(x, v(b)) >= 0;
        case "between": return cmp(x, v(b)) >= 0 && cmp(x, v(c)) <= 0;
        case "in": return (b as unknown[]).some((e) => cmp(x, temporal ? toTime(value(item, e)) : e) === 0);
        default: {   // like
            const pattern = String(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
            return new RegExp(`^${pattern}$`, "s").test(String(x));
        }
    }
}

/** The operators {@link evaluateCql2} evaluates (besides `and`, `or`, `not`, `isNull` and `s_intersects`). */
const SUPPORTED = new Set(["=", "<>", "<", "<=", ">", ">=", "between", "in", "like", "t_intersects", "t_before", "t_after"]);
