#!/opt/homebrew/bin/python3
"""Regenerates the small COG fixtures used by the unit tests (needs GDAL's Python bindings).

Heights are analytic so the tests know the exact expected value anywhere:
  plane(x, y) = 100 + 0.01 * (x - X0) - 0.02 * (y - Y0)   (metres; x, y in the file's CRS)
Bilinear interpolation reproduces a plane exactly, and averaging overviews keep it a plane.
"""
import os
import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, array, epsg, origin, res, nodata=None, dtype=gdal.GDT_Float32, point=False, scale=None, offset=None,
          photometric=None, blocksize=64, overview_resampling="AVERAGE"):
    bands = 1 if array.ndim == 2 else array.shape[0]
    h, w = array.shape[-2:]
    mem = gdal.GetDriverByName("MEM").Create("", w, h, bands, dtype)
    mem.SetGeoTransform([origin[0], res, 0, origin[1], 0, -res])
    srs = osr.SpatialReference(); srs.ImportFromEPSG(epsg); mem.SetProjection(srs.ExportToWkt())
    if point:
        mem.SetMetadataItem("AREA_OR_POINT", "Point")
    for b in range(bands):
        band = mem.GetRasterBand(b + 1)
        band.WriteArray(array if bands == 1 else array[b])
        if nodata is not None:
            band.SetNoDataValue(nodata)
        if scale is not None:
            band.SetScale(scale)
        if offset is not None:
            band.SetOffset(offset)
        if photometric == "RGB":
            band.SetColorInterpretation([gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand][b])
    opts = [f"BLOCKSIZE={blocksize}", "COMPRESS=DEFLATE", f"OVERVIEW_RESAMPLING={overview_resampling}", "OVERVIEWS=AUTO"]
    gdal.Translate(os.path.join(HERE, name), mem, format="COG", creationOptions=opts)
    print(name, w, h, os.path.getsize(os.path.join(HERE, name)), "bytes")


def plane(w, h, origin, res, area=True):
    off = 0.5 if area else 0.0
    xs = origin[0] + (np.arange(w) + off) * res
    ys = origin[1] - (np.arange(h) + off) * res
    X, Y = np.meshgrid(xs, ys)
    return 100 + 0.01 * (X - origin[0]) - 0.02 * (Y - origin[1])


# 1. Float32 elevation in EPSG:3857, 300 x 200 pixels of 30 m, a nodata hole, 64 x 64 blocks + overviews.
o = (1000000.0, 6000000.0)
z = plane(300, 200, o, 30.0).astype(np.float32)
z[80:100, 120:140] = -9999
write("elevation-3857-float32.tif", z, 3857, o, 30.0, nodata=-9999)

# 2. Int16 elevation in EPSG:4326 stored with scale/offset (decimetres + 1000 m), declared as PixelIsPoint.
o4 = (5.0, 52.0)
zz = plane(256, 128, (0, 0), 1.0, area=False)                 # 100 .. ~ 105 m: plain function of pixel index
raw = np.round((zz - 1000.0) / 0.1).astype(np.int16)          # value = raw * 0.1 + 1000
write("elevation-4326-int16-scaled.tif", raw, 4326, o4, 0.001, dtype=gdal.GDT_Int16, point=True, scale=0.1,
      offset=1000.0, overview_resampling="NEAREST")

# 3. RGB 8-bit imagery: red ramp in x, green ramp in y, blue constant.
w, h = 128, 96
r = np.tile((np.arange(w) * 2).astype(np.uint8), (h, 1))
g = np.tile((np.arange(h) * 255 // (h - 1)).astype(np.uint8)[:, None], (1, w))
b = np.full((h, w), 77, np.uint8)
write("rgb-3857-uint8.tif", np.stack([r, g, b]), 3857, o, 10.0, dtype=gdal.GDT_Byte, photometric="RGB")

# 4. Single-band UInt16 without nodata (regression: must render as RGB_888, 3 bytes per pixel).
u = (np.arange(128 * 128, dtype=np.uint32) % 65536).reshape(128, 128).astype(np.uint16)
write("gray-3857-uint16.tif", u, 3857, o, 10.0, dtype=gdal.GDT_UInt16)

# 5. The plane of fixture 1 split into two adjacent COGs (west / east halves): a mosaic must match the single file.
for name, x0 in (("west", 0), ("east", 150)):
    half = gdal.Translate("", os.path.join(HERE, "elevation-3857-float32.tif"), format="MEM", srcWin=[x0, 0, 150, 200])
    gdal.Translate(os.path.join(HERE, f"elevation-3857-float32-{name}.tif"), half, format="COG",
                   creationOptions=["BLOCKSIZE=64", "COMPRESS=DEFLATE", "OVERVIEW_RESAMPLING=AVERAGE", "OVERVIEWS=IGNORE_EXISTING"])
    print(f"elevation-3857-float32-{name}.tif", os.path.getsize(os.path.join(HERE, f"elevation-3857-float32-{name}.tif")), "bytes")
