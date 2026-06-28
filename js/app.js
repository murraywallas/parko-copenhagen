// app.js — Orquestación: mapa, zonas, instalaciones de aparcamiento (OSM),
// ubicación, hora/duración, filtros, búsqueda y panel (estilo legalparkering).

(() => {
'use strict';

const { MUNICIPALITIES, zonesAt } = window.ParkMunicipalities;
const { evaluateZone, isFreeNow, zoneClass } = window.ParkRules;

let map, zonesLayer, facLayer, stripsLayer, youMarker, selectedMarker, canvasRenderer, stripsRenderer;
let features = [];            // zonas combinadas (CPH + FRB)
let facilities = [];          // instalaciones de aparcamiento (OSM)
let stripsCache = [];         // calles de pago cargadas (parkering_areal)
let stripsLoadedBounds = null;
let queryDate = new Date();
let durationH = 1;
let activeFilter = 'all';
let facOn = true;             // capa de parkings visible
let lastPoint = null;
let lastStrip = null;
const STRIP_ZOOM = 15;        // a partir de aquí se muestran las calles

// ---------------------------------------------------- Colores
function zoneColor(props) {
  if (props.municipality === 'frb') return '#d6457d';
  const k = props.kategori || '';
  if (k === 'Betalingszone') return ({
    'Rød': '#e4572e', 'Grøn': '#2e9e5b', 'Blå': '#3a78d6', 'Gul': '#d6a700',
  })[props.navn] || '#9aa0a6';
  const core = k.replace(/^Kommende\s*/i, '').replace(/^Tidligere\s*/i, '');
  if (core === 'Beboerzone' || core === 'Adressebeboerzone') return '#8c5bd6';
  if (core === 'Flexzone') return '#16a3a3';
  if (/Zone med tidsrestriktion|Prikgade/i.test(core)) return '#e08a1e';
  return '#9aa0a6';
}
const FAC_COLOR = { pay: '#f0a500', free: '#2ec88a', unknown: '#9aa3ad', private: '#7a818b' };
const FAC_LABEL = { pay: 'De pago', free: 'Gratis', unknown: 'Sin datos de pago', private: 'Privado' };
const PTYPE = {
  surface: 'En superficie', 'multi-storey': 'Edificio (P-hus)', underground: 'Subterráneo',
  rooftop: 'En azotea', lane: 'En calzada', street_side: 'Junto a la calle',
};
// Esquema de calle (p_ordning) → color y, si aplica, zona de pago.
const PORD_NAVN = {
  'Rød betalingszone': 'Rød', 'Grøn betalingszone': 'Grøn',
  'Blå betalingszone': 'Blå', 'Gul betalingszone': 'Gul',
};
function pordColor(po) {
  if (PORD_NAVN[po]) return zoneColor({ kategori: 'Betalingszone', navn: PORD_NAVN[po] });
  if (/restriktion/i.test(po || '')) return '#e08a1e';
  if (/Privat/i.test(po || '')) return '#8a8f98';
  if (/Elbil|delebil|ladestander/i.test(po || '')) return '#16a3a3';
  if (/Handicap|Besøg|Ambassade|Motorcykel|Taxi/i.test(po || '')) return '#b07fc0';
  return '#9aa3ad';
}

// ---------------------------------------------------- Carga de zonas
async function fetchMunicipality(m) {
  const tag = fc => (fc.features || []).map(f => {
    f.properties = f.properties || {};
    if (!f.properties.municipality) f.properties.municipality = m.id;
    return f;
  });
  if (m.liveUrl) {
    try { const r = await fetch(m.liveUrl, { cache: 'no-store' }); if (r.ok) return { feats: tag(await r.json()), live: true }; }
    catch (_) {}
  }
  const r = await fetch(m.fallbackUrl);
  return { feats: tag(await r.json()), live: false };
}
async function loadZones() {
  setStatus('Cargando zonas oficiales…');
  const results = await Promise.all(MUNICIPALITIES.map(fetchMunicipality));
  features = results.flatMap(r => r.feats);
  const live = results.some(r => r.live);
  renderZones();
  setStatus(`${features.length} zonas · CPH + Frederiksberg · ${live ? 'en vivo' : 'offline'}`);
}
async function loadFacilities() {
  try { const r = await fetch('data/parking-facilities.json'); facilities = (await r.json()).features || []; }
  catch (_) { facilities = []; }
  renderFacilities();
}

// ---------------------------------------------------- Filtros
function matchesFilter(f) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'free') return isFreeNow(f, queryDate);
  return zoneClass(f) === activeFilter;
}
// El filtro aplica también a parkings off-street y a las calles, para que el
// efecto sea claro y coherente en todas las capas.
function facVisibleByFilter(cls) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'pay') return cls === 'pay';
  if (activeFilter === 'free') return cls === 'free';
  return false; // residentes / restricción: los parkings off-street no aplican
}
function stripVisibleByFilter(po) {
  if (activeFilter === 'all' || activeFilter === 'pay') return activeFilter === 'all' ? true : /betalingszone/i.test(po || '');
  if (activeFilter === 'restricted') return /restriktion/i.test(po || '');
  return false; // free / license: sin calles
}
function renderZones() {
  if (zonesLayer) zonesLayer.remove();
  const dim = activeFilter !== 'all';
  zonesLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
    style: f => {
      const on = matchesFilter(f), c = zoneColor(f.properties);
      if (on) return { color: c, weight: 1.3, fillColor: c, fillOpacity: dim ? 0.5 : 0.42, opacity: 0.95 };
      return { color: c, weight: 0.2, fillColor: c, fillOpacity: 0.02, opacity: 0.08 };
    },
    onEachFeature: (f, layer) => layer.on('click', ev => { L.DomEvent.stopPropagation(ev); showAt(ev.latlng.lat, ev.latlng.lng); }),
  }).addTo(map);
}

// ---------------------------------------------------- Capa de parkings
// Densidad por zoom: <14 nada; ≥14 pago+gratis; ≥15 además sin-datos/privados.
function renderFacilities() {
  if (facLayer) { facLayer.remove(); facLayer = null; }
  if (!facOn || !map) return;
  const z = map.getZoom();
  if (z < 14) return;
  const showAll = z >= 15;
  facLayer = L.layerGroup();
  for (const f of facilities) {
    const c = f.properties.cls;
    const garage = f.properties.kind === 'garage';
    if (!(garage || c === 'pay' || c === 'free' || showAll)) continue;
    if (!facVisibleByFilter(c)) continue;
    const [lo, la] = f.geometry.coordinates;
    // Garajes oficiales (p_hus): marcador cuadrado "P" para distinguirlos.
    const m = garage
      ? L.marker([la, lo], { icon: garageIcon() })
      : L.circleMarker([la, lo], { renderer: canvasRenderer, radius: c === 'pay' ? 6.5 : 5, color: '#fff', weight: 1.5, fillColor: FAC_COLOR[c], fillOpacity: 0.95 });
    m.on('click', ev => { L.DomEvent.stopPropagation(ev); showFacility(f, [la, lo]); });
    facLayer.addLayer(m);
  }
  facLayer.addTo(map);
}
function garageIcon() { return L.divIcon({ className: 'gar', html: 'P', iconSize: [22, 22], iconAnchor: [11, 11] }); }

// ---------------------------------------------------- Calles de pago (parkering_areal)
// Estilo APCOA/EasyPark: al hacer zoom se cargan por bbox las franjas reales de
// aparcamiento de cada calle/lado, coloreadas por su esquema.
async function loadStrips() {
  if (!map) return;
  if (map.getZoom() < STRIP_ZOOM) {
    if (stripsLayer) { stripsLayer.remove(); stripsLayer = null; }
    stripsLoadedBounds = null;
    return;
  }
  const cur = map.getBounds();
  if (stripsLoadedBounds && stripsLoadedBounds.contains(cur)) return; // ya cubierto
  // Padding pequeño (menos features) + tope alto: evita que la consulta se trunque
  // y deje barrios sin calles en pantallas anchas o vistas grandes.
  const b = cur.pad(0.12);
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},urn:ogc:def:crs:EPSG::4326`;
  const url = `https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=k101:parkering_areal&srsName=EPSG:4326&outputFormat=application/json&count=15000&bbox=${bbox}`;
  try {
    const r = await fetch(url);
    const gj = await r.json();
    stripsCache = gj.features || [];
    stripsLoadedBounds = b;
    renderStrips();
  } catch (_) { /* sin red: se mantienen las zonas */ }
}
function renderStrips() {
  if (stripsLayer) stripsLayer.remove();
  if (!map || map.getZoom() < STRIP_ZOOM) { stripsLayer = null; return; }
  const feats = stripsCache.filter(f => stripVisibleByFilter(f.properties.p_ordning));
  stripsLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
    renderer: stripsRenderer, // SVG (encima de las zonas y fiable al clic)
    // Borde grueso: hace la franja más visible y mucho más fácil de tocar.
    style: f => { const c = pordColor(f.properties.p_ordning); return { color: c, weight: 6, lineCap: 'round', lineJoin: 'round', fillColor: c, fillOpacity: 0.85, opacity: 0.95 }; },
    onEachFeature: (f, layer) => layer.on('click', ev => { L.DomEvent.stopPropagation(ev); showStrip(f); }),
  }).addTo(map);
}
// Centroide aproximado de una franja (primer anillo del primer polígono).
function stripCenter(f) {
  let ring = f.geometry.coordinates[0];
  if (f.geometry.type === 'MultiPolygon') ring = f.geometry.coordinates[0][0];
  let sx = 0, sy = 0;
  ring.forEach(p => { sx += p[0]; sy += p[1]; });
  return [sy / ring.length, sx / ring.length]; // [lat, lng]
}
function showStrip(f) {
  lastStrip = f; lastPoint = null;
  const p = f.properties;
  const ll = stripCenter(f);
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.marker(ll, { icon: pinIcon() }).addTo(map);

  const street = `${p.vejnavn || 'Calle'}${p.vejside ? ` · ${p.vejside.toLowerCase()}` : ''}`;
  let res;
  if (PORD_NAVN[p.p_ordning]) {
    res = evaluateZone({ properties: { kategori: 'Betalingszone', navn: PORD_NAVN[p.p_ordning], municipality: 'cph' } }, { when: queryDate, durationH });
  } else if (/restriktion/i.test(p.p_ordning || '')) {
    res = evaluateZone({ properties: { kategori: 'Zone med tidsrestriktion', beskrivelse: p.p_ordning, municipality: 'cph' } }, { when: queryDate, durationH });
  } else {
    res = { level: 'info', muniLabel: 'Copenhague', when: queryDate, durationH, nowText: p.p_ordning || '',
      sourceUrl: 'https://www.kk.dk/parkering', detail: 'Plazas con uso específico. Consulta la señalización de la calle.' };
  }
  res.status = street;
  const meta = [p.p_ordning, p.antal_p_pladser != null ? `${p.antal_p_pladser} plazas` : null, p.bydel].filter(Boolean).join(' · ');
  res.detail = `${meta}.${res.detail ? ' ' + res.detail : ''}`;
  renderPanel([res], nearestPayFacility(ll[0], ll[1]));
}

// ---------------------------------------------------- Consulta de un punto
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLng = (bLng - aLng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function nearestPayFacility(lat, lng, maxM = 1500) {
  let best = null, bestD = Infinity;
  for (const f of facilities) {
    if (f.properties.cls !== 'pay') continue;
    const [lo, la] = f.geometry.coordinates;
    const d = haversine(lat, lng, la, lo);
    if (d < bestD) { bestD = d; best = { f, d, latlng: [la, lo] }; }
  }
  return best && best.d <= maxM ? best : null;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }

function showAt(lat, lng) {
  lastPoint = [lat, lng]; lastStrip = null;
  const hits = zonesAt(features, lng, lat);
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.marker([lat, lng], { icon: pinIcon() }).addTo(map);

  let results;
  if (!hits.length) {
    results = [{ level: 'info', muniLabel: '', status: 'Sin zona regulada en la calle',
      nowText: '', detail: 'No hay zona de la calle del dataset aquí. Mira los parkings de pago marcados o la señal de la calle.',
      sourceUrl: 'https://www.kk.dk/parkering', when: queryDate, durationH }];
  } else {
    const seen = new Set();
    results = hits.map(f => evaluateZone(f, { when: queryDate, durationH }))
      .filter(r => { const k = `${r.status}|${r.level}|${r.total ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const order = { pay: 0, license: 1, restricted: 2, free: 3, info: 4 };
    results.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  }
  renderPanel(results, nearestPayFacility(lat, lng));
}
function recompute() {
  if (lastStrip) showStrip(lastStrip);
  else if (lastPoint) showAt(lastPoint[0], lastPoint[1]);
}

// ---------------------------------------------------- Panel de zona
const LEVEL = {
  pay: { es: 'De pago', cls: 'lv-pay' }, free: { es: 'Gratis ahora', cls: 'lv-free' },
  license: { es: 'Licencia', cls: 'lv-license' }, restricted: { es: 'Restringida', cls: 'lv-restricted' },
  info: { es: 'Info', cls: 'lv-info' },
};
function renderPanel(results, nearPay) {
  const main = results[0], lv = LEVEL[main.level] || LEVEL.info;
  const body = document.getElementById('sheet-body');
  let h = `<div class="r-top">
      <span class="lv ${lv.cls}">${lv.es}</span>
      ${main.muniLabel ? `<span class="r-muni">${main.muniLabel}</span>` : ''}
      <span class="r-when">${fmtWhen(main.when)}</span>
    </div>
    <h2 class="r-title">${main.status}</h2>`;
  if (main.nowText) h += `<p class="r-now">${main.nowText}</p>`;

  if (main.total != null) {
    h += `<div class="cost">
        <div class="cost-main"><span class="cost-val">${main.total}</span><span class="cost-cur">kr</span></div>
        <div class="cost-sub">por <strong>${main.durationH} h</strong>${main.capped ? ' · tope diario' : ''}</div>
        ${durationCtl()}
      </div>`;
    if (main.breakdown && main.breakdown.length) h += hourStrip(main.breakdown);
  } else if (main.level !== 'info') {
    h += `<div class="cost cost-empty"><div class="cost-sub">Sin tarifa de pago para esta zona.</div></div>`;
  }
  if (main.detail) h += `<p class="r-detail">${main.detail}</p>`;

  if (main.payProviders && (main.level === 'pay' || main.level === 'free') && main.total != null) {
    h += `<div class="pay">${main.payProviders.map((p, i) =>
      `<a class="pay-btn ${i ? 'ghost' : ''}" href="${p.url}" target="_blank" rel="noopener">${p.name}</a>`).join('')}</div>`;
  }

  // Parking de pago más cercano (off-street).
  if (nearPay) {
    h += `<button class="near" data-lat="${nearPay.latlng[0]}" data-lng="${nearPay.latlng[1]}">
        <span class="near-ic">P</span>
        <span class="near-tx"><strong>Parking de pago cercano</strong><small>${facilityName(nearPay.f.properties)} · a ${fmtDist(nearPay.d)}</small></span>
        <span class="near-go">›</span>
      </button>`;
  }

  h += `<div class="links">`;
  if (main.licenseUrl) h += `<a href="${main.licenseUrl}" target="_blank" rel="noopener">Licencia de la zona</a>`;
  if (main.sourceUrl) h += `<a href="${main.sourceUrl}" target="_blank" rel="noopener">Fuente oficial</a>`;
  h += `</div>`;

  if (results.length > 1) {
    h += `<div class="others"><span class="others-h">También aplica aquí</span>`;
    for (let i = 1; i < results.length; i++) {
      const r = results[i], b = LEVEL[r.level] || LEVEL.info;
      h += `<div class="other"><span class="lv ${b.cls}">${b.es}</span> ${r.status}${r.totalText ? ` · ${r.totalText}/${r.durationH}h` : ''}</div>`;
    }
    h += `</div>`;
  }
  body.innerHTML = h;
  openSheet();
  bindDurationCtl();
  bindNear();
}

// ---------------------------------------------------- Panel de instalación
function facilityName(p) {
  if (p.name) return p.name;
  if (p.operator) return p.operator;
  const t = PTYPE[p.ptype];
  if (t) return p.ptype === 'multi-storey' || p.ptype === 'underground' ? t : `Parking ${t.toLowerCase()}`;
  return 'Aparcamiento';
}
function showFacility(f, latlng) {
  lastPoint = null; lastStrip = null;
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.marker(latlng, { icon: pinIcon() }).addTo(map);
  const p = f.properties;
  const garage = p.kind === 'garage';
  const badge = p.cls === 'pay' ? 'lv-pay' : p.cls === 'free' ? 'lv-free' : 'lv-info';
  const rows = [];
  if (garage) rows.push(['Tipo', p.typeLabel || 'Garaje']);
  else if (p.ptype) rows.push(['Tipo', PTYPE[p.ptype] || p.ptype]);
  if (p.access) rows.push(['Acceso', ({ yes: 'Público', customers: 'Clientes', permit: 'Con permiso', private: 'Privado', no: 'Restringido' })[p.access] || p.access]);
  if (p.capacity) rows.push(['Plazas', String(p.capacity)]);
  if (p.operator && p.operator !== facilityName(p)) rows.push(['Operador', p.operator]);
  if (garage && p.owner) rows.push(['Titularidad', p.owner === 'Kommune' ? 'Municipal' : p.owner === 'Privat' ? 'Privada' : p.owner]);
  if (p.charge) rows.push(['Tarifa', p.charge]);
  if (p.maxstay) rows.push(['Tiempo máx.', p.maxstay]);

  let h = `<div class="r-top">
      <span class="lv ${badge}">${FAC_LABEL[p.cls]}</span>
      <span class="r-muni">${garage ? 'Garaje oficial' : 'Parking'}</span>
    </div>
    <h2 class="r-title">${facilityName(p)}</h2>
    <p class="r-now">${garage ? 'Garaje de pago (P-hus / sótano)' : p.cls === 'pay' ? 'Aparcamiento de pago (fuera de la calle)' : p.cls === 'free' ? 'Aparcamiento gratuito' : 'Sin datos de tarifa en OSM'}</p>`;
  if (rows.length) h += `<div class="facrows">${rows.map(r => `<div class="facrow"><span>${r[0]}</span><strong>${r[1]}</strong></div>`).join('')}</div>`;
  h += `<div class="pay">
      <a class="pay-btn" href="https://www.google.com/maps/dir/?api=1&destination=${latlng[0]},${latlng[1]}" target="_blank" rel="noopener">Cómo llegar</a>
      ${p.cls === 'pay' ? `<a class="pay-btn ghost" href="https://www.easypark.com/da-dk" target="_blank" rel="noopener">Pagar con EasyPark</a>` : ''}
    </div>
    <p class="r-detail">${garage
      ? 'Garaje del registro oficial de Københavns Kommune. La tarifa la fija el operador; confírmala en el sitio.'
      : 'Datos de instalación de OpenStreetMap; la tarifa exacta puede variar, confírmala en el sitio.'}</p>`;
  document.getElementById('sheet-body').innerHTML = h;
  openSheet();
}

// ---------------------------------------------------- Controles del panel
function durationCtl() {
  return `<div class="dur" role="group" aria-label="Duración">
      <button class="dur-btn" data-d="-1" aria-label="Menos">−</button>
      <span class="dur-val"><strong>${durationH}</strong> h</span>
      <button class="dur-btn" data-d="1" aria-label="Más">+</button></div>`;
}
function bindDurationCtl() {
  document.querySelectorAll('.dur-btn').forEach(b => b.addEventListener('click', () => {
    durationH = Math.min(12, Math.max(1, durationH + parseInt(b.dataset.d, 10))); recompute();
  }));
}
function bindNear() {
  const b = document.querySelector('.near');
  if (b) b.addEventListener('click', () => {
    const lat = +b.dataset.lat, lng = +b.dataset.lng;
    map.setView([lat, lng], 17);
    const f = facilities.find(x => x.geometry.coordinates[1] === lat && x.geometry.coordinates[0] === lng);
    if (f) showFacility(f, [lat, lng]);
  });
}
function hourStrip(breakdown) {
  return `<div class="strip">${breakdown.map(b =>
    `<div class="hc ${b.free ? 'hc-free' : 'hc-pay'}"><span class="hc-n">${b.hour}h</span><span class="hc-p">${b.free ? 'gratis' : b.price}</span></div>`).join('')}</div>`;
}

// ---------------------------------------------------- Sheet helpers
function openSheet() { document.getElementById('sheet').classList.add('open'); }
function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
  if (selectedMarker) { selectedMarker.remove(); selectedMarker = null; }
  lastPoint = null;
}

function fmtWhen(d) {
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], p = n => String(n).padStart(2, '0');
  return `${dias[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Marcador de SELECCIÓN: pin tipo gota (distinto del punto GPS).
function pinIcon() {
  return L.divIcon({
    className: 'pin-sel',
    html: '<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 25 15 25s15-14.5 15-25C30 6.7 23.3 0 15 0z" fill="#15181d" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#2bd9b4"/></svg>',
    iconSize: [30, 40], iconAnchor: [15, 38],
  });
}
// Marcador de UBICACIÓN GPS: punto con anillo (estilo "estás aquí").
function youIcon() { return L.divIcon({ className: 'you', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }); }

// ---------------------------------------------------- Geolocalización
function locateMe() {
  if (!navigator.geolocation) { setStatus('Geolocalización no disponible'); return; }
  setStatus('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (youMarker) youMarker.remove();
    youMarker = L.marker([lat, lng], { icon: youIcon(), interactive: false, zIndexOffset: -100 }).addTo(map);
    map.setView([lat, lng], 16);
    showAt(lat, lng);
  }, () => setStatus('No se pudo ubicar. Toca el mapa para consultar.'),
  { enableHighAccuracy: true, timeout: 8000 });
}

// ---------------------------------------------------- Búsqueda por dirección
async function searchAddress(q) {
  if (!q.trim()) return;
  setStatus('Buscando dirección…');
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&viewbox=12.40,55.75,12.70,55.58&bounded=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'da,es,en' } });
    const j = await r.json();
    setStatus(`${features.length} zonas · CPH + Frederiksberg`);
    if (!j.length) { setStatus('Dirección no encontrada'); return; }
    const lat = +j[0].lat, lng = +j[0].lon;
    map.setView([lat, lng], 16);
    showAt(lat, lng);
  } catch (_) { setStatus('Error en la búsqueda'); }
}

function setStatus(t) { document.getElementById('status').textContent = t; }

// ---------------------------------------------------- Init
function initFilters() {
  document.querySelectorAll('.chip[data-f]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-f]').forEach(x => x.classList.remove('on'));
    c.classList.add('on'); activeFilter = c.dataset.f;
    renderZones(); renderFacilities(); renderStrips();
  }));
}
function initDateTime() {
  const input = document.getElementById('dt');
  input.value = toLocalInput(queryDate);
  input.addEventListener('change', () => {
    queryDate = input.value ? new Date(input.value) : new Date();
    if (activeFilter === 'free') renderZones(); recompute();
  });
  document.getElementById('now-btn').addEventListener('click', () => {
    queryDate = new Date(); input.value = toLocalInput(queryDate);
    if (activeFilter === 'free') renderZones(); recompute();
  });
}
function initSearch() {
  const form = document.getElementById('search-form'), input = document.getElementById('search');
  form.addEventListener('submit', e => { e.preventDefault(); searchAddress(input.value); input.blur(); });
}
function initFacToggle() {
  const btn = document.getElementById('fac-btn');
  btn.classList.toggle('on', facOn);
  btn.addEventListener('click', () => { facOn = !facOn; btn.classList.toggle('on', facOn); renderFacilities(); });
}

function init() {
  map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([55.6761, 12.5683], 13);
  canvasRenderer = L.canvas({ padding: 0.5 });
  // Pane SVG dedicado para las calles, por encima de las zonas (clics fiables).
  map.createPane('stripsPane');
  map.getPane('stripsPane').style.zIndex = 450;
  stripsRenderer = L.svg({ padding: 0.5, pane: 'stripsPane' });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    maxZoom: 20, subdomains: 'abcd',
    attribution: '© OpenStreetMap © CARTO · Data: KK + Frederiksberg / Open Data DK · Parkings: OSM',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.on('click', e => showAt(e.latlng.lat, e.latlng.lng));
  map.on('zoomend', renderFacilities);
  map.on('moveend', loadStrips);

  document.getElementById('locate-btn').addEventListener('click', locateMe);
  document.getElementById('sheet-close').addEventListener('click', closeSheet);

  initDateTime(); initFilters(); initSearch(); initFacToggle();
  loadZones(); loadFacilities();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
