#!/usr/bin/env bash
# Builds demo/public/data/worldclim-tavg-10m.tif: WorldClim 2.1 average monthly temperature (1970-2000, 10 arc
# minutes, °C) as ONE 12-band Cloud Optimized GeoTIFF with band descriptions Jan..Dec, so the demo can select months
# by name and animate them. Needs GDAL (gdalbuildvrt, gdal_translate) and its Python bindings.
#
# Source: Fick, S.E. and R.J. Hijmans, 2017. WorldClim 2: new 1km spatial resolution climate surfaces for global land
# areas. International Journal of Climatology 37 (12): 4302-4315. https://www.worldclim.org (free for non-commercial use)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/public/data"
work="$data/downloads/worldclim"
mkdir -p "$work"
if [ ! -f "$work/wc2.1_10m_tavg_01.tif" ]; then
    curl -sSL -o "$work/wc2.1_10m_tavg.zip" https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_tavg.zip
    (cd "$work" && unzip -o -q wc2.1_10m_tavg.zip)
fi
gdalbuildvrt -q -separate "$work/tavg.vrt" "$work"/wc2.1_10m_tavg_{01,02,03,04,05,06,07,08,09,10,11,12}.tif
python3 - "$work/tavg.vrt" <<'PY'
import sys
from osgeo import gdal
gdal.UseExceptions()
ds = gdal.Open(sys.argv[1], gdal.GA_Update)
for i, name in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]):
    ds.GetRasterBand(i + 1).SetDescription(name)
ds = None
PY
gdal_translate -q "$work/tavg.vrt" "$data/worldclim-tavg-10m.tif" -of COG \
    -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BLOCKSIZE=256 -co OVERVIEW_RESAMPLING=AVERAGE -co INTERLEAVE=BAND
echo "wrote $data/worldclim-tavg-10m.tif ($(du -h "$data/worldclim-tavg-10m.tif" | cut -f1))"
