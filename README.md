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


## To use in your project

Simply import the NPM package into your project

```
npm install ria-geotiff
``` 


## Requirements
* LuciadRIA 2024.1 or higher (place it on a local npm repository for instance verdaccio )
* A ES6 or Typescript capable transpiler. 
