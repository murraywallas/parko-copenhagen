// municipalities.js — Registro de municipios y utilidades geométricas.
// Arquitectura multi-municipio: cada entrada define de dónde sacar las zonas
// y qué motor de reglas aplicar. Hoy: Copenhague (datos oficiales completos).
// Para añadir Frederiksberg u otro municipio, basta con sumar otra entrada.

(() => {
'use strict';
const MUNICIPALITIES = [
  {
    id: 'cph',
    name: 'København',
    label: 'Copenhague',
    center: [55.6761, 12.5683],
    zoom: 13,
    // Fuente en vivo (WFS GeoJSON oficial, EPSG:4326).
    liveUrl: 'https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=k101:p_zoner_kbh&srsname=EPSG:4326&outputFormat=application%2Fjson',
    // Respaldo offline empaquetado con la app.
    fallbackUrl: 'data/zones-cph.json',
    ruleEngine: 'cph', // usa ParkRules.evaluateZone
    attribution: 'Datos: Københavns Kommune · Open Data DK',
  },
  {
    id: 'frb',
    name: 'Frederiksberg',
    label: 'Frederiksberg',
    center: [55.6786, 12.5333],
    zoom: 14,
    // Frederiksberg solo publica Shapefile en Open Data DK; lo convertimos a
    // GeoJSON WGS84 y lo empaquetamos (no hay endpoint en vivo).
    liveUrl: null,
    fallbackUrl: 'data/zones-frb.json',
    ruleEngine: 'frb',
    attribution: 'Datos: Frederiksberg Kommune · Open Data DK',
  },
  {
    id: 'aar',
    name: 'Aarhus',
    label: 'Aarhus',
    center: [56.1518, 10.2034],
    zoom: 14,
    liveUrl: null,
    fallbackUrl: 'data/zones-aarhus.json',
    facilitiesUrl: 'data/facilities-aarhus.json',
    ruleEngine: 'aar',
    attribution: 'Datos: Aarhus Kommune · Open Data DK',
  },
  {
    id: 'vejle',
    name: 'Vejle',
    label: 'Vejle',
    center: [55.7090, 9.5357],
    zoom: 15,
    liveUrl: null,
    fallbackUrl: 'data/zones-vejle.json',
    facilitiesUrl: 'data/facilities-vejle.json',
    ruleEngine: 'vejle',
    attribution: 'Datos: Vejle Kommune · Open Data DK',
  },
];

// --- Punto en polígono (ray casting), soporta Polygon y MultiPolygon ---
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, polygon) {
  // polygon = [ringExterior, hueco1, hueco2, ...]
  if (!pointInRing(pt, polygon[0])) return false;
  for (let k = 1; k < polygon.length; k++) {
    if (pointInRing(pt, polygon[k])) return false; // dentro de un hueco
  }
  return true;
}

function pointInGeometry(pt, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly => pointInPolygon(pt, poly));
  return false;
}

// Devuelve TODAS las zonas que contienen el punto [lng, lat].
// (Pueden solaparse: p.ej. una de pago + una de residentes.)
function zonesAt(features, lng, lat) {
  const pt = [lng, lat];
  return features.filter(f => pointInGeometry(pt, f.geometry));
}

window.ParkMunicipalities = { MUNICIPALITIES, zonesAt, pointInGeometry };
})();
