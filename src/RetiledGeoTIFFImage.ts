import {GeoTIFFImage, Pool} from "geotiff";

export class RetiledGeoTIFFImage extends GeoTIFFImage {

    private _image: GeoTIFFImage;
    private _tileSize: number;
    private _tileCache: Map<number, any>;

    constructor(image: GeoTIFFImage) {
        const newFileDirectory = {...image.fileDirectory};
        delete newFileDirectory.RowsPerStrip;
        delete newFileDirectory.StripByteCounts;
        delete newFileDirectory.StripOffsets;
        super(newFileDirectory, image.geoKeys, image.dataView, image.littleEndian, true, image.source);
        this._image = image;
        const calculateNewTileSize = (imageSize: number) => Math.min(512, Math.pow(2, Math.floor(Math.log2(imageSize))));
        const possibleNewTileWidth = calculateNewTileSize(image.getWidth());
        const possibleNewTileHeight = calculateNewTileSize(image.getHeight());
        this._tileSize = Math.min(possibleNewTileWidth, possibleNewTileHeight);
        this.isTiled = true;
        this._tileCache = new Map();
    }

    getTileWidth(): number {
        return this._tileSize;
    }

    getTileHeight(): number {
        return this._tileSize;
    }

    async getTileOrStrip(x: number, y: number, sample: number, pool: Pool, signal?: AbortSignal | undefined): Promise<ArrayBuffer> {
        const numTilesPerRow = Math.ceil(this.getWidth() / this.getTileWidth());
        const numTilesPerCol = Math.ceil(this.getHeight() / this.getTileHeight());
        let index: number;
        if (this.planarConfiguration === 1) {
            index = (y * numTilesPerRow) + x;
        } else if (this.planarConfiguration === 2) {
            index = (sample * numTilesPerRow * numTilesPerCol) + (y * numTilesPerRow) + x;
        }

        const cachedTile = this._tileCache.get(index!);
        if (cachedTile) {
            return cachedTile;
        }

        const tileOffsetX = this.getTileWidth() * x;
        const tileOffsetY = this.getTileHeight() * y;
        const window = [tileOffsetX, tileOffsetY, tileOffsetX + this.getTileWidth(), tileOffsetY + this.getTileHeight()];

        const samples = [];
        let interleave = true;
        if (this.planarConfiguration === 1) {
            for (let i = 0; i < this.getSamplesPerPixel(); i++) {
                samples.push(i);
            }
        } else {
            samples.push(sample);
            interleave = false;
        }

        const dataResult = await this._image.readRasters({window, samples, interleave, pool, signal});

        const data = Array.isArray(dataResult) ? dataResult[0] : dataResult;

        const arrayBuffer = new ArrayBuffer(data.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        uint8Array.set(data);

        const tile = { x, y, sample, data: arrayBuffer };
        this._tileCache.set(index!, tile);

        // @ts-ignore
        return tile;
    }

}
