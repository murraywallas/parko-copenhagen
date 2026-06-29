// rules.js — Motor de reglas de aparcamiento (Copenhague + Frederiksberg).
//
// Convierte (zona oficial + fecha/hora + duración) en una respuesta tipo
// legalparkering: ¿se puede aparcar ahora?, hasta cuándo es gratis, coste total
// para la duración elegida, y dónde pagar.
//
// Fuentes:
//  - Copenhague: kk.dk (tarifas 2026) + Open Data DK (geometrías).
//  - Frederiksberg: frederiksberg.dk (tarifas 2026, precio progresivo) +
//    Open Data DK (geometría del Parkeringszone).

(() => {
'use strict';

const HOUR = 3600000;

// ------------------------------------------------------------------ Copenhague
// Tarifa plana por color de zona y franja horaria (DKK/hora). Pago 24/7.
const CPH_TARIFFS = {
  'Rød':  { day: 45, evening: 18, night: 6 },
  'Grøn': { day: 45, evening: 18, night: 6 },
  'Blå':  { day: 26, evening: 18, night: 6 },
  'Gul':  { day: 17, evening: 18, night: 6 },
};
const BAND_LABELS = { day: 'Día (08-18)', evening: 'Tarde (18-23)', night: 'Noche (23-08)' };

function cphBand(date) {
  const h = date.getHours();
  if (h >= 8 && h < 18) return 'day';
  if (h >= 18 && h < 23) return 'evening';
  return 'night';
}
function cphHourlyPrice(navn, date) {
  const t = CPH_TARIFFS[navn];
  return t ? t[cphBand(date)] : null;
}

// --------------------------------------------------------------- Frederiksberg
// Precio PROGRESIVO acumulativo por hora de pago (DKK), tope diario 130.
const FRB_SCHEDULE = [10, 15, 21, 26, 27, 27]; // h1, h2, h3, h4, h5, h6+
const FRB_DAILY_CAP = 130;

function frbSchedulePrice(paidHourIndex) {
  // paidHourIndex: 1 = primera hora de pago de la sesión
  const i = Math.min(paidHourIndex, FRB_SCHEDULE.length) - 1;
  return FRB_SCHEDULE[i];
}
// ¿Se cobra en Frederiksberg en ese instante? Lab 07–24, sáb 07–17; resto gratis.
function frbIsPaidHour(date) {
  if (isDanishHoliday(date)) return false;
  const day = date.getDay(), h = date.getHours();
  if (day === 0) return false;            // domingo
  if (day === 6) return h >= 7 && h < 17; // sábado
  return h >= 7;                          // lun–vie 07–24
}

// ------------------------------------------------------------------- Aarhus
// Tarifa por zona y franja (automat oficial). Domingos/festivos gratis.
// Gul: 2 h gratis con registro. Grøn: tarde gratis. Blå/Orange: según señal.
const AAR_TARIFFS = {
  'Rød':  { day: 25, evening: 11 },
  'Gul':  { day: 25, evening: 11 },
  'Grøn': { day: 16, evening: 0 },
};
function aarBand(date) {
  if (isDanishHoliday(date)) return 'free';
  const day = date.getDay(), h = date.getHours();
  if (day === 0) return 'free';                                  // domingo
  if (day === 6) return h >= 8 && h < 16 ? 'day' : (h >= 16 && h < 23 ? 'evening' : 'free'); // sábado
  return h >= 8 && h < 19 ? 'day' : (h >= 19 && h < 23 ? 'evening' : 'free');                // lun-vie
}
function aarHourlyPrice(navn, date) {
  const t = AAR_TARIFFS[navn]; if (!t) return null;              // Blå/Orange desconocido
  const b = aarBand(date); return b === 'free' ? 0 : (t[b] ?? 0);
}
function aarIsPaidHour(date, navn) {
  const t = AAR_TARIFFS[navn]; if (!t) return false;
  return (aarHourlyPrice(navn, date) ?? 0) > 0;
}

// --------------------------------------------------------------------- Vejle
// Datos por plaza (Open Data Vejle): cada plaza trae su horario de pago (periode).
// Precio no viene fiable por plaza; tarifa de ciudad: ~9 kr/h (máx 3 h) en zona de pago.
function vejleParse(periode) {
  if (!periode) return null;
  if (/Uden tidsbegr/i.test(periode)) return { unlimited: true };
  const r = {}; let m;
  if ((m = periode.match(/Hverdage:\s*(\d{1,2})-(\d{1,2})/i))) r.wd = [+m[1], +m[2]];
  if ((m = periode.match(/L[øo]rdag:\s*(\d{1,2})-(\d{1,2})/i))) r.sat = [+m[1], +m[2]];
  if ((m = periode.match(/S[øo]n[^:]*:\s*(\d{1,2})-(\d{1,2})/i))) r.sun = [+m[1], +m[2]];
  return r;
}
function vejlePaidNow(periode, date) {
  const r = vejleParse(periode);
  if (!r || r.unlimited) return false;
  const day = date.getDay(), h = date.getHours();
  const range = day === 0 ? r.sun : day === 6 ? r.sat : r.wd;
  if (isDanishHoliday(date) && !r.sun) return false;
  if (!range) return false;
  return h >= range[0] && h < range[1];
}
function vejlePeriodeES(periode) {
  if (!periode) return '';
  return periode
    .replace(/Uden tidsbegr[æae]nsning/gi, 'Sin límite de tiempo')
    .replace(/Hverdage/gi, 'Laborables').replace(/L[øo]rdag/gi, 'Sábado')
    .replace(/S[øo]n\/?Helligdage/gi, 'Dom/festivos').replace(/S[øo]ndag/gi, 'Domingo');
}
// Traduce el límite de tiempo (KATEGORI) de Vejle: "Max 2 timer 7-17" -> "Máx 2 h, 7-17".
function vejleLimitES(k) {
  if (!k) return '';
  if (/Uden tidsbegr/i.test(k)) return 'sin límite';
  return k.replace(/Max\s*/i, 'Máx ').replace(/(\d+)\s*timer?/gi, '$1 h')
    .replace(/Reserveret/i, 'Reservado').replace(/min\b/gi, 'min').trim();
}

// ¿Se cobra (en general) en este instante? Genérico para mensajes.
function isPaidAt(muni, navn, date) {
  if (muni === 'frb') return frbIsPaidHour(date);
  if (muni === 'aar') return aarIsPaidHour(date, navn);
  if (muni === 'cph') return true; // 24/7 (1ª hora gratis aparte)
  return false;
}

// ---------------------------------------------------------------- Festivos DK
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function ymd(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

let _holidayCache = {};
function danishHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const e = easterSunday(year);
  const set = new Set([
    new Date(year, 0, 1), addDays(e, -3), addDays(e, -2), e, addDays(e, 1),
    addDays(e, 39), addDays(e, 49), addDays(e, 50),
    new Date(year, 11, 25), new Date(year, 11, 26),
  ].map(ymd));
  return (_holidayCache[year] = set);
}
function isDanishHoliday(date) { return danishHolidays(date.getFullYear()).has(ymd(date)); }

// Copenhague: 1ª hora gratis sáb 17:00 → lun 08:00, festivos, 5 jun y 24 dic.
function cphFirstHourFree(date) {
  const day = date.getDay(), h = date.getHours();
  if (day === 6 && h >= 17) return true;
  if (day === 0) return true;
  if (day === 1 && h < 8) return true;
  if (isDanishHoliday(date)) return true;
  const m = date.getMonth(), d = date.getDate();
  if (m === 5 && d === 5) return true;
  if (m === 11 && d === 24) return true;
  return false;
}

// Próximo instante en que el aparcamiento pasa a ser gratis (para mensajes).
function nextFreeTime(muni, from, navn) {
  for (let i = 0; i < 24 * 8; i++) {
    const t = new Date(from.getTime() + i * HOUR);
    if (!isPaidAt(muni, navn, t)) return t;
  }
  return null;
}
function fmtDayTime(d) {
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  return `${dias[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:00`;
}

// ----------------------------------------------------------- Dónde pagar
const PAY = {
  cph: [
    { name: 'EasyPark', url: 'https://www.easypark.com/da-dk' },
    { name: 'Tel. 33 66 18 18', url: 'tel:+4533661818' },
  ],
  frb: [
    { name: 'EasyPark', url: 'https://www.easypark.com/da-dk' },
    { name: 'OK / Oparko / APCOA', url: 'https://www.frederiksberg.dk/by-bolig-og-miljoe/trafik/parkering' },
  ],
  aar: [
    { name: 'EasyPark', url: 'https://www.easypark.com/da-dk' },
    { name: 'OK / ParkMan / ParkPark', url: 'https://aarhus.dk/borger/trafik-og-parkering/parkering/parkering-i-aarhus/priser-og-betaling' },
  ],
  vejle: [
    { name: 'EasyPark', url: 'https://www.easypark.com/da-dk' },
    { name: 'Info Vejle', url: 'https://www.vejle.dk/da/service-og-selvbetjening/borger/trafik-og-parkering/parkering-og-tilladelser/priser-og-betaling-for-parkering/hvad-koster-det-at-parkere/' },
  ],
};
const SOURCE = {
  cph: 'https://www.kk.dk/borger/parkering-trafik-og-veje/parkering/priser-og-parkeringszoner',
  frb: 'https://www.frederiksberg.dk/by-bolig-og-miljoe/trafik/parkering',
  aar: 'https://aarhus.dk/borger/trafik-og-parkering/parkering/parkering-i-aarhus/priser-og-betaling',
  vejle: 'https://www.vejle.dk/da/service-og-selvbetjening/borger/trafik-og-parkering/parkering-og-tilladelser/priser-og-betaling-for-parkering/hvad-koster-det-at-parkere/',
};
const MUNI_LABEL = { cph: 'Copenhague', frb: 'Frederiksberg', aar: 'Aarhus', vejle: 'Vejle' };

// ----------------------------------------------------------- Cálculo de coste
// Devuelve { total, breakdown:[{hour,price,free}], freeHours, paidHours, capped }
function computeCost(muni, navn, start, durationH) {
  let total = 0, paid = 0, freeHours = 0;
  let aarFreeBudget = (muni === 'aar' && navn === 'Gul') ? 2 : 0; // 2 h gratis zona amarilla
  const breakdown = [];
  for (let i = 0; i < durationH; i++) {
    const slot = new Date(start.getTime() + i * HOUR);
    if (muni === 'frb') {
      if (frbIsPaidHour(slot)) {
        paid++; const price = frbSchedulePrice(paid); total += price;
        breakdown.push({ hour: i + 1, price, free: false });
      } else { freeHours++; breakdown.push({ hour: i + 1, price: 0, free: true }); }
    } else if (muni === 'aar') {
      const price = aarHourlyPrice(navn, slot);
      if (price > 0 && aarFreeBudget > 0) { aarFreeBudget--; freeHours++; breakdown.push({ hour: i + 1, price: 0, free: true }); }
      else if (price > 0) { paid++; total += price; breakdown.push({ hour: i + 1, price, free: false }); }
      else { freeHours++; breakdown.push({ hour: i + 1, price: 0, free: true }); }
    } else { // cph
      const free = i === 0 && cphFirstHourFree(start);
      if (free) { freeHours++; breakdown.push({ hour: i + 1, price: 0, free: true }); }
      else { const price = cphHourlyPrice(navn, slot) ?? 0; paid++; total += price; breakdown.push({ hour: i + 1, price, free: false }); }
    }
  }
  let capped = false;
  if (muni === 'frb' && total > FRB_DAILY_CAP) { total = FRB_DAILY_CAP; capped = true; }
  return { total, breakdown, freeHours, paidHours: paid, capped };
}

// ----------------------------------------------------------- Evaluación
// feature: Feature oficial. opts: { when:Date, durationH:number }
function evaluateZone(feature, opts = {}) {
  const when = opts.when || new Date();
  const durationH = Math.max(1, Math.round(opts.durationH || 1));
  const p = feature.properties || {};
  const muni = p.municipality || 'cph';
  const kategori = p.kategori || '';

  const base = {
    muni, muniLabel: MUNI_LABEL[muni], navn: p.navn || '', kategori,
    beskrivelse: p.beskrivelse || '', when, durationH,
    sourceUrl: SOURCE[muni], licenseUrl: p.beboerzone_pdf || null,
    payProviders: PAY[muni],
  };

  // --- Frederiksberg: zona única de pago progresivo ---
  if (muni === 'frb') {
    const paidNow = frbIsPaidHour(when);
    const cost = computeCost('frb', null, when, durationH);
    let nowText;
    if (!paidNow) {
      const resumes = nextPaidTime('frb', when);
      nowText = resumes ? `Gratis ahora · cobro desde ${fmtDayTime(resumes)}` : 'Gratis ahora';
    } else {
      const free = nextFreeTime('frb', when);
      nowText = free ? `De pago ahora · gratis desde ${fmtDayTime(free)}` : 'De pago ahora';
    }
    return {
      ...base, level: paidNow ? 'pay' : 'free',
      status: 'Zona de pago de Frederiksberg',
      scheme: 'progresivo', nowText,
      total: cost.total, totalText: `${cost.total} kr`,
      breakdown: cost.breakdown, capped: cost.capped,
      detail: 'Precio progresivo por hora: 1ª h 10, 2ª 15, 3ª 21, 4ª 26, 5ª-6ª 27 kr (máx. 130 kr/día). Debes registrar la matrícula desde el inicio.',
    };
  }

  // --- Aarhus: zonas de pago por color ---
  if (muni === 'aar') {
    const navn = base.navn;
    if (!AAR_TARIFFS[navn]) { // Blå / Orange: según señal
      return { ...base, level: 'info', status: `Zona ${navn}`, nowText: 'Tarifa según señal',
        detail: `Zona ${navn} de Aarhus. Consulta el horario y la tarifa en la señal o el automat.` };
    }
    const paidNow = aarIsPaidHour(when, navn);
    const cost = computeCost('aar', navn, when, durationH);
    const free2 = navn === 'Gul';
    let nowText;
    if (!paidNow) {
      const resumes = nextPaidTime('aar', when, navn);
      nowText = resumes ? `Gratis ahora · cobro desde ${fmtDayTime(resumes)}` : 'Gratis ahora';
    } else if (free2) nowText = `2 h gratis (con registro), luego ${AAR_TARIFFS.Gul.day} kr/h`;
    else nowText = `De pago ahora · ${aarHourlyPrice(navn, when)} kr/h`;
    const detail = navn === 'Grøn'
      ? 'Zona verde: 16 kr/h laborables 8-19 y sáb 8-16; tardes, domingos y festivos gratis.'
      : navn === 'Gul'
      ? 'Zona amarilla: 2 h gratis con registro, luego 25 kr/h (día) / 11 kr/h (tarde 19-23). Domingos y festivos gratis.'
      : 'Zona roja: 25 kr/h (día 8-19) / 11 kr/h (tarde 19-23), sáb hasta 23. Domingos y festivos gratis.';
    return {
      ...base, level: (!paidNow || free2) ? 'free' : 'pay',
      status: `Zona de pago ${navn}`, scheme: 'porhora', nowText,
      total: cost.total, totalText: `${cost.total} kr`, breakdown: cost.breakdown, detail,
    };
  }

  // --- Vejle: por plaza (cada plaza trae su horario) ---
  if (muni === 'vejle') {
    const vt = p.vtype, name = p.sted || 'Aparcamiento', spaces = p.spaces;
    const limitES = vejleLimitES(p.limit);
    const sp = spaces ? `${spaces} plazas` : null;
    let level, nowText, detail;
    if (vt === 'resident') {
      level = 'license'; nowText = 'Reservado a residentes (Beboerkort)';
      detail = [sp, 'Necesitas licencia/zonekort de residente. Sin ella, busca una zona de pago o libre.'].filter(Boolean).join('. ');
    } else if (vt === 'permit') {
      level = 'restricted'; nowText = 'Requiere permiso en horario diurno';
      detail = [sp, 'Permiso necesario de día; sigue la señalización.'].filter(Boolean).join('. ');
    } else if (vt === 'pay') {
      const paidNow = vejlePaidNow(p.periode, when);
      level = paidNow ? 'pay' : 'free';
      nowText = paidNow ? 'De pago ahora · ~9 kr/h' : 'Gratis ahora';
      detail = [p.periode ? `Pago: ${vejlePeriodeES(p.periode)}` : null, sp,
        'Tarifa ~9 kr/h (máx 3 h); fuera de ese horario, domingos y festivos es gratis. Confirma en el automat.'].filter(Boolean).join('. ');
    } else if (vt === 'timed') {
      level = 'free';
      nowText = limitES ? `Gratis · ${limitES}` : 'Gratis con límite de tiempo';
      detail = [limitES ? `Límite: ${limitES}` : null, sp,
        'Gratis pero con tiempo máximo; registra/usa disco si la señal lo pide.'].filter(Boolean).join('. ');
    } else { // free
      level = 'free'; nowText = 'Gratis · sin límite';
      detail = [sp, 'Aparcamiento gratuito sin límite de tiempo.'].filter(Boolean).join('. ');
    }
    return { ...base, level, status: name, nowText, detail };
  }

  // --- Copenhague ---
  const isFormer = /^Tidligere/i.test(kategori);
  const core = kategori.replace(/^Kommende\s*/i, '').replace(/^Tidligere\s*/i, '');

  if (isFormer) {
    return { ...base, level: 'info', status: 'Zona anterior (no vigente)',
      detail: 'Delimitación de una regulación anterior. Verifica la señal de la calle.' };
  }
  if (/Uden for betalingszone/i.test(core)) {
    return { ...base, level: 'free', status: 'Fuera de zona de pago', nowText: 'Sin tarifa municipal',
      detail: 'Sin tarifa de pago municipal. Respeta siempre la señalización vertical.' };
  }
  if (core === 'Betalingszone') {
    const cost = computeCost('cph', base.navn, when, durationH);
    const firstFree = cphFirstHourFree(when);
    const nowPrice = cphHourlyPrice(base.navn, when);
    const nowText = firstFree
      ? '1ª hora gratis ahora · luego tarifa'
      : `De pago ahora · ${nowPrice ?? '-'} kr/h`;
    return {
      ...base, level: firstFree ? 'free' : 'pay',
      status: `Zona de pago ${base.navn}`, scheme: 'porhora', nowText,
      total: cost.total, totalText: `${cost.total} kr`,
      breakdown: cost.breakdown, freeHours: cost.freeHours,
      detail: firstFree
        ? `1ª hora gratis (registra la matrícula igual). Resto a ${nowPrice ?? '-'} kr/h según franja.`
        : `Tarifa ${base.navn} por franja: día 08-18, tarde 18-23, noche 23-08.`,
    };
  }
  if (core === 'Beboerzone' || core === 'Adressebeboerzone') {
    return { ...base, level: 'license', status: 'Zona de residentes', requiresLicense: true,
      nowText: 'Solo con licencia de residente',
      detail: 'Reservada a vehículos con licencia de residente de esta zona. Sin licencia, busca una zona de pago cercana.' };
  }
  if (core === 'Flexzone') {
    return { ...base, level: 'license', status: 'Flexzona', requiresLicense: true,
      nowText: 'Licencia flexible',
      detail: `Admite licencias de varias zonas${p.gyldige_licenszoner_flex ? ` (válidas: ${p.gyldige_licenszoner_flex})` : ''}.` };
  }
  if (/Zone med tidsrestriktion/i.test(core)) {
    const m = (p.beskrivelse || '').match(/(\d+)\s*-?\s*timer/i);
    const hrs = m ? parseInt(m[1], 10) : null;
    return { ...base, level: 'restricted',
      status: hrs ? `Restricción de ${hrs} h (disco)` : 'Restricción horaria',
      nowText: hrs ? `Máx. ${hrs} h con disco` : 'Tiempo limitado con disco',
      detail: hrs
        ? `Máximo ${hrs} h con disco horario (P-skive) en la franja de la señal. Coloca el disco aunque sea gratis.`
        : 'Tiempo máximo limitado con disco horario. Consulta la señal.' };
  }
  if (/Prikgade/i.test(core)) {
    return { ...base, level: 'restricted', status: 'Prikgade', nowText: 'Solo plazas marcadas',
      detail: 'Aparcamiento solo en plazas marcadas. Consulta la señalización.' };
  }
  return { ...base, level: 'info', status: kategori || 'Zona de aparcamiento',
    nowText: '', detail: 'Consulta la señalización de la calle.' };
}

// Próximo instante en que SE EMPIEZA a cobrar (para mensajes de "gratis ahora").
function nextPaidTime(muni, from, navn) {
  for (let i = 0; i < 24 * 8; i++) {
    const t = new Date(from.getTime() + i * HOUR);
    if (isPaidAt(muni, navn, t)) return t;
  }
  return null;
}

// ¿Está esta zona "gratis en este momento"? (para el filtro "Gratis ahora")
function isFreeNow(feature, when = new Date()) {
  const p = feature.properties || {};
  const muni = p.municipality || 'cph';
  const core = (p.kategori || '').replace(/^Kommende\s*/i, '').replace(/^Tidligere\s*/i, '');
  if (muni === 'frb') return !frbIsPaidHour(when);
  if (muni === 'aar') return AAR_TARIFFS[p.navn] ? !aarIsPaidHour(when, p.navn) : false;
  if (muni === 'vejle') {
    if (p.vtype === 'resident' || p.vtype === 'permit') return false;
    if (p.vtype === 'pay') return !vejlePaidNow(p.periode, when);
    return true; // free / timed: gratis ahora
  }
  if (/Uden for betalingszone/i.test(core)) return true;
  if (core === 'Betalingszone') return cphFirstHourFree(when);
  return false; // residentes / restricción no son "gratis para cualquiera"
}

// Clasificación para el filtro de UX.
function zoneClass(feature) {
  const p = feature.properties || {};
  if (p.municipality === 'vejle') {
    const vt = p.vtype;
    return vt === 'resident' ? 'license' : vt === 'pay' ? 'pay'
      : (vt === 'timed' || vt === 'permit') ? 'restricted' : 'free';
  }
  const core = (p.kategori || '').replace(/^Kommende\s*/i, '').replace(/^Tidligere\s*/i, '');
  if (core === 'Betalingszone') return 'pay';
  if (core === 'Beboerzone' || core === 'Adressebeboerzone' || core === 'Flexzone') return 'license';
  if (/Zone med tidsrestriktion|Prikgade/i.test(core)) return 'restricted';
  if (/Uden for betalingszone/i.test(core)) return 'free';
  return 'other';
}

window.ParkRules = {
  evaluateZone, isFreeNow, zoneClass, computeCost,
  cphFirstHourFree, frbIsPaidHour, CPH_TARIFFS, FRB_SCHEDULE, BAND_LABELS,
};
})();
