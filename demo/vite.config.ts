import {createReadStream, existsSync, statSync} from "node:fs";
import {dirname, join, normalize, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig, type Plugin} from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/**
 * Serves a folder under a URL prefix with HTTP Range support, like a COG host would.
 * Used for the unit-test fixtures (/fixtures/...) and local demo data (/data/...).
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
                res.setHeader("Content-Type", "image/tiff");
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

export default defineConfig({
    root: here,
    // The demo imports the library from its sources, so it always tests the code in src/.
    resolve: {
        alias: {"ria-geotiff": resolve(repo, "src/index.ts")},
        // One LuciadRIA for the demo and the library: two copies would conflict (license, singletons).
        dedupe: ["@luciad/ria"],
    },
    appType: "mpa", // missing files are 404s, not index.html
    plugins: [
        rangeFolder("/fixtures", resolve(repo, "test/fixtures")),
        rangeFolder("/data", resolve(here, "public/data")),
    ],
    server: {port: 5299, strictPort: true, fs: {allow: [repo]}},
    build: {target: "es2022", outDir: resolve(here, "dist"), emptyOutDir: true},
    esbuild: {target: "es2022"},
    optimizeDeps: {esbuildOptions: {target: "es2022"}},
});
