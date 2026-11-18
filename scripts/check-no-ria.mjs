// Fails when the build output contains LuciadRIA code. LuciadRIA must never be embedded in this library: the vendor
// does not allow redistributing it, and a second copy in an application causes license conflicts.
// It is a peerDependency: lib/ may only *import* "@luciad/ria/...", never contain its code.
//
// Three independent checks, so neither copied RIA files nor a bundler inlining RIA can slip through:
//   1. lib/ holds exactly the outputs of src/ (X.ts -> X.js, X.d.ts and their maps), nothing else;
//   2. no RIA fingerprints (its error names, its rendering engine, its module paths, its license internals);
//   3. no unexpectedly large file (RIA modules and bundles are far bigger than anything this library emits).
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lib = join(root, "lib");
const src = join(root, "src");
const MAX_BYTES = 200 * 1024;
const fingerprints = [
    [/luciad\.error\./, "LuciadRIA error names"],
    [/\bphoton[_A-Za-z]*\.js|PhotonWorker|gen\/photon/i, "LuciadRIA's photon engine"],
    [/node_modules[\\/]@luciad[\\/]ria/, "an inlined @luciad/ria module path"],
    [/Copyright[^\n]{0,60}(Luciad|Hexagon)/i, "a LuciadRIA copyright banner"],
    [/\bLicenseError\b|_licenseText|checkLicense/, "LuciadRIA licensing internals"],
];

const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
});

let files;
try { files = walk(lib); } catch { console.error("check-no-ria: lib/ not found, run the build first"); process.exit(1); }

const expected = new Set(walk(src).filter((f) => f.endsWith(".ts")).flatMap((f) => {
    const base = relative(src, f).replace(/\.ts$/, "");
    return [`${base}.js`, `${base}.js.map`, `${base}.d.ts`, `${base}.d.ts.map`];
}));

const problems = [];
for (const file of files) {
    const rel = relative(lib, file);
    if (!expected.has(rel)) problems.push(`${rel}: not produced from src/ (copied or bundled file?)`);
    const size = statSync(file).size;
    if (size > MAX_BYTES) problems.push(`${rel}: ${size} bytes, larger than anything src/ produces`);
    const text = readFileSync(file, "utf8");
    for (const [pattern, what] of fingerprints) {
        if (pattern.test(text)) problems.push(`${rel}: contains ${what} (${pattern})`);
    }
    if (!rel.endsWith(".map")) {
        for (const line of text.split("\n")) {
            if (line.includes("@luciad/ria") && !/(from|import\(|import)\s*["']@luciad\/ria\//.test(line)) {
                problems.push(`${rel}: @luciad/ria referenced outside an import: ${line.trim().slice(0, 100)}`);
            }
        }
    }
}

if (problems.length) {
    console.error("check-no-ria: LuciadRIA code may be embedded in lib/ (it must stay a peerDependency):\n  "
        + problems.join("\n  "));
    process.exit(1);
}
console.log(`check-no-ria: OK, ${files.length} files in lib/, all from src/, RIA only imported`);
