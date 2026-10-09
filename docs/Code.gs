/**
 * Hotel Tannenhof Hinterzarten – Buchungs-Backend (Google Apps Script)
 * --------------------------------------------------------
 * Ein Google Sheet dient als "Hotelsystem". Dieses Script ist die Web-App dahinter:
 * ElevenLabs-Agenten (Chat + Telefon) und die Website rufen es per HTTP auf.
 *
 * Aktionen (Parameter "action"):
 *   check_availability  check_in, check_out, [guests], [category]
 *   book_room           category, check_in, check_out, guests, name, phone, [email], [source]
 *   check_table         restaurant, date, persons, [time]
 *   book_table          restaurant, date, time, persons, name, phone, [source]
 *   info                liefert nur das heutige Datum (hilft dem Agenten bei "morgen", "nächsten Freitag")
 *
 * Datumsformat immer JJJJ-MM-TT (z. B. 2026-10-22), Uhrzeit HH:MM.
 * Jede Antwort enthält "heute" und "wochentag_heute".
 *
 * Einrichtung: siehe ANLEITUNG.md. Einmalig die Funktion setup() ausführen.
 */

const TOKEN = 'tannenhof-demo';          // muss mit dem Token in ElevenLabs und auf der Website übereinstimmen
const TZ = 'Europe/Berlin';
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const SHEET = {
  zimmer: 'Zimmer',
  buchungen: 'Zimmerbuchungen',
  restaurants: 'Restaurants',
  tische: 'Tischreservierungen'
};

/* ============ HTTP-Einstieg ============ */

function doGet(e) {
  return handle_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  const params = Object.assign({}, (e && e.parameter) || {}, body);
  return handle_(params);
}

function handle_(p) {
  let result;
  try {
    if (String(p.token || '') !== TOKEN) {
      result = { ok: false, error: 'Nicht autorisiert.' };
    } else {
      const actions = { check_availability, book_room, check_table, book_table, info: () => ({ ok: true }) };
      const fn = actions[String(p.action || '')];
      result = fn ? fn(p) : { ok: false, error: 'Unbekannte Aktion. Erlaubt: ' + Object.keys(actions).join(', ') };
    }
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }
  const now = new Date();
  result.heute = fmtDate_(now);
  result.wochentag_heute = WOCHENTAGE[Number(Utilities.formatDate(now, TZ, 'u')) % 7];
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ Zimmer ============ */

function check_availability(p) {
  const stay = parseStay_(p.check_in, p.check_out);
  const guests = Number(p.guests || 0);
  const rooms = readRooms_();
  const bookings = readTable_(SHEET.buchungen).filter(b => String(b['Status']) !== 'Storniert');

  let list = rooms;
  if (p.category) {
    const c = findRoom_(rooms, p.category);
    if (!c) return { ok: false, error: 'Zimmerkategorie unbekannt. Verfügbar: ' + rooms.map(r => r.name).join(', ') };
    list = [c];
  }

  const categories = list.map(r => {
    const available = freeRooms_(r, stay, bookings);
    return {
      id: r.id,
      name: r.name,
      max_personen: r.max,
      available: available,
      preis_pro_nacht: r.price,
      total_price: totalPrice_(r.price, stay),
      passt_fuer_personenzahl: guests ? guests <= r.max : true
    };
  });

  return {
    ok: true,
    check_in: stay.inStr,
    check_out: stay.outStr,
    nights: stay.nights,
    hinweis: 'Preise pro Nacht für 2 Personen inkl. Frühstück und Spa. 20.12.–06.01. +20 %.',
    categories: categories
  };
}

function book_room(p) {
  required_(p, ['category', 'check_in', 'check_out', 'name', 'phone']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const stay = parseStay_(p.check_in, p.check_out);
    const rooms = readRooms_();
    const r = findRoom_(rooms, p.category);
    if (!r) return { ok: false, error: 'Zimmerkategorie unbekannt. Verfügbar: ' + rooms.map(x => x.name).join(', ') };
    const guests = Number(p.guests || 2);
    if (guests > r.max) return { ok: false, error: r.name + ' ist für maximal ' + r.max + ' Personen.' };

    const bookings = readTable_(SHEET.buchungen).filter(b => String(b['Status']) !== 'Storniert');
    if (freeRooms_(r, stay, bookings) < 1) return { ok: false, error: r.name + ' ist im gewünschten Zeitraum ausgebucht.' };

    const id = 'TH-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + rand_();
    const total = totalPrice_(r.price, stay);
    sheet_(SHEET.buchungen).appendRow([
      id, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), r.id, r.name,
      stay.inStr, stay.outStr, stay.nights, guests,
      String(p.name), "'" + String(p.phone), String(p.email || ''), total,
      String(p.source || 'Telefon'), 'Bestätigt'
    ]);
    return {
      ok: true, booking_id: id, kategorie: r.name, check_in: stay.inStr, check_out: stay.outStr,
      nights: stay.nights, personen: guests, total_price: total,
      hinweis: 'Kostenfreie Stornierung bis 7 Tage vor Anreise. Check-in ab 15 Uhr.'
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============ Tische ============ */

function check_table(p) {
  required_(p, ['restaurant', 'date']);
  const rest = findRestaurant_(p.restaurant);
  const date = parseDate_(p.date, 'date');
  const persons = Number(p.persons || 2);
  const closed = closedReason_(rest, date);
  if (closed) return { ok: true, restaurant: rest.name, date: fmtDate_(date), open: false, hinweis: closed };

  const slots = rest.slots.map(t => ({ time: t, free_tables: freeTables_(rest, fmtDate_(date), t) }))
    .filter(s => s.free_tables >= tablesNeeded_(persons));
  const wanted = p.time ? slots.find(s => s.time === normTime_(p.time)) : null;
  return {
    ok: true, restaurant: rest.name, date: fmtDate_(date), wochentag: WOCHENTAGE[date.getDay()], open: true,
    gewuenschte_zeit_frei: p.time ? Boolean(wanted) : null,
    freie_zeiten: slots.map(s => s.time)
  };
}

function book_table(p) {
  required_(p, ['restaurant', 'date', 'time', 'persons', 'name']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rest = findRestaurant_(p.restaurant);
    const date = parseDate_(p.date, 'date');
    if (fmtDate_(date) < fmtDate_(new Date())) return { ok: false, error: 'Das Datum liegt in der Vergangenheit.' };
    const time = normTime_(p.time);
    const persons = Number(p.persons);
    if (!(persons >= 1 && persons <= 12)) return { ok: false, error: 'Online maximal 12 Personen. Größere Gruppen bitte über die Rezeption.' };
    const closed = closedReason_(rest, date);
    if (closed) return { ok: false, error: closed };
    if (rest.slots.indexOf(time) < 0) return { ok: false, error: 'Mögliche Uhrzeiten (' + rest.name + '): ' + rest.slots.join(', ') };
    if (freeTables_(rest, fmtDate_(date), time) < tablesNeeded_(persons)) {
      return { ok: false, error: 'Um ' + time + ' Uhr ist leider kein Tisch mehr frei.' };
    }
    const id = 'T-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + rand_();
    sheet_(SHEET.tische).appendRow([
      id, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), rest.name, fmtDate_(date), "'" + time,
      persons, String(p.name), "'" + String(p.phone || ''), String(p.source || 'Telefon'), 'Bestätigt'
    ]);
    return { ok: true, reservation_id: id, restaurant: rest.name, date: fmtDate_(date), time: time, persons: persons };
  } finally {
    lock.releaseLock();
  }
}

/* ============ Hilfsfunktionen ============ */

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tabellenblatt "' + name + '" fehlt. Bitte setup() ausführen.');
  return sh;
}

function readTable_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift();
  return values.filter(r => r.join('') !== '').map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function readRooms_() {
  return readTable_(SHEET.zimmer).map(r => ({
    id: String(r['ID']), name: String(r['Kategorie']), max: Number(r['Max. Personen']),
    count: Number(r['Anzahl Zimmer']), price: Number(r['Preis pro Nacht (€)'])
  }));
}

function findRoom_(rooms, q) {
  const s = norm_(q);
  return rooms.find(r => norm_(r.id) === s) ||
         rooms.find(r => norm_(r.name).indexOf(s) >= 0 || s.indexOf(norm_(r.id)) >= 0);
}

function findRestaurant_(q) {
  const s = norm_(q);
  const rows = readTable_(SHEET.restaurants).map(r => ({
    name: String(r['Restaurant']),
    tables: Number(r['Tische pro Zeitfenster']),
    closedDays: String(r['Ruhetage (0=So … 6=Sa)']).split(',').map(x => x.trim()).filter(String).map(Number),
    slots: String(r['Zeitfenster']).split(',').map(x => normTime_(x))
  }));
  const r = rows.find(x => norm_(x.name).indexOf(s) >= 0 || s.indexOf(norm_(x.name)) >= 0);
  if (!r) throw new Error('Restaurant unbekannt. Verfügbar: ' + rows.map(x => x.name).join(', '));
  return r;
}

function freeRooms_(room, stay, bookings) {
  let maxOccupied = 0;
  for (let d = new Date(stay.in); d < stay.out; d.setDate(d.getDate() + 1)) {
    const day = fmtDate_(d);
    const occ = bookings.filter(b => String(b['Kategorie-ID']) === room.id &&
      cellDate_(b['Anreise']) <= day && cellDate_(b['Abreise']) > day).length;
    maxOccupied = Math.max(maxOccupied, occ);
  }
  return Math.max(0, room.count - maxOccupied);
}

function freeTables_(rest, dateStr, time) {
  const used = readTable_(SHEET.tische).filter(t =>
    String(t['Status']) !== 'Storniert' && String(t['Restaurant']) === rest.name &&
    cellDate_(t['Datum']) === dateStr && normTime_(t['Uhrzeit']) === time
  ).reduce((sum, t) => sum + tablesNeeded_(Number(t['Personen'])), 0);
  return Math.max(0, rest.tables - used);
}

function tablesNeeded_(persons) { return Math.max(1, Math.ceil(persons / 6)); }

function closedReason_(rest, date) {
  if (rest.closedDays.indexOf(date.getDay()) >= 0) {
    return rest.name + ': ' + WOCHENTAGE[date.getDay()].toLowerCase() + 's Ruhetag.';
  }
  return '';
}

function totalPrice_(price, stay) {
  let total = 0;
  for (let d = new Date(stay.in); d < stay.out; d.setDate(d.getDate() + 1)) {
    const md = (d.getMonth() + 1) * 100 + d.getDate();
    total += (md >= 1220 || md <= 106) ? price * 1.2 : price;
  }
  return Math.round(total);
}

function parseStay_(inStr, outStr) {
  const a = parseDate_(inStr, 'check_in'), b = parseDate_(outStr, 'check_out');
  if (fmtDate_(a) < fmtDate_(new Date())) throw new Error('Das Anreisedatum liegt in der Vergangenheit.');
  const nights = Math.round((b - a) / 86400000);
  if (nights < 1) throw new Error('Die Abreise muss nach der Anreise liegen.');
  if (nights > 21) throw new Error('Online maximal 21 Nächte. Längere Aufenthalte bitte über die Rezeption.');
  return { in: a, out: b, inStr: fmtDate_(a), outStr: fmtDate_(b), nights: nights };
}

function parseDate_(v, field) {
  const s = cellDate_(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('Feld "' + field + '" bitte im Format JJJJ-MM-TT angeben.');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

function cellDate_(v) {
  if (v instanceof Date) return fmtDate_(v);
  return String(v || '').trim().slice(0, 10);
}

function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

function normTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = /(\d{1,2})[:.]?(\d{2})?/.exec(String(v));
  if (!m) return String(v);
  return ('0' + m[1]).slice(-2) + ':' + (m[2] || '00');
}

function norm_(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

function required_(p, fields) {
  const missing = fields.filter(f => p[f] === undefined || String(p[f]).trim() === '');
  if (missing.length) throw new Error('Es fehlen Angaben: ' + missing.join(', '));
}

function rand_() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

/* ============ Einmalige Einrichtung ============ */

/**
 * Legt alle Tabellenblätter mit Stammdaten und ein paar Beispielbuchungen an.
 * Achtung: überschreibt vorhandene Blätter mit gleichem Namen.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const make = (name, head, rows) => {
    let sh = ss.getSheetByName(name);
    if (sh) sh.clear(); else sh = ss.insertSheet(name);
    sh.getRange(1, 1, rows.length + 1, head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#22402F').setFontColor('#FFFFFF');
    if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, head.length);
    return sh;
  };

  make(SHEET.zimmer, ['ID', 'Kategorie', 'Größe (m²)', 'Max. Personen', 'Anzahl Zimmer', 'Preis pro Nacht (€)'], [
    ['CLASSIC', 'Doppelzimmer Classic', 24, 2, 14, 189],
    ['SUPERIOR', 'Doppelzimmer Superior', 30, 2, 12, 229],
    ['FAMILIE', 'Familienzimmer', 42, 4, 6, 279],
    ['JUNIORSUITE', 'Junior Suite', 45, 3, 6, 319],
    ['SUITE', 'Panorama-Suite', 70, 2, 2, 529]
  ]);

  make(SHEET.restaurants, ['Restaurant', 'Tische pro Zeitfenster', 'Ruhetage (0=So … 6=Sa)', 'Zeitfenster'], [
    ['Belvedere', 6, '1,2', '18:00,18:30,19:00,19:30,20:00,20:30,21:00'],
    ['Kaminstube', 10, '', '12:00,12:30,13:00,13:30,18:00,18:30,19:00,19:30,20:00,20:30,21:00']
  ]);

  // Beispielbuchungen relativ zu heute, damit die Verfügbarkeit realistisch schwankt
  const base = new Date(); base.setHours(12, 0, 0, 0);
  const day = n => { const d = new Date(base); d.setDate(d.getDate() + n); return fmtDate_(d); };
  const rooms = { CLASSIC: ['Doppelzimmer Classic', 189], SUPERIOR: ['Doppelzimmer Superior', 229], FAMILIE: ['Familienzimmer', 279], JUNIORSUITE: ['Junior Suite', 319], SUITE: ['Panorama-Suite', 529] };
  const plan = [ // [Kategorie, Start in Tagen, Nächte, Anzahl Zimmer]
    ['CLASSIC', 1, 3, 9], ['SUPERIOR', 1, 2, 10], ['SUITE', 2, 4, 2], ['JUNIORSUITE', 3, 2, 4],
    ['FAMILIE', 5, 5, 5], ['CLASSIC', 6, 2, 12], ['SUPERIOR', 7, 3, 7], ['SUITE', 12, 2, 1],
    ['CLASSIC', 13, 2, 6], ['SUPERIOR', 13, 2, 11], ['JUNIORSUITE', 14, 3, 6], ['FAMILIE', 20, 7, 3]
  ];
  const namen = ['Familie Weber', 'Herr Keller', 'Frau Brandt', 'Familie Okafor', 'Herr Rossi', 'Frau Lindqvist', 'Familie Huber', 'Frau Demir'];
  const bRows = [];
  let k = 0;
  plan.forEach(([cat, start, nights, count]) => {
    for (let i = 0; i < count; i++) {
      k++;
      bRows.push(['TH-DEMO-' + ('00' + k).slice(-3), day(-5), cat, rooms[cat][0], day(start), day(start + nights), nights, 2,
        namen[k % namen.length], '+49 151 000000' + (k % 10), '', rooms[cat][1] * nights, 'Demo-Daten', 'Bestätigt']);
    }
  });
  make(SHEET.buchungen, ['Buchungs-Nr', 'Erstellt', 'Kategorie-ID', 'Kategorie', 'Anreise', 'Abreise', 'Nächte', 'Personen',
    'Name', 'Telefon', 'E-Mail', 'Gesamtpreis (€)', 'Quelle', 'Status'], bRows);

  const tRows = [];
  for (let n = 0; n < 14; n++) {
    const d = new Date(base); d.setDate(d.getDate() + n);
    const wd = d.getDay();
    if (wd === 5 || wd === 6) { // Freitag und Samstag: Belvedere um 19:00 fast voll
      for (let i = 0; i < 5; i++) tRows.push(['T-DEMO-' + n + i, day(-3), 'Belvedere', fmtDate_(d), '19:00', 2, namen[i], '', 'Demo-Daten', 'Bestätigt']);
    }
    tRows.push(['T-DEMO-K' + n, day(-3), 'Kaminstube', fmtDate_(d), '18:30', 4, namen[n % namen.length], '', 'Demo-Daten', 'Bestätigt']);
  }
  make(SHEET.tische, ['Res-Nr', 'Erstellt', 'Restaurant', 'Datum', 'Uhrzeit', 'Personen', 'Name', 'Telefon', 'Quelle', 'Status'], tRows);

  const first = ss.getSheets()[0];
  if (Object.values(SHEET).indexOf(first.getName()) < 0 && first.getLastRow() === 0) ss.deleteSheet(first);
}

/** Schnelltest im Editor: Ergebnis erscheint im Ausführungsprotokoll. */
function testLokal() {
  const inTwoWeeks = new Date(); inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  const out = new Date(inTwoWeeks); out.setDate(out.getDate() + 2);
  Logger.log(JSON.stringify(check_availability({ check_in: fmtDate_(inTwoWeeks), check_out: fmtDate_(out) }), null, 2));
  Logger.log(JSON.stringify(check_table({ restaurant: 'Belvedere', date: fmtDate_(inTwoWeeks), persons: 2 }), null, 2));
}
