# GeoTiffTilesetModel prototype for LuciadRIA 

## Description
The GeoTiffTilesetModel package provides Cloud Optimized geotiff  capabilities to a LuciadRIA Application.

Implements
* __Implements GeoTiffTileSetModel__
* __Adds infoFromUrl methods__ 
* __Extends RasterTilesetModel calculate tiles from a Cloud Optimized GeoTiff URL__

The Main Components are:

* __GeoTiffTileSetModel__: a ready to use LuciadRIA RasterTilesetModel to decode Cloud Optimized GeoTiffs


## To build
This is the source code that produces a library delivered as a npm package. 
To build the source code use the npm scripts:
```
npm install
npm run build
```
Then you can publish the package to npm or other repository

## To test
Some test have been added that runs using nodejs using Jest. No browser test is available at the moment.
The test uses isomorphic-fetch to provide fetch in node testing with jest.
```
npm run test
```
Test use the sever-side implementations, use GeoServer of LuciadFusion 


## To install

Simply import the NPM package into your project

```
npm install ria-geotiff
```

## To use in your project
 
### To retrieve any information available from the Geotiff 
```typescript
import {GeoTiffTileSetModel} from "ria-geotiff/lib/GeoTiffTileSetModel";

const url = "https://example.com/geotiff.tif";

GeoTiffTileSetModel.infoFromURL(url, options)
.then((info) => {
    console.log("GeoTIFF Info:", info);
})
.catch((error) => {
    console.error("Error retrieving GeoTIFF info:", error);
});
```
### To create a GeoTiffTileSetModel 
```typescript
GeoTiffTileSetModel.createFromURL(url, options)
  .then((model) => {
    console.log("GeoTIFF Tile Set Model created:", model);
    //  use this model in combination with a 
    const layer = new RasterTileSetLayer(model, options);
    // Add the layer to the map
    map.layerTree.addChild(layer);  

  })
  .catch((error) => {
    console.error("Error creating GeoTIFF Tile Set Model:", error);
  });
```

### Working with gradients
- Define your normalized gradient (0 to 1 values), 
- Define the range of values (from 0 to 8848) 
```typescript
const gradient = {
    colorMap: [
        { level: 0, color: '#0000FF' },      // Blue: water level (0 meters)
        { level: 100 / 8848, color: '#0077FF' },    // Light blue: shallow water (100 meters)
        { level: 500 / 8848, color: '#00FF00' },    // Green: lowland vegetation (500 meters)
        { level: 1000 / 8848, color: '#77FF00' },   // Light green: lowland vegetation (1,000 meters)
        { level: 2000 / 8848, color: '#FFFF00' },   // Yellow: higher vegetation/fields (2,000 meters)
        { level: 3000 / 8848, color: '#FFAA00' },   // Orange: mid-elevation (3,000 meters)
        { level: 4000 / 8848, color: '#A52A2A' },   // Brown: mountains (4,000 meters)
        { level: 5500 / 8848, color: '#D2691E' },   // Lighter brown: high mountains (5,500 meters)
        { level: 7000 / 8848, color: '#F5DEB3' },   // Beige: high altitude (7,000 meters)
        { level: 8848 / 8848, color: '#FFFFFF' },   // White: snow caps/high peaks (8,848 meters - Mount Everest)
    ],
    range: { min: 0, max: 8848 },
};
```

### Working with bands:
You can initialize the band mapping during layer creation setting the options of `createFromURL` 
or you can change it after layer creation usig the method model.setGradient(gradient);


Now create the layer and pass it as part of the options:
```typescript
GeoTiffTileSetModel.createFromURL(url, {gradient})
  .then((model) => {
    console.log("GeoTIFF Tile Set Model created:", model);
  })
  .catch((error) => {
    console.error("Error creating GeoTIFF Tile Set Model:", error);
  });
```
The layer will be created and displayed using this color map options.

You can also modify the gradient after the layer has been created using:
```typescript
GeoTiffTileSetModel.createFromURL(url, {
  bandMapping: {
    red: 0,      // n-index band to be used as red
    green: 1,   // n-index band to be used as green
    blue: 2,    // n-index band to be used as blue
    isRGB: true,  // Indicated RGB channels will be used to color the map
  },
})  .then((model) => {
    console.log("GeoTIFF Tile Set Model created:", model);
})
    .catch((error) => {
        console.error("Error creating GeoTIFF Tile Set Model:", error);
    });
```

```typescript
model.setBandMapping({ red: 0, green: 1, blue: 2, isRGB: true });
```

### Working with gradients in a multiband dataset:
If you have multibands your need to indicate which band will be colored, you do this using bandMapping and use gray to indicate the band to use.
Then define a gradient.  The selected band will be colored using the gradient.
```typescript
GeoTiffTileSetModel.createFromURL(url, {
  gradient,  //  Gradient to color tha band
  bandMapping: {
    gray: 2,     //  Band that will be colored
    isRGB: false,   // Indicate only one band is to be used
  }
})  .then((model) => {
    console.log("GeoTIFF Tile Set Model created:", model);
})
    .catch((error) => {
        console.error("Error creating GeoTIFF Tile Set Model:", error);
    });
```

## Requirements
* LuciadRIA 2024.1 or higher (place it on a local npm repository for instance verdaccio )
* A ES6 or Typescript capable transpiler. 
