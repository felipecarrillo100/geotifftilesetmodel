/**
 * Band-math expressions, evaluated per pixel over whole tiles.
 *
 * Two front ends produce the same syntax tree:
 * - a string grammar compatible with TiTiler / rio-tiler style expressions: `(nir - red) / (nir + red)`,
 *   `b4 / b3`, `where(scl == 6, 1, 0)`;
 * - JSON arrays in the OpenLayers style: `["/", ["-", ["band", "nir"], ["band", "red"]], ["+", ...]]`.
 *
 * Only band identifiers, numbers, a fixed set of operators and a whitelist of functions are accepted, so an
 * expression can never run arbitrary code (no `eval`, and no general-purpose evaluator such as expr-eval, which has
 * a remote code execution vulnerability: CVE-2025-12735).
 *
 * Evaluation compiles the validated tree into a specialised loop with `new Function` (within a few percent of
 * hand-written code). Where a Content Security Policy forbids that (no `'unsafe-eval'`), a vectorised interpreter
 * that applies each node to whole Float32Arrays is used instead, about 4x slower but still well under a millisecond
 * per 256x256 tile.
 *
 * The grammar, the functions and the NaN rules are documented on {@link parseExpression} (string form),
 * `fromExpressionArray` (JSON-array form) and {@link compileExpression} (evaluation).
 *
 * @module
 */
import {RiaGeoTiffError} from "../errors.js";

/**
 * Syntax tree of an expression, produced by {@link parseExpression}, {@link toExpressionNode} and
 * `fromExpressionArray`, and accepted by {@link compileExpression}, {@link expressionBands} and
 * {@link formatExpression}. Plain JSON.
 *
 * @example
 * The tree of `(nir - red) / 2`:
 * ```json
 * { "kind": "binary", "op": "/",
 *   "left": { "kind": "binary", "op": "-", "left": { "kind": "band", "name": "nir" },
 *             "right": { "kind": "band", "name": "red" } },
 *   "right": { "kind": "number", "value": 2 } }
 * ```
 *
 * @category Expressions
 */
export type ExpressionNode =
    /** A numeric constant (`pi` parses to one). */
    | {
        /** Discriminator: a number. */
        kind: "number";
        /** The number. */
        value: number;
    }
    /** The value of a band at the pixel. */
    | {
        /** Discriminator: a band reference. */
        kind: "band";
        /** The band name (case-sensitive). */
        name: string;
    }
    /** Negation (`-x`) or logical not (`!x`: 1 when x is 0 or NaN, else 0). */
    | {
        /** Discriminator: a unary operator. */
        kind: "unary";
        /** `"-"` (negation) or `"!"` (logical not). */
        op: "-" | "!";
        /** The operand. */
        arg: ExpressionNode;
    }
    /** An arithmetic, comparison or logical operator. */
    | {
        /** Discriminator: a binary operator. */
        kind: "binary";
        /**
         * One of `+ - * / ^` (arithmetic; `^` is power), `< <= > >= == !=` (comparisons, 1 or 0) or `&& ||`
         * (logical, 1 or 0).
         */
        op: BinaryOp;
        /** The left operand. */
        left: ExpressionNode;
        /** The right operand. */
        right: ExpressionNode;
    }
    /** A call of a whitelisted function (see {@link parseExpression}), with its arity already checked. */
    | {
        /** Discriminator: a function call. */
        kind: "call";
        /** The function name, lower case. */
        fn: FunctionName;
        /** The arguments. */
        args: ExpressionNode[];
    };

type BinaryOp = "+" | "-" | "*" | "/" | "^" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

/**
 * A JSON-array expression, e.g. `["/", ["-", ["band", "nir"], ["band", "red"]], 2]`.
 *
 * A number is a constant, a string a band name, and an array `[operator or function, ...operands]`. See
 * `fromExpressionArray` below for the full rules.
 *
 * @example
 * ```json
 * ["/", ["-", ["band", "nir"], ["band", "red"]], ["+", ["band", "nir"], ["band", "red"]]]
 * ["where", ["==", "scl", 6], 1, 0]
 * ["clamp", ["*", 2.5, "b8"], 0, 1]
 * ```
 *
 * @category Expressions
 */
export type ExpressionArray = number | string | [string, ...ExpressionArray[]];

/** Functions available in expressions, with their arity (-1 = variadic, at least 1). */
const FUNCTIONS = {
    abs: 1, sqrt: 1, log: 1, log10: 1, exp: 1, floor: 1, ceil: 1, round: 1, sin: 1, cos: 1, tan: 1, atan: 1,
    atan2: 2, pow: 2, min: -1, max: -1, clamp: 3, where: 3, mean: -1, isnan: 1,
} as const;
/**
 * Names of the functions available in expressions: `abs`, `sqrt`, `log`, `log10`, `exp`, `floor`, `ceil`, `round`,
 * `sin`, `cos`, `tan`, `atan`, `atan2`, `pow`, `min`, `max`, `clamp`, `where`, `mean`, `isnan` (see
 * {@link parseExpression}).
 *
 * @category Expressions
 */
export type FunctionName = keyof typeof FUNCTIONS;

/**
 * Error in an expression, with the character position when known.
 *
 * Thrown by {@link parseExpression}, {@link toExpressionNode} and {@link compileExpression}. Errors in the string
 * grammar have a position, and the message ends with `(at character N)` (1-based); errors in JSON-array expressions
 * and unknown band names have none.
 *
 * @example
 * ```ts
 * try {
 *     parseExpression("(nir - red");
 * } catch (e) {
 *     if (e instanceof ExpressionError) console.log(e.message, e.position); // 'Expected ")" (at character 11)', 10
 * }
 * ```
 *
 * @category Errors
 */
export class ExpressionError extends RiaGeoTiffError {
    /**
     * Creates an expression error.
     *
     * @param message - What is wrong.
     * @param position - 0-based index of the offending character in the expression text, when known.
     */
    constructor(message: string, readonly position?: number) {
        super(position === undefined ? message : `${message} (at character ${position + 1})`,
            [{path: "", severity: "error", message: position === undefined ? message : `${message} (at character ${position + 1})`}]);
        this.name = "ExpressionError";
    }
}

// ------------------------------------------------------------------------------------------- string parser (Pratt)

interface Token { type: "num" | "id" | "op" | "(" | ")" | "," | "end"; value: string; pos: number }

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        const start = i;
        if (/[0-9.]/.test(c)) {
            const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
            if (!m) throw new ExpressionError(`Invalid number`, i);
            tokens.push({type: "num", value: m[0], pos: start});
            i += m[0].length;
        } else if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
            tokens.push({type: "id", value: m[0], pos: start});
            i += m[0].length;
        } else if (c === "(" || c === ")" || c === ",") {
            tokens.push({type: c, value: c, pos: start});
            i++;
        } else {
            const two = src.slice(i, i + 2);
            if (["<=", ">=", "==", "!=", "&&", "||", "**"].includes(two)) {
                tokens.push({type: "op", value: two === "**" ? "^" : two, pos: start});
                i += 2;
            } else if ("+-*/^<>!".includes(c)) {
                tokens.push({type: "op", value: c, pos: start});
                i++;
            } else {
                throw new ExpressionError(`Unexpected character "${c}"`, i);
            }
        }
    }
    tokens.push({type: "end", value: "", pos: src.length});
    return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
    "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "^": 8,
};

/**
 * Parses a string expression into a syntax tree.
 *
 * The grammar is compatible with TiTiler / rio-tiler expressions:
 *
 * **Operands**
 * - Numbers: `12`, `0.5`, `.5`, `5.`, `1e-3`, `2.5E+4`.
 * - `pi`: the constant π.
 * - Any other identifier (`[A-Za-z_][A-Za-z0-9_]*`, case-sensitive) is a band name: `nir`, `b4`, `swir16`. A band
 *   named `pi` cannot be referred to in this form (use `["band", "pi"]`).
 * - Parentheses group: `(nir - red) / (nir + red)`.
 *
 * **Operators**, from lowest to highest precedence (all left-associative except `^`):
 *
 * | Precedence | Operators | Result |
 * | --- | --- | --- |
 * | 1 | `\|\|` | 1 when either side is non-zero (and not NaN), else 0 |
 * | 2 | `&&` | 1 when both sides are non-zero (and not NaN), else 0 |
 * | 3 | `==` `!=` | exact (in)equality: 1 or 0 |
 * | 4 | `<` `<=` `>` `>=` | 1 or 0 |
 * | 5 | `+` `-` | sum, difference |
 * | 6 | `*` `/` | product, quotient |
 * | 7 | unary `-` `!` `+` | negation; `!x` is 1 when x is 0 or NaN, else 0; unary `+` does nothing |
 * | 8 | `^` (or `**`) | power, right-associative: `2 ^ 3 ^ 2` is `2 ^ 9` |
 *
 * Because `^` binds tighter than unary minus, `-x ^ 2` is `-(x ^ 2)`; `2 ^ -1` is 0.5. There is no modulo and no
 * `? :` (use `where`).
 *
 * **Functions** (names are case-insensitive; angles in radians):
 *
 * | Function | Arguments | Result |
 * | --- | --- | --- |
 * | `abs`, `sqrt`, `exp`, `floor`, `ceil`, `round` | 1 | as `Math.*` (`round` rounds halves up) |
 * | `log`, `log10` | 1 | natural and base-10 logarithm |
 * | `sin`, `cos`, `tan`, `atan` | 1 | trigonometry |
 * | `atan2(y, x)`, `pow(x, y)` | 2 | as `Math.atan2`, `Math.pow` |
 * | `min`, `max`, `mean` | 1 or more | smallest, largest, arithmetic mean |
 * | `clamp(x, lo, hi)` | 3 | `min(max(x, lo), hi)` |
 * | `where(cond, a, b)` | 3 | `a` where `cond` is non-zero (and not NaN), else `b` |
 * | `isnan(x)` | 1 | 1 where `x` is NaN (missing data), else 0 |
 *
 * **NaN** marks missing data. Arithmetic and functions propagate it; comparisons with NaN give 0 (`!=` gives 1); the
 * logical operators and `where` treat it as false; `isnan` detects it. See {@link compileExpression} for how results
 * are written.
 *
 * @param src - The expression text, for example `"(nir - red) / (nir + red)"`.
 * @returns The syntax tree. Band names are not checked here (see {@link compileExpression}).
 * @throws {@link ExpressionError} with the `position` of the offending character for an invalid number, an
 *   unexpected character or token, a missing `)`, an unexpected end, an unknown function, or a function called with
 *   the wrong number of arguments.
 *
 * @example
 * ```ts
 * const tree = parseExpression("where(scl == 6, 1, (nir - red) / (nir + red))");
 * expressionBands(tree); // Set {"scl", "nir", "red"}
 * parseExpression("2 ^ 3 ^ 2"); // 2 ^ (3 ^ 2): power is right-associative
 * ```
 *
 * @category Expressions
 */
export function parseExpression(src: string): ExpressionNode {
    const tokens = tokenize(src);
    let p = 0;
    const peek = () => tokens[p];
    const next = () => tokens[p++];
    const expect = (type: Token["type"], what: string) => {
        const t = next();
        if (t.type !== type) throw new ExpressionError(`Expected ${what}`, t.pos);
        return t;
    };

    function prefix(): ExpressionNode {
        const t = next();
        switch (t.type) {
            case "num":
                return {kind: "number", value: Number(t.value)};
            case "id": {
                if (peek().type === "(") {
                    next();
                    const fn = t.value.toLowerCase();
                    if (!(fn in FUNCTIONS)) throw new ExpressionError(`Unknown function "${t.value}"`, t.pos);
                    const args: ExpressionNode[] = [];
                    if (peek().type !== ")") {
                        do args.push(expr(0)); while (peek().type === "," && next());
                    }
                    expect(")", `")" to close ${t.value}(`);
                    return checkCall(fn as FunctionName, args, t.pos);
                }
                if (t.value === "pi") return {kind: "number", value: Math.PI};
                return {kind: "band", name: t.value};
            }
            case "(": {
                const e = expr(0);
                expect(")", `")"`);
                return e;
            }
            case "op":
                if (t.value === "-" || t.value === "!") return {kind: "unary", op: t.value, arg: expr(7)};
                if (t.value === "+") return expr(7);
                break;
        }
        throw new ExpressionError(t.type === "end" ? "Unexpected end of expression" : `Unexpected "${t.value}"`, t.pos);
    }

    function expr(minPrec: number): ExpressionNode {
        let left = prefix();
        for (;;) {
            const t = peek();
            if (t.type !== "op") break;
            const prec = BINARY_PRECEDENCE[t.value];
            if (prec === undefined || prec < minPrec) break;
            next();
            // ^ is right-associative, the others left-associative.
            const right = expr(t.value === "^" ? prec : prec + 1);
            left = {kind: "binary", op: t.value as BinaryOp, left, right};
        }
        return left;
    }

    const tree = expr(0);
    if (peek().type !== "end") throw new ExpressionError(`Unexpected "${peek().value}"`, peek().pos);
    return tree;
}

function checkCall(fn: FunctionName, args: ExpressionNode[], pos?: number): ExpressionNode {
    const arity = FUNCTIONS[fn];
    if ((arity === -1 && args.length < 1) || (arity >= 0 && args.length !== arity)) {
        throw new ExpressionError(`${fn}() takes ${arity === -1 ? "at least 1 argument" : `${arity} argument(s)`}, got ${args.length}`, pos);
    }
    return {kind: "call", fn, args};
}

/**
 * Converts a JSON-array expression into a syntax tree.
 *
 * - A number is a constant.
 * - A string is a band name (`"pi"` is a band here, not π).
 * - `["band", name]` is a band; `["band", 4]` is the band named `b4`.
 * - `["-", x]` is negation and `["!", x]` logical not.
 * - `[op, a, b, ...]` with `op` one of `+ - * / ^ < <= > >= == != && ||` needs at least two operands and folds left:
 *   `["+", a, b, c]` is `(a + b) + c`. (`**` is not accepted here; use `^`.)
 * - `[fn, ...args]` calls a function of {@link parseExpression} (case-insensitive name) with the same arities.
 *
 * Operators and functions behave as in the string grammar.
 *
 * @param expr - The JSON-array expression.
 * @returns The syntax tree. Band names are not checked here.
 * @throws {@link ExpressionError} (without position) for an empty or non-array value, a malformed `["band", ...]`,
 *   an operator with fewer than two operands, an unknown operator or function, or a wrong number of arguments.
 *
 * @category Expressions
 */
export function fromExpressionArray(expr: ExpressionArray): ExpressionNode {
    if (typeof expr === "number") return {kind: "number", value: expr};
    if (typeof expr === "string") return {kind: "band", name: expr};
    if (!Array.isArray(expr) || expr.length === 0) throw new ExpressionError("Invalid expression array");
    const [op, ...rest] = expr;
    if (typeof op !== "string") throw new ExpressionError(`An expression array starts with an operator or function name, not ${JSON.stringify(op)}`);
    if (op === "band") {
        if (rest.length !== 1 || (typeof rest[0] !== "string" && typeof rest[0] !== "number")) {
            throw new ExpressionError(`["band", name] takes one band name`);
        }
        return {kind: "band", name: typeof rest[0] === "number" ? `b${rest[0]}` : rest[0]};
    }
    const args = rest.map(fromExpressionArray);
    if (op === "-" && args.length === 1) return {kind: "unary", op: "-", arg: args[0]};
    if (op === "!" && args.length === 1) return {kind: "unary", op: "!", arg: args[0]};
    if (op in BINARY_PRECEDENCE) {
        if (args.length < 2) throw new ExpressionError(`"${op}" needs at least 2 operands`);
        return args.slice(1).reduce<ExpressionNode>((l, r) => ({kind: "binary", op: op as BinaryOp, left: l, right: r}), args[0]);
    }
    const fn = op.toLowerCase();
    if (!(fn in FUNCTIONS)) throw new ExpressionError(`Unknown operator or function "${op}"`);
    return checkCall(fn as FunctionName, args);
}

/**
 * Parses a string or JSON-array expression.
 *
 * A string whose first non-blank character is `[` is parsed as JSON and then converted as a JSON-array expression;
 * any other string is parsed with the string grammar ({@link parseExpression}); a number or an array is converted
 * directly (see {@link ExpressionArray}).
 *
 * @param expr - The expression: string grammar, JSON-array text, or a JSON-array value.
 * @returns The syntax tree.
 * @throws {@link ExpressionError} when the expression is invalid (with a position for the string grammar).
 *   A string starting with `[` that is not valid JSON also gives an {@link ExpressionError}.
 *
 * @example
 * ```ts
 * toExpressionNode("(nir - red) / (nir + red)");
 * toExpressionNode('["/", ["-", "nir", "red"], ["+", "nir", "red"]]'); // same tree
 * toExpressionNode(["/", ["-", "nir", "red"], ["+", "nir", "red"]]);   // same tree
 * ```
 *
 * @category Expressions
 */
export function toExpressionNode(expr: string | ExpressionArray): ExpressionNode {
    if (typeof expr === "string" && !/^\s*\[/.test(expr)) return parseExpression(expr);
    let value: ExpressionArray;
    if (typeof expr === "string") {
        try {
            value = JSON.parse(expr) as ExpressionArray;
        } catch (e) {
            throw new ExpressionError(`Invalid JSON expression: ${(e as Error).message}`);
        }
    } else {
        value = expr;
    }
    return fromExpressionArray(value);
}

/**
 * Band names an expression refers to.
 *
 * @param node - The syntax tree.
 * @param into - Set to add the names to. Default: a new set.
 * @returns `into`, with every band name used in `node` added (each once).
 *
 * @example
 * ```ts
 * expressionBands(parseExpression("(nir - red) / (nir + red)")); // Set {"nir", "red"}
 * ```
 *
 * @category Expressions
 */
export function expressionBands(node: ExpressionNode, into = new Set<string>()): Set<string> {
    switch (node.kind) {
        case "band": into.add(node.name); break;
        case "unary": expressionBands(node.arg, into); break;
        case "binary": expressionBands(node.left, into); expressionBands(node.right, into); break;
        case "call": node.args.forEach((a) => expressionBands(a, into)); break;
    }
    return into;
}

// ------------------------------------------------------------------------------------------- evaluation

/**
 * Input arrays by band name; NaN marks missing data. Each array referenced by an expression must hold at least `n`
 * values, the number of pixels evaluated.
 *
 * @category Expressions
 */
export type BandArrays = Record<string, Float32Array>;

/**
 * A compiled expression: writes results for `n` pixels into `out` (NaN where an input is NaN or the result is).
 *
 * Pixel `i` is computed from `bands[name][i]` for every band the expression uses and written to `out[i]`; `out` must
 * hold at least `n` values. Results that are NaN or infinite are written as NaN. Returns nothing.
 *
 * @category Expressions
 */
export type CompiledExpression = (bands: BandArrays, n: number, out: Float32Array) => void;

function jsOf(node: ExpressionNode, ids: Map<string, string>): string {
    switch (node.kind) {
        // Infinite literals (1e999) stay infinite inside the expression, as in the vectorised interpreter:
        // `${Infinity}` is the JavaScript literal Infinity. Only a final infinite result becomes NaN. Anything but a
        // number (a hand-made tree) never reaches the generated code.
        case "number": return typeof node.value === "number" ? `(${node.value})` : "NaN";
        case "band": return `${ids.get(node.name)}[i]`;
        case "unary": return node.op === "-" ? `(-${jsOf(node.arg, ids)})` : `(${jsOf(node.arg, ids)} ? 0 : 1)`;
        case "binary": {
            const l = jsOf(node.left, ids), r = jsOf(node.right, ids);
            switch (node.op) {
                case "^": return `Math.pow(${l}, ${r})`;
                case "&&": return `((${l}) && (${r}) ? 1 : 0)`;
                case "||": return `((${l}) || (${r}) ? 1 : 0)`;
                case "==": return `(${l} === ${r} ? 1 : 0)`;
                case "!=": return `(${l} !== ${r} ? 1 : 0)`;
                case "<": case "<=": case ">": case ">=": return `(${l} ${node.op} ${r} ? 1 : 0)`;
                default: return `(${l} ${node.op} ${r})`;
            }
        }
        case "call": {
            const a = node.args.map((x) => jsOf(x, ids));
            switch (node.fn) {
                case "clamp": return `Math.min(Math.max(${a[0]}, ${a[1]}), ${a[2]})`;
                case "where": return `(${a[0]} ? ${a[1]} : ${a[2]})`;
                case "mean": return `((${a.join(" + ")}) / ${a.length})`;
                case "isnan": return `(${a[0]} !== ${a[0]} ? 1 : 0)`;
                default: return `Math.${node.fn}(${a.join(", ")})`;
            }
        }
    }
}

let functionConstructorAllowed: boolean | undefined;

/**
 * Whether `new Function` may be used (false under a Content Security Policy without 'unsafe-eval').
 *
 * Tested once, on the first call; the answer is cached.
 *
 * @returns `true` when code generation is allowed.
 *
 * @category Expressions
 */
export function canCompile(): boolean {
    if (functionConstructorAllowed === undefined) {
        try {
            functionConstructorAllowed = new Function("return 1")() === 1;
        } catch {
            functionConstructorAllowed = false;
        }
    }
    return functionConstructorAllowed;
}

/**
 * Compiles an expression for evaluation over whole tiles. `bandNames` lists the names allowed in the expression;
 * an unknown name is an error. `mode` forces a strategy (default: compiled when allowed, else vectorised).
 *
 * Strings are parsed with {@link toExpressionNode} (see {@link parseExpression} for the grammar, functions and NaN
 * rules); a syntax tree is used as is.
 *
 * Evaluation strategies, which give the same results (both compute in 64-bit floats, and both keep an infinite
 * literal such as `1e999` infinite until the final result):
 * - `"compiled"`: the validated tree is turned into a specialised JavaScript loop with `new Function`. Only band
 *   names that passed validation, numbers and whitelisted operators and functions reach the generated code. If
 *   `new Function` throws (a Content Security Policy without `'unsafe-eval'`), the vectorised interpreter is used
 *   instead.
 * - `"vectorised"`: an interpreter that applies each node to whole arrays, about 4x slower, no code generation.
 * - `"auto"` (default): compiled when `new Function` is allowed (`canCompile()`), else vectorised.
 *
 * Results are stored as 32-bit floats; results that are NaN, `Infinity` or `-Infinity` (for example a division by
 * zero) are written as NaN, so they read as missing data.
 *
 * @param expression - The expression: string grammar, JSON-array text or value, or a syntax tree.
 * @param bandNames - The band names the expression may use (for example the bands of the dataset).
 * @param mode - The evaluation strategy: `"auto"` (default), `"compiled"` or `"vectorised"`.
 * @returns A function `(bands, n, out) => void` that writes the results for `n` pixels into `out`.
 * @throws {@link ExpressionError} when the expression is invalid (see {@link parseExpression}), when a string
 *   starting with `[` is not valid JSON or not a valid JSON-array expression (for example when its first element is
 *   not an operator name), or when it uses a band that is not in `bandNames` (no position; the message lists the
 *   available names).
 *
 * @example
 * ```ts
 * const ndvi = compileExpression("(nir - red) / (nir + red)", ["red", "nir"]);
 * const out = new Float32Array(2);
 * ndvi({red: new Float32Array([0.1, NaN]), nir: new Float32Array([0.5, 0.4])}, 2, out);
 * // out ≈ [0.667, NaN]
 * ```
 *
 * @category Expressions
 */
export function compileExpression(
    expression: string | ExpressionArray | ExpressionNode,
    bandNames: Iterable<string>,
    mode: "auto" | "compiled" | "vectorised" = "auto",
): CompiledExpression {
    const node = typeof expression === "object" && !Array.isArray(expression) && "kind" in expression
        ? expression
        : toExpressionNode(expression as string | ExpressionArray);
    const allowed = new Set(bandNames);
    const used = [...expressionBands(node)];
    for (const name of used) {
        if (!allowed.has(name)) throw new ExpressionError(`Unknown band "${name}". Available: ${[...allowed].join(", ")}`);
    }
    if (mode === "vectorised" || (mode === "auto" && !canCompile())) return vectorised(node);

    const ids = new Map(used.map((name, i) => [name, `v${i}`]));
    const loads = used.map((name, i) => `const v${i} = bands[${JSON.stringify(name)}];`).join("\n");
    const body = `${loads}\nfor (let i = 0; i < n; i++) { const r = ${jsOf(node, ids)}; out[i] = (r === r && r !== Infinity && r !== -Infinity) ? r : NaN; }`;
    try {
        return new Function("bands", "n", "out", body) as CompiledExpression;
    } catch {
        return vectorised(node);
    }
}

/** Vectorised interpreter: each node is evaluated over whole arrays (no code generation). */
function vectorised(node: ExpressionNode): CompiledExpression {
    return (bands, n, out) => {
        const result = evalVec(node, bands, n);
        for (let i = 0; i < n; i++) {
            const r = result[i];
            out[i] = r === r && r !== Infinity && r !== -Infinity ? r : NaN;
        }
    };
}

function evalVec(node: ExpressionNode, bands: BandArrays, n: number): Float64Array {
    // Float64 intermediates, like the compiled code, so both strategies give the same results.
    switch (node.kind) {
        case "number": return new Float64Array(n).fill(node.value);
        case "band": return Float64Array.from(bands[node.name].subarray(0, n));
        case "unary": {
            const a = evalVec(node.arg, bands, n);
            if (node.op === "-") for (let i = 0; i < n; i++) a[i] = -a[i];
            else for (let i = 0; i < n; i++) a[i] = a[i] ? 0 : 1;
            return a;
        }
        case "binary": {
            const a = evalVec(node.left, bands, n), b = evalVec(node.right, bands, n);
            const op = node.op;
            for (let i = 0; i < n; i++) a[i] = binary(op, a[i], b[i]);
            return a;
        }
        case "call": {
            const args = node.args.map((x) => evalVec(x, bands, n));
            const r = args[0];
            for (let i = 0; i < n; i++) r[i] = call(node.fn, args.map((x) => x[i]));
            return r;
        }
    }
}

function binary(op: BinaryOp, a: number, b: number): number {
    switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
        case "&&": return a && b ? 1 : 0;
        case "||": return a || b ? 1 : 0;
    }
}

function call(fn: FunctionName, a: number[]): number {
    switch (fn) {
        case "clamp": return Math.min(Math.max(a[0], a[1]), a[2]);
        case "where": return a[0] ? a[1] : a[2];
        case "mean": return a.reduce((s, v) => s + v, 0) / a.length;
        case "isnan": return a[0] !== a[0] ? 1 : 0;
        case "min": return Math.min(...a);
        case "max": return Math.max(...a);
        case "atan2": return Math.atan2(a[0], a[1]);
        case "pow": return Math.pow(a[0], a[1]);
        default: return (Math[fn] as (x: number) => number)(a[0]);
    }
}

/**
 * Formats a syntax tree back into the string grammar (for UIs and serialisation).
 *
 * Every binary operation is wrapped in parentheses, so the text parses back to an equivalent expression (a band
 * named `pi` would read back as the constant π); function names are lower case.
 *
 * @param node - The syntax tree.
 * @returns The expression text, for example `((nir - red) / (nir + red))`.
 *
 * @example
 * ```ts
 * formatExpression(toExpressionNode(["/", ["-", "nir", "red"], 2])); // "((nir - red) / 2)"
 * ```
 *
 * @category Expressions
 */
export function formatExpression(node: ExpressionNode): string {
    switch (node.kind) {
        case "number": return String(node.value);
        case "band": return node.name;
        case "unary": return `${node.op}${formatExpression(node.arg)}`;
        case "binary": return `(${formatExpression(node.left)} ${node.op} ${formatExpression(node.right)})`;
        case "call": return `${node.fn}(${node.args.map(formatExpression).join(", ")})`;
    }
}
