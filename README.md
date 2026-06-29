# Parko 🅿️

PWA para móvil que muestra, **según el día, la hora y la duración** de tu
consulta, la situación de aparcamiento (¿puedo aparcar?, ¿es gratis ahora?,
coste total, dónde pagar) en **Copenhague y Frederiksberg**, sobre un mapa y con
datos **oficiales y abiertos**.

![estado](https://img.shields.io/badge/estado-prototipo%20funcional-success)

## Qué hace

- Mapa con todas las zonas de aparcamiento de Copenhague y Frederiksberg (reales).
- **Buscador de direcciones** (Nominatim) y **GPS** (📍) para ver la situación
  donde estás ahora mismo.
- Tocas el mapa, buscas o te ubicas y, para el **día/hora** elegidos:
  - **Situación ahora**: de pago, gratis, residentes o restricción horaria.
  - **Coste total** para la **duración** que elijas (stepper de horas).
  - **Tira por horas**: muestra cuándo es gratis y cuándo pagas durante tu estancia.
  - **Parking de pago más cercano** (off-street) con distancia y "Cómo llegar".
  - **Dónde pagar** (EasyPark, teléfono, apps del municipio) + fuente oficial.
- **Capa de parkings** (OSM): instalaciones de pago/gratis fuera de la calle
  (P-hus, superficie, subterráneos). Aparecen al hacer zoom; toca un punto para
  ver tipo, acceso, plazas y operador. Botón **P** para mostrarla/ocultarla.
  Esto cubre sitios como Valby Maskinfabrik, que no están en el dataset municipal.
- **Calles de pago** (estilo APCOA/EasyPark): al acercar el mapa (zoom ≥ 16) se
  cargan las franjas reales de aparcamiento de cada calle/lado, coloreadas por su
  esquema. Toca una calle para ver su **nombre**, zona, nº de plazas, barrio y el
  precio para tu hora/duración. Se cargan por área visible desde el WFS oficial.
- **Cuatro ciudades**: Copenhague y Frederiksberg (datos completos), más **Aarhus**
  (zonas Rød/Gul/Grøn/Blå/Orange con tarifas reales) y **Vejle** (plazas municipales
  con su horario). Selector de ciudad arriba; la búsqueda cubre las cuatro.
- **Filtros** de zona: Todas · Gratis ahora · De pago · Residentes · Restricción.
- Maneja zonas **solapadas** (deduplicadas) en el mismo punto.
- **Funciona offline** (PWA instalable con respaldo de datos local).

### Dos modelos de precio, reales

- **Copenhague**: 4 zonas de color con **tarifa por franja** (24/7). Día 08-18:
  roja/verde 45, azul 26, amarilla 17 kr/h. Tarde 18-23: 18. Noche 23-08: 6.
  1ª hora gratis sáb 17:00 → lun 08:00 y festivos.
- **Frederiksberg**: una sola zona con **precio progresivo por duración**
  (1ª h 10, 2ª 15, 3ª 21, 4ª 26, 5ª-6ª 27 kr; máx. 130 kr/día). Pago lab 07-24
  y sáb 07-17; gratis sáb 17:00 → lun 07:00 y festivos.

## Cómo ejecutarlo

```bash
node serve.js          # http://localhost:4321
```

Ábrelo en el móvil (misma red, IP del PC) o en Chrome con vista de móvil.
Instalar como app: menú del navegador → "Añadir a pantalla de inicio".
Sin dependencias ni build; vale cualquier hosting estático (GitHub Pages,
Netlify, Vercel).

## Fuentes de datos

| Dato | Fuente |
|------|--------|
| Zonas Copenhague | [Open Data DK - Parkeringszoner information](https://www.opendata.dk/city-of-copenhagen/parkeringszoner-information) (WFS `k101:p_zoner_kbh`, EPSG:4326, en vivo) |
| Tarifas Copenhague | [kk.dk - Priser og parkeringszoner](https://www.kk.dk/borger/parkering-trafik-og-veje/parkering/priser-og-parkeringszoner) (2026) |
| Zona Frederiksberg | [Open Data DK - Parkeringszone](https://www.opendata.dk/city-of-frederiksberg/parkeringszone) (Shapefile, convertido a GeoJSON WGS84 y empaquetado) |
| Tarifas Frederiksberg | [frederiksberg.dk - Parkering](https://www.frederiksberg.dk/by-bolig-og-miljoe/trafik/parkering) (2026) |
| Zonas Aarhus | Open Data Aarhus (`betalingsparkering`, reproyectado a WGS84) + tarifas aarhus.dk 2026 (25/11/16 kr/h, dom gratis) |
| Plazas Vejle | Open Data Vejle (ArcGIS `parkeringspladser`, horario por plaza) + tarifas vejle.dk |
| Garajes oficiales | Open Data DK / KK WFS (`k101:p_hus`) - 31 garajes con nombre, plazas, tipo y operador verificados |
| Parkings off-street | OpenStreetMap (`amenity=parking`, vía Overpass) - ~5.100 instalaciones (dedup. con los garajes oficiales) |
| Calles de pago | Open Data DK / KK WFS (`k101:p_pladser`, líneas con nombre, zona, plazas y **texto de restricción** exacto; carga por bbox) |
| Parquímetros | Open Data DK / KK WFS (`k101:parkomat`, 1.602 puntos con zona y estado) |
| Búsqueda/autocompletar | DAWA (Danmarks Adressers Web API, oficial DK; filtrada a Copenhague + Frederiksberg) |
| Mapa base | CARTO Positron + OpenStreetMap |

## Arquitectura

```
index.html              # shell de la UI (chrome de vidrio + mapa + panel)
css/styles.css          # diseño móvil oscuro, chrome de vidrio, un acento (menta)
js/rules.js             # MOTOR DE REGLAS: (zona + fecha/hora + duración) → coste
js/municipalities.js    # registro de municipios + punto-en-polígono
js/app.js               # mapa (Leaflet/CARTO), ubicación, filtros, panel
data/zones-cph.json         # respaldo offline Copenhague (115 zonas)
data/zones-frb.json         # Frederiksberg (GeoJSON convertido del Shapefile)
data/parking-facilities.json # parkings off-street (OSM, 5.127 instalaciones)
manifest.webmanifest    # PWA instalable
sw.js                   # service worker (offline)
serve.js                # servidor estático de desarrollo
```

Cada `<script>` va en un IIFE para no contaminar el ámbito global (los scripts
clásicos comparten el scope léxico de nivel superior). Para **añadir otro
municipio**: sumar una entrada a `MUNICIPALITIES` (geometría + reglas) en
`municipalities.js` y, si el modelo de precio es distinto, una rama en `rules.js`.

## Limitaciones conocidas / próximos pasos

- **EasyPark** no tiene API pública gratuita: el botón "Pagar" enlaza a su web,
  no precarga el código de zona ni el importe.
- **Frederiksberg** solo publica Shapefile (sin GeoJSON en vivo): su geometría se
  convirtió una vez y va empaquetada; si cambia, hay que re-convertirla.
- Las zonas con restricción horaria muestran el límite (p.ej. 3 h) pero no la
  franja exacta (no viene estructurada en el dato; sí en la señal de calle).
- Los **parkings off-street son datos de OSM**: muchos no traen tarifa ni nombre
  (se muestran como "sin datos" al hacer zoom). La capa va empaquetada; para
  actualizarla, re-ejecutar la consulta Overpass `amenity=parking`.
- El precio progresivo de Frederiksberg se calcula por sesión; el tope diario es
  aproximado si la estancia cruza dos días.
- Iconos PWA en SVG; para algunos iOS conviene generar PNG 192/512.
