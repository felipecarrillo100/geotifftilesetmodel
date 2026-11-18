#!/usr/bin/env bash
# Converts any elevation raster GDAL can read (GeoTIFF, HGT, DTED, ASC, VRT, ...) into a Cloud Optimized GeoTIFF
# that ria-geotiff serves to LuciadRIA as terrain (dataType: RasterDataType.ELEVATION).
#
# The library does the per-sample work in the browser (LuciadFusion-style 64 x 64 point-sampled tiles, nodata,
# scale/offset, type conversion), so this script only does what needs the whole dataset:
#   - optional reprojection (only needed when LuciadRIA does not know the source CRS, or to standardise);
#   - single band Float32 with an explicit nodata value;
#   - COG layout: 256 x 256 tiles, DEFLATE + floating point predictor, a full pyramid of averaged overviews
#     (existing overviews of the input are ignored: mosaics of tiles would otherwise keep only one level).
#
# Usage:
#   scripts/elevation-to-cog.sh INPUT OUTPUT.tif [--t-srs EPSG:3857] [--nodata -9999] [--band 1] [--resampling bilinear]
#
# Several input files: build a mosaic first, e.g.  gdalbuildvrt mosaic.vrt tiles/*.tif  and pass mosaic.vrt.
# Heights must be in metres. The vertical datum is not changed (LuciadRIA treats heights as above the geoid).
set -euo pipefail

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
[[ $# -lt 2 || "$1" == "-h" || "$1" == "--help" ]] && usage $(( $# < 2 ))

input=$1; output=$2; shift 2
t_srs=""; nodata="-9999"; band="1"; resampling="bilinear"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --t-srs) t_srs=$2; shift 2 ;;
    --nodata) nodata=$2; shift 2 ;;
    --band) band=$2; shift 2 ;;
    --resampling) resampling=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

command -v gdal_translate >/dev/null || { echo "GDAL is required (gdal_translate, gdalwarp)" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# 1. One Float32 band with an explicit nodata value (keeps the source's nodata, maps it to --nodata).
gdal_translate -q -b "$band" -ot Float32 -a_nodata "$nodata" -of VRT "$input" "$tmp/band.vrt"
source="$tmp/band.vrt"

# 2. Optional reprojection.
if [[ -n "$t_srs" ]]; then
  gdalwarp -q -t_srs "$t_srs" -r "$resampling" -ot Float32 -dstnodata "$nodata" -of VRT \
    -multi -wo NUM_THREADS=ALL_CPUS "$source" "$tmp/warped.vrt"
  source="$tmp/warped.vrt"
fi

# 3. Cloud Optimized GeoTIFF.
gdal_translate -q -of COG "$source" "$output" \
  -co BLOCKSIZE=256 -co COMPRESS=DEFLATE -co PREDICTOR=FLOATING_POINT -co LEVEL=9 \
  -co OVERVIEWS=IGNORE_EXISTING -co OVERVIEW_RESAMPLING=AVERAGE -co RESAMPLING="$resampling" \
  -co BIGTIFF=IF_SAFER -co NUM_THREADS=ALL_CPUS -co STATISTICS=YES

gdalinfo "$output" | grep -E 'Size is|Coordinate System is|PROJCRS|GEOGCRS|Pixel Size|Block=|Overviews|NoData|LAYOUT' | head -12
echo "Wrote $output"
