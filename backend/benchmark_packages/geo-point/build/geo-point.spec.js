"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = __importStar(require("chai"));
const geo_point_1 = require("./geo-point");
chai_1.default.should();
describe('all-tests', function () {
    it('should create an instance', function () {
        const gp1 = new geo_point_1.GeoPoint(1, 2);
        gp1.toLatLngArray().should.deep.equals([1, 2]);
        gp1.toLngLatArray().should.deep.equals([2, 1]);
    });
    it('should calculate distance', function () {
        const p1 = new geo_point_1.GeoPoint(51.5, -0.15);
        const p2 = new geo_point_1.GeoPoint(51.6, -0.16);
        const distance = geo_point_1.GeoPoint.calculateDistance(p1, p2);
        Math.round(distance).should.equals(11142);
    });
    it('should convert to GeoJSON', function () {
        const p1 = new geo_point_1.GeoPoint(51.5, -0.15);
        const geoJson = p1.toGeoJSON();
        geoJson.should.have.keys(['type', 'coordinates']);
        geoJson.type.should.equals('Point');
        geoJson.coordinates.length.should.equals(2);
        geoJson.coordinates[0].should.equals(p1.longitude);
        geoJson.coordinates[1].should.equals(p1.latitude);
    });
    it('should convert to string', function () {
        const p1 = new geo_point_1.GeoPoint(51.5, -0.15);
        p1.toString().should.equals('51.5,-0.15');
    });
    it('should convert to a plain object', function () {
        const p1 = geo_point_1.GeoPoint.fromObject({
            latitude: 51.5,
            longitude: -0.15
        });
        const o = p1.toObject();
        o.should.have.keys(['latitude', 'longitude']);
        o.latitude.should.equals(51.5);
        o.longitude.should.equals(-0.15);
    });
    it('should construct from GeoJSON', function () {
        const p1 = geo_point_1.GeoPoint.fromGeoJSON({
            type: 'Point',
            coordinates: [-0.15, 51.5]
        });
        p1.toObject().should.deep.equals({
            latitude: 51.5,
            longitude: -0.15
        });
    });
    it('should calculate bearing', function () {
        Math.round(geo_point_1.GeoPoint.calculateBearing(new geo_point_1.GeoPoint(51.5, -0.15), new geo_point_1.GeoPoint(51.5, 1.15))).should.equals(89);
        geo_point_1.GeoPoint.calculateBearing(new geo_point_1.GeoPoint(51, 0), new geo_point_1.GeoPoint(52, 0)).should.equals(0);
        Math.round(geo_point_1.GeoPoint.calculateBearing(new geo_point_1.GeoPoint(-6.231624, 106.802569), new geo_point_1.GeoPoint(-6.22063, 106.61694))).should.equals(273);
    });
    it('should calculate destination', function () {
        const point = new geo_point_1.GeoPoint(51, 0);
        const d1 = point.calculateDestination(10000, 360);
        d1.longitude.should.equals(0);
        Math.round(d1.latitude).should.equals(51);
    });
    it('should return tile coordinates', function () {
        const zoom = 18;
        const point = new geo_point_1.GeoPoint(51.5218054, -0.1172997);
        const tile = point.toTile(zoom);
        tile.x.should.equals(130986);
        tile.y.should.equals(87152);
    });
    it('should adjust precision', async () => {
        const point1 = new geo_point_1.GeoPoint(1.23456789, 2.3456789);
        const point2 = point1.adjustPrecision(3);
        (0, chai_1.expect)(point2).to.deep.equals({
            latitude: 1.235,
            longitude: 2.346,
        });
    });
});
//# sourceMappingURL=geo-point.spec.js.map