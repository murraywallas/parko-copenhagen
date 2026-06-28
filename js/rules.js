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
function nextFreeTime(muni, from) {
  for (let i = 0; i < 24 * 8; i++) {
    const t = new Date(from.getTime() + i * HOUR);
    const paid = muni === 'frb' ? frbIsPaidHour(t) : true; // CPH cobra 24/7
    if (!paid) return t;
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
};
const SOURCE = {
  cph: 'https://www.kk.dk/borger/parkering-trafik-og-veje/parkering/priser-og-parkeringszoner',
  frb: 'https://www.frederiksberg.dk/by-bolig-og-miljoe/trafik/parkering',
};
const MUNI_LABEL = { cph: 'Copenhague', frb: 'Frederiksberg' };

// ----------------------------------------------------------- Cálculo de coste
// Devuelve { total, breakdown:[{hour,price,free}], freeHours, paidHours, capped }
function computeCost(muni, navn, start, durationH) {
  let total = 0, paid = 0, freeHours = 0;
  const breakdown = [];
  for (let i = 0; i < durationH; i++) {
    const slot = new Date(start.getTime() + i * HOUR);
    if (muni === 'frb') {
      if (frbIsPaidHour(slot)) {
        paid++;
        const price = frbSchedulePrice(paid);
        total += price;
        breakdown.push({ hour: i + 1, price, free: false });
      } else {
        freeHours++;
        breakdown.push({ hour: i + 1, price: 0, free: true });
      }
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
function nextPaidTime(muni, from) {
  for (let i = 0; i < 24 * 8; i++) {
    const t = new Date(from.getTime() + i * HOUR);
    const paid = muni === 'frb' ? frbIsPaidHour(t) : true;
    if (paid) return t;
  }
  return null;
}

// ¿Está esta zona "gratis en este momento"? (para el filtro "Gratis ahora")
function isFreeNow(feature, when = new Date()) {
  const p = feature.properties || {};
  const muni = p.municipality || 'cph';
  const core = (p.kategori || '').replace(/^Kommende\s*/i, '').replace(/^Tidligere\s*/i, '');
  if (muni === 'frb') return !frbIsPaidHour(when);
  if (/Uden for betalingszone/i.test(core)) return true;
  if (core === 'Betalingszone') return cphFirstHourFree(when);
  return false; // residentes / restricción no son "gratis para cualquiera"
}

// Clasificación para el filtro de UX.
function zoneClass(feature) {
  const p = feature.properties || {};
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
