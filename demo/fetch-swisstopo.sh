#!/usr/bin/env bash
# Downloads swisstopo open data for an area and builds the demo's COGs in demo/public/data (git-ignored):
#   <name>-elevation.tif  swissALTI3D (2 m), Float32 COG, made with scripts/elevation-to-cog.sh
#   <name>-imagery.tif    SWISSIMAGE (2 m), RGB JPEG COG
#
# Usage: demo/fetch-swisstopo.sh [name] [E_min N_min E_max N_max]   (LV95 kilometres, inclusive)
# Default: Zermatt and the Matterhorn, E 2616-2625, N 1091-1098 (about 10 x 8 km, ~70 MB of downloads).
# Data: (c) swisstopo, free use with attribution. Needs GDAL and python3.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${1:-zermatt}; e0=${2:-2616}; n0=${3:-1091}; e1=${4:-2625}; n1=${5:-1098}
out="$here/public/data"; cache="$out/.cache-$name"; mkdir -p "$cache/alti" "$cache/image"

# One file per km tile, the most recent edition, from swisstopo's STAC API (asset with ground sampling 2 m).
python3 - "$e0" "$n0" "$e1" "$n1" "$cache" <<'EOF'
import json, sys, urllib.request
e0, n0, e1, n1, cache = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
base = "https://data.geo.admin.ch/api/stac/v0.9/collections"
# LV95 km -> WGS84 bbox (approximate, padded; tiles outside the LV95 range are filtered below)
def lv95_to_wgs84(E, N):
    y, x = (E - 2600000) / 1e6, (N - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lon * 100 / 36, lat * 100 / 36
lo0, la0 = lv95_to_wgs84(e0 * 1000, n0 * 1000)
lo1, la1 = lv95_to_wgs84((e1 + 1) * 1000, (n1 + 1) * 1000)
bbox = f"{lo0 - 0.01},{la0 - 0.01},{lo1 + 0.01},{la1 + 0.01}"
for collection, folder in [("ch.swisstopo.swissalti3d", "alti"), ("ch.swisstopo.swissimage-dop10", "image")]:
    url, best = f"{base}/{collection}/items?bbox={bbox}&limit=100", {}
    while url:
        page = json.load(urllib.request.urlopen(url, timeout=60))
        for item in page["features"]:
            year, tile = item["id"].split("_")[-2:]           # e.g. swissalti3d_2019_2617-1091
            e, n = map(int, tile.split("-"))
            if not (e0 <= e <= e1 and n0 <= n <= n1):
                continue
            for asset in item["assets"].values():
                if asset.get("eo:gsd") == 2.0 and asset["href"].endswith(".tif"):
                    if tile not in best or year > best[tile][0]:
                        best[tile] = (year, asset["href"])
        url = next((l["href"] for l in page.get("links", []) if l["rel"] == "next"), None)
    with open(f"{cache}/{folder}.txt", "w") as f:
        f.write("\n".join(href for _, href in sorted(best.values(), key=lambda v: v[1])) + "\n")
    print(f"{collection}: {len(best)} tiles")
EOF

for folder in alti image; do
  (cd "$cache/$folder" && xargs -n 1 -P 8 curl -sSfLO -C - < "../$folder.txt")
done

gdalbuildvrt -q "$cache/alti.vrt" "$cache"/alti/*.tif
gdalbuildvrt -q "$cache/image.vrt" "$cache"/image/*.tif
"$here/../scripts/elevation-to-cog.sh" "$cache/alti.vrt" "$out/$name-elevation.tif"
gdal_translate -q -of COG "$cache/image.vrt" "$out/$name-imagery.tif" \
  -co BLOCKSIZE=256 -co COMPRESS=JPEG -co QUALITY=85 -co OVERVIEWS=IGNORE_EXISTING -co OVERVIEW_RESAMPLING=AVERAGE
ls -la "$out/$name-elevation.tif" "$out/$name-imagery.tif"
echo "Open http://localhost:5299/?elevation=/data/$name-elevation.tif&imagery=/data/$name-imagery.tif"
