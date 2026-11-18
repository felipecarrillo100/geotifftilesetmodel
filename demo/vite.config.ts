import {cpSync, createReadStream, existsSync, statSync} from "node:fs";
import {dirname, join, normalize, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig, type Plugin} from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/**
 * Serves a folder under a URL prefix with HTTP Range support, like a COG host would.
 * Used for the unit-test fixtures (/fixtures/...: COGs, the static STAC catalog, a manifest) and local demo data (/data/...).
 */
function rangeFolder(prefix: string, folder: string): Plugin {
    return {
        name: `range-folder${prefix}`,
        configureServer(server) {
            server.middlewares.use(prefix, (req, res, next) => {
                const path = normalize(join(folder, decodeURIComponent((req.url ?? "/").split("?")[0])));
                if (!path.startsWith(folder) || !existsSync(path) || statSync(path).isDirectory()) return next();
                const size = statSync(path).size;
                const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
                res.setHeader("Accept-Ranges", "bytes");
                res.setHeader("Content-Type", /\.json$/i.test(path) ? "application/json" : /\.tiff?$/i.test(path) ? "image/tiff" : "application/octet-stream");
                if (match) {
                    const start = Number(match[1]);
                    const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
                    res.statusCode = 206;
                    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
                    res.setHeader("Content-Length", end - start + 1);
                    createReadStream(path, {start, end}).pipe(res);
                } else {
                    res.setHeader("Content-Length", size);
                    createReadStream(path).pipe(res);
                }
            });
        },
    };
}

/** Shoelace's icons and other assets under /shoelace (setBasePath("/shoelace")), in dev and in the build. */
function shoelaceAssets(): Plugin {
    const dist = resolve(repo, "node_modules/@shoelace-style/shoelace/dist");
    return {
        name: "shoelace-assets",
        configureServer(server) {
            server.middlewares.use("/shoelace", (req, res, next) => {
                const path = normalize(join(dist, decodeURIComponent((req.url ?? "/").split("?")[0])));
                if (!path.startsWith(join(dist, "assets")) || !existsSync(path)) return next();
                res.setHeader("Content-Type", path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream");
                createReadStream(path).pipe(res);
            });
        },
        closeBundle() {
            cpSync(join(dist, "assets"), resolve(here, "dist/shoelace/assets"), {recursive: true});
        },
    };
}

export default defineConfig({
    root: here,
    // The demo imports the library from its sources, so it always tests the code in src/.
    resolve: {
        alias: [
            {find: /^ria-geotiff\/ramps$/, replacement: resolve(repo, "src/rs/ramps.ts")},
            {find: /^ria-geotiff\/presets$/, replacement: resolve(repo, "src/rs/presets.ts")},
            {find: /^ria-geotiff\/stac$/, replacement: resolve(repo, "src/stac/index.ts")},
            {find: /^ria-geotiff$/, replacement: resolve(repo, "src/index.ts")},
        ],
        // One LuciadRIA for the demo and the library: two copies would conflict (license, singletons).
        dedupe: ["@luciad/ria"],
    },
    appType: "mpa", // missing files are 404s, not index.html
    plugins: [
        rangeFolder("/fixtures", resolve(repo, "test/fixtures")),
        rangeFolder("/data", resolve(here, "public/data")),
        shoelaceAssets(),
    ],
    server: {
        port: 5299, strictPort: true, fs: {allow: [repo]},
        // INPE's Brazil Data Cube serves COGs with range requests but without CORS headers, so a browser page on
        // another origin may not read them. The dev server relays the same range requests live (nothing is
        // stored); an application needs an equivalent CORS proxy of its own.
        proxy: {"/inpe": {target: "https://data.inpe.br", changeOrigin: true, rewrite: (path) => path.replace(/^\/inpe/, "")}},
    },
    build: {
        target: "es2022", outDir: resolve(here, "dist"), emptyOutDir: true,
        rollupOptions: {input: {studio: resolve(here, "studio.html"), classic: resolve(here, "index.html")}},
    },
    esbuild: {target: "es2022"},
    optimizeDeps: {esbuildOptions: {target: "es2022"}},
});
