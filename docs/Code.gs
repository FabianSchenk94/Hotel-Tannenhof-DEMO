/** @OnlyCurrentDoc */
/**
 * Hotel Tannenhof Hinterzarten – Buchungs-Backend (Google Apps Script)
 * --------------------------------------------------------
 * Ein Google Sheet dient als "Hotelsystem". Dieses Script ist die Web-App dahinter:
 * Butler Ferdinand (ElevenLabs, Chat und Sprache) und die Website rufen es per HTTP auf.
 *
 * Aktionen (Parameter "action"):
 *   check_availability  check_in, check_out, [guests], [category]
 *   book_room           category, check_in, check_out, guests, name, phone, [email], [source]
 *   check_table         restaurant, date, persons, [time]
 *   book_table          restaurant, date, time, persons, name, phone, [source]
 *   info                liefert nur das heutige Datum (hilft dem Agenten bei "morgen", "nächsten Freitag")
 *
 * Zwei Schlüssel:
 *   WEB_TOKEN    steht öffentlich in index.html und erlaubt nur Tisch prüfen und reservieren.
 *   AGENT_TOKEN  ist geheim (Projekteinstellungen → Skripteigenschaften) und nur in den
 *                ElevenLabs-Tools hinterlegt. Er erlaubt alle Aktionen.
 *
 * Schutz: Eingaben werden geprüft und gekürzt, Formeln im Sheet verhindert, Buchungen pro Stunde
 * begrenzt und doppelte Buchungen (gleicher Gast, gleiche Daten, 15 Minuten) erkannt.
 *
 * Datumsformat immer JJJJ-MM-TT (z. B. 2026-10-22), Uhrzeit HH:MM.
 * Jede Antwort enthält "heute" und "wochentag_heute".
 *
 * Einrichtung: siehe ANLEITUNG.md. Einmalig setup() und installTriggers() ausführen.
 */

const WEB_TOKEN = 'tannenhof-demo';      // öffentlich, nur für das Tischformular der Website
const TZ = 'Europe/Berlin';
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MAX_TAGE_VORAUS = 365;
const LIMITS = { web: 20, agent: 40 };    // Buchungen pro Stunde je Schlüssel
const QUELLEN = ['Ferdinand', 'Ferdinand Chat', 'Ferdinand Sprache', 'Telefon', 'Website'];

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
    const role = role_(p.token);
    if (!role) {
      result = { ok: false, error: 'Nicht autorisiert.' };
    } else {
      const all = { check_availability, book_room, check_table, book_table, info: () => ({ ok: true }) };
      const allowed = role === 'agent' ? Object.keys(all) : ['check_table', 'book_table', 'info'];
      const action = String(p.action || '');
      if (allowed.indexOf(action) < 0) {
        result = { ok: false, error: 'Unbekannte oder nicht erlaubte Aktion.' };
      } else {
        if (role === 'web') p.source = 'Website';
        if (action.indexOf('book_') === 0) rateLimit_(role);
        result = all[action](p);
      }
    }
  } catch (err) {
    // Eigene Prüf-Fehler sind für Gäste formuliert, alles andere bleibt intern.
    if (err && err.guest) {
      result = { ok: false, error: err.message };
    } else {
      console.error(err && err.stack || err);
      result = { ok: false, error: 'Interner Fehler. Bitte später erneut versuchen.' };
    }
  }
  const now = new Date();
  result.heute = fmtDate_(now);
  result.wochentag_heute = WOCHENTAGE[Number(Utilities.formatDate(now, TZ, 'u')) % 7];
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function role_(token) {
  const t = String(token || '');
  const agent = PropertiesService.getScriptProperties().getProperty('AGENT_TOKEN');
  if (agent && agent.length >= 20 && t === agent) return 'agent';
  if (t === WEB_TOKEN) return 'web';
  return '';
}

function rateLimit_(role) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + role + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  const n = Number(cache.get(key) || 0);
  if (n >= LIMITS[role]) fail_('Im Moment gehen sehr viele Anfragen ein. Bitte versuchen Sie es in einer Stunde erneut.');
  cache.put(key, String(n + 1), 3700);
}

/* ============ Zimmer ============ */

function check_availability(p) {
  const stay = parseStay_(p.check_in, p.check_out);
  const guests = p.guests === undefined || p.guests === '' ? 0 : int_(p.guests, 1, 12, 'Bitte eine Personenzahl zwischen 1 und 12 angeben.');
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
    const guests = int_(p.guests === undefined || p.guests === '' ? 2 : p.guests, 1, r.max,
      r.name + ' ist für 1 bis ' + r.max + ' Personen.');
    const name = name_(p.name);
    const phone = phone_(p.phone, true);
    const email = email_(p.email);
    const source = source_(p.source);

    const dup = readTable_(SHEET.buchungen).find(b => String(b['Status']) !== 'Storniert' &&
      String(b['Kategorie-ID']) === r.id && cellDate_(b['Anreise']) === stay.inStr && cellDate_(b['Abreise']) === stay.outStr &&
      norm_(b['Name']) === norm_(name) && digits_(b['Telefon']) === digits_(phone) && recent_(b['Erstellt']));
    if (dup) return { ok: true, booking_id: String(dup['Buchungs-Nr']), bereits_gebucht: true, kategorie: r.name,
      check_in: stay.inStr, check_out: stay.outStr, nights: stay.nights, personen: Number(dup['Personen']),
      total_price: Number(dup['Gesamtpreis (€)']), hinweis: 'Diese Buchung existiert bereits. Es wurde nichts doppelt gebucht.' };

    const bookings = readTable_(SHEET.buchungen).filter(b => String(b['Status']) !== 'Storniert');
    if (freeRooms_(r, stay, bookings) < 1) return { ok: false, error: r.name + ' ist im gewünschten Zeitraum ausgebucht.' };

    const id = 'TH-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + rand_();
    const total = totalPrice_(r.price, stay);
    sheet_(SHEET.buchungen).appendRow([
      id, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), r.id, r.name,
      stay.inStr, stay.outStr, stay.nights, guests,
      name, "'" + phone, email, total, source, 'Bestätigt'
    ].map(cell_));
    return {
      ok: true, booking_id: id, kategorie: r.name, check_in: stay.inStr, check_out: stay.outStr,
      nights: stay.nights, personen: guests, total_price: total,
      hinweis: 'Demo-Buchung im fiktiven Hotel Tannenhof. Kostenfreie Stornierung bis 7 Tage vor Anreise. Check-in ab 15 Uhr.'
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============ Tische ============ */

function check_table(p) {
  required_(p, ['restaurant', 'date']);
  const rest = findRestaurant_(p.restaurant);
  const date = futureDate_(p.date, 'date');
  const persons = int_(p.persons === undefined || p.persons === '' ? 2 : p.persons, 1, 12,
    'Online maximal 12 Personen. Größere Gruppen bitte per E-Mail.');
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
  required_(p, ['restaurant', 'date', 'time', 'persons', 'name', 'phone']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rest = findRestaurant_(p.restaurant);
    const date = futureDate_(p.date, 'date');
    const time = normTime_(p.time);
    const persons = int_(p.persons, 1, 12, 'Online maximal 12 Personen. Größere Gruppen bitte per E-Mail.');
    const name = name_(p.name);
    const phone = phone_(p.phone, true);
    const source = source_(p.source);
    if (fmtDate_(date) === fmtDate_(new Date()) && time <= Utilities.formatDate(new Date(), TZ, 'HH:mm')) {
      return { ok: false, error: 'Diese Uhrzeit ist heute bereits vorbei.' };
    }
    const closed = closedReason_(rest, date);
    if (closed) return { ok: false, error: closed };
    if (rest.slots.indexOf(time) < 0) return { ok: false, error: 'Mögliche Uhrzeiten (' + rest.name + '): ' + rest.slots.join(', ') };
    if (freeTables_(rest, fmtDate_(date), time) < tablesNeeded_(persons)) {
      return { ok: false, error: 'Um ' + time + ' Uhr ist leider kein Tisch mehr frei.' };
    }
    const dup = readTable_(SHEET.tische).find(t => String(t['Status']) !== 'Storniert' &&
      String(t['Restaurant']) === rest.name && cellDate_(t['Datum']) === fmtDate_(date) &&
      normTime_(t['Uhrzeit']) === time && norm_(t['Name']) === norm_(name) && recent_(t['Erstellt']));
    if (dup) return { ok: true, reservation_id: String(dup['Res-Nr']), bereits_reserviert: true, restaurant: rest.name,
      date: fmtDate_(date), time: time, persons: Number(dup['Personen']),
      hinweis: 'Diese Reservierung existiert bereits. Es wurde nichts doppelt reserviert.' };
    const id = 'T-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + rand_();
    sheet_(SHEET.tische).appendRow([
      id, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), rest.name, fmtDate_(date), "'" + time,
      persons, name, "'" + phone, source, 'Bestätigt'
    ].map(cell_));
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
  if (!r) fail_('Restaurant unbekannt. Verfügbar: ' + rows.map(x => x.name).join(', '));
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
  if (fmtDate_(a) < fmtDate_(new Date())) fail_('Das Anreisedatum liegt in der Vergangenheit.');
  if (fmtDate_(a) > maxDateStr_()) fail_('Buchungen sind höchstens ' + MAX_TAGE_VORAUS + ' Tage im Voraus möglich.');
  const nights = Math.round((b - a) / 86400000);
  if (nights < 1) fail_('Die Abreise muss nach der Anreise liegen.');
  if (nights > 21) fail_('Online maximal 21 Nächte. Längere Aufenthalte bitte per E-Mail anfragen.');
  return { in: a, out: b, inStr: fmtDate_(a), outStr: fmtDate_(b), nights: nights };
}

function parseDate_(v, field) {
  const s = cellDate_(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail_('Feld "' + field + '" bitte im Format JJJJ-MM-TT angeben.');
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
  const label = { category: 'Zimmerkategorie', check_in: 'Anreise', check_out: 'Abreise', name: 'Name', phone: 'Telefonnummer',
    restaurant: 'Restaurant', date: 'Datum', time: 'Uhrzeit', persons: 'Personenzahl' };
  if (missing.length) fail_('Es fehlen Angaben: ' + missing.map(f => label[f] || f).join(', '));
}


/* ============ Prüfung und Bereinigung ============ */

function fail_(msg) {
  const err = new Error(msg);
  err.guest = true;
  throw err;
}

/** Verhindert, dass Eingaben im Sheet als Formel ausgeführt werden. */
function cell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function text_(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function name_(v) {
  const s = text_(v, 80);
  if (s.length < 2 || !/\p{L}/u.test(s)) fail_('Bitte einen gültigen Namen angeben.');
  return s;
}

function phone_(v, needed) {
  const s = text_(v, 30);
  if (!s && !needed) return '';
  if (!/^[+0-9 ()\/.-]+$/.test(s) || digits_(s).length < 6 || digits_(s).length > 15) {
    fail_('Bitte eine gültige Telefonnummer angeben.');
  }
  return s;
}

function email_(v) {
  const s = text_(v, 100);
  if (!s) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) fail_('Die E-Mail-Adresse ist ungültig.');
  return s;
}

function source_(v) {
  const s = text_(v, 30);
  return QUELLEN.indexOf(s) >= 0 ? s : 'Ferdinand';
}

function int_(v, min, max, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail_(msg);
  return n;
}

function digits_(v) { return String(v || '').replace(/\D/g, ''); }

function maxDateStr_() {
  const d = new Date(); d.setDate(d.getDate() + MAX_TAGE_VORAUS);
  return fmtDate_(d);
}

function futureDate_(v, field) {
  const d = parseDate_(v, field);
  if (fmtDate_(d) < fmtDate_(new Date())) fail_('Das Datum liegt in der Vergangenheit.');
  if (fmtDate_(d) > maxDateStr_()) fail_('Reservierungen sind höchstens ' + MAX_TAGE_VORAUS + ' Tage im Voraus möglich.');
  return d;
}

/** true, wenn der Zeitstempel "Erstellt" höchstens 15 Minuten alt ist. */
function recent_(v) {
  const s = v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || '');
  const limit = Utilities.formatDate(new Date(Date.now() - 15 * 60000), TZ, 'yyyy-MM-dd HH:mm');
  return s >= limit;
}

function rand_() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

/* ============ Einmalige Einrichtung ============ */

/**
 * Legt alle Tabellenblätter mit Stammdaten und ein paar Beispielbuchungen an.
 * Achtung: überschreibt vorhandene Blätter mit gleichem Namen.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const make = (name, head, rows, tabColor) => {
    let sh = ss.getSheetByName(name);
    if (sh) sh.clear(); else sh = ss.insertSheet(name);
    sh.getBandings().forEach(b => b.remove());
    const maxRows = Math.max(sh.getMaxRows(), 500);
    if (sh.getMaxRows() < maxRows) sh.insertRowsAfter(sh.getMaxRows(), maxRows - sh.getMaxRows());
    // Alles als Text speichern, damit Datum und Uhrzeit nicht umgewandelt werden
    sh.getRange(1, 1, maxRows, head.length).setNumberFormat('@').setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#22402F').setFontColor('#FFFFFF').setWrap(true);
    sh.setRowHeight(1, 34);
    if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 1, maxRows - 1, head.length).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
      .setFirstRowColor('#FFFFFF').setSecondRowColor('#EEF0EB');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, head.length);
    for (let c = 1; c <= head.length; c++) sh.setColumnWidth(c, Math.max(sh.getColumnWidth(c) + 16, 90));
    if (sh.getMaxColumns() > head.length) sh.deleteColumns(head.length + 1, sh.getMaxColumns() - head.length);
    sh.setTabColor(tabColor);
    return sh;
  };

  make(SHEET.zimmer, ['ID', 'Kategorie', 'Größe (m²)', 'Max. Personen', 'Anzahl Zimmer', 'Preis pro Nacht (€)'], [
    ['CLASSIC', 'Doppelzimmer Classic', 24, 2, 14, 189],
    ['SUPERIOR', 'Doppelzimmer Superior', 30, 2, 12, 229],
    ['FAMILIE', 'Familienzimmer', 42, 4, 6, 279],
    ['JUNIORSUITE', 'Junior Suite', 45, 3, 6, 319],
    ['SUITE', 'Panorama-Suite', 70, 2, 2, 529]
  ], '#22402F');

  make(SHEET.restaurants, ['Restaurant', 'Tische pro Zeitfenster', 'Ruhetage (0=So … 6=Sa)', 'Zeitfenster'], [
    ['Belvedere', 6, '1,2', '18:00,18:30,19:00,19:30,20:00,20:30,21:00'],
    ['Kaminstube', 10, '', '12:00,12:30,13:00,13:30,18:00,18:30,19:00,19:30,20:00,20:30,21:00']
  ], '#A88A4E');

  make(SHEET.buchungen, HEAD_BUCHUNGEN, demoRoomRows_(), '#7D8C55');
  make(SHEET.tische, HEAD_TISCHE, demoTableRows_(), '#16213A');

  // Reihenfolge der Reiter festlegen und leeres Startblatt entfernen
  [SHEET.zimmer, SHEET.buchungen, SHEET.restaurants, SHEET.tische].forEach((n, i) => {
    ss.setActiveSheet(ss.getSheetByName(n)); ss.moveActiveSheet(i + 1);
  });
  ss.getSheets().forEach(sh => {
    if (Object.values(SHEET).indexOf(sh.getName()) < 0 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  ss.setActiveSheet(ss.getSheetByName(SHEET.buchungen));
}


/* ============ Demo-Daten ============ */

const HEAD_BUCHUNGEN = ['Buchungs-Nr', 'Erstellt', 'Kategorie-ID', 'Kategorie', 'Anreise', 'Abreise', 'Nächte', 'Personen',
  'Name', 'Telefon', 'E-Mail', 'Gesamtpreis (€)', 'Quelle', 'Status'];
const HEAD_TISCHE = ['Res-Nr', 'Erstellt', 'Restaurant', 'Datum', 'Uhrzeit', 'Personen', 'Name', 'Telefon', 'Quelle', 'Status'];
const DEMO_NAMEN = ['Familie Weber', 'Herr Keller', 'Frau Brandt', 'Familie Okafor', 'Herr Rossi', 'Frau Lindqvist', 'Familie Huber', 'Frau Demir'];

function demoDay_(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
  return fmtDate_(d);
}

/** Beispielbuchungen relativ zu heute, damit die Verfügbarkeit realistisch schwankt. */
function demoRoomRows_() {
  const rooms = { CLASSIC: ['Doppelzimmer Classic', 189], SUPERIOR: ['Doppelzimmer Superior', 229], FAMILIE: ['Familienzimmer', 279], JUNIORSUITE: ['Junior Suite', 319], SUITE: ['Panorama-Suite', 529] };
  const plan = [ // [Kategorie, Start in Tagen, Nächte, Anzahl Zimmer]
    ['CLASSIC', 1, 3, 9], ['SUPERIOR', 1, 2, 10], ['SUITE', 2, 4, 2], ['JUNIORSUITE', 3, 2, 4],
    ['FAMILIE', 5, 5, 5], ['CLASSIC', 6, 2, 12], ['SUPERIOR', 7, 3, 7], ['SUITE', 12, 2, 1],
    ['CLASSIC', 13, 2, 6], ['SUPERIOR', 13, 2, 11], ['JUNIORSUITE', 14, 3, 6], ['FAMILIE', 20, 7, 3]
  ];
  const rows = [];
  let k = 0;
  plan.forEach(([cat, start, nights, count]) => {
    for (let i = 0; i < count; i++) {
      k++;
      rows.push(['TH-DEMO-' + ('00' + k).slice(-3), demoDay_(-5), cat, rooms[cat][0], demoDay_(start), demoDay_(start + nights), nights, 2,
        DEMO_NAMEN[k % DEMO_NAMEN.length], '+49 151 000000' + (k % 10), '', rooms[cat][1] * nights, 'Demo-Daten', 'Bestätigt']);
    }
  });
  return rows;
}

function demoTableRows_() {
  const rows = [];
  for (let n = 0; n < 14; n++) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
    const wd = d.getDay();
    if (wd === 5 || wd === 6) { // Freitag und Samstag: Belvedere um 19:00 fast voll
      for (let i = 0; i < 5; i++) rows.push(['T-DEMO-' + n + i, demoDay_(-3), 'Belvedere', fmtDate_(d), '19:00', 2, DEMO_NAMEN[i], '', 'Demo-Daten', 'Bestätigt']);
    }
    rows.push(['T-DEMO-K' + n, demoDay_(-3), 'Kaminstube', fmtDate_(d), '18:30', 4, DEMO_NAMEN[n % DEMO_NAMEN.length], '', 'Demo-Daten', 'Bestätigt']);
  }
  return rows;
}

/**
 * Läuft täglich per Trigger: erneuert die Demo-Belegung relativ zu heute und löscht
 * Gast-Buchungen, deren Aufenthalt bzw. Termin länger als 14 Tage vorbei ist.
 */
function rollDemoData() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const cutoff = demoDay_(-14);
    refreshSheet_(SHEET.buchungen, HEAD_BUCHUNGEN, demoRoomRows_(),
      r => r[12] !== 'Demo-Daten' && cellDate_(r[5]) >= cutoff);
    refreshSheet_(SHEET.tische, HEAD_TISCHE, demoTableRows_(),
      r => r[8] !== 'Demo-Daten' && cellDate_(r[3]) >= cutoff);
  } finally {
    lock.releaseLock();
  }
}

function refreshSheet_(name, head, demoRows, keep) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  values.shift();
  const kept = values.filter(r => r.join('') !== '' && keep(r)).map(r => r.map(plain_));
  const rows = demoRows.concat(kept);
  const last = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, 1, last - 1, head.length).clearContent();
  if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
  sh.getRange(2, 1, sh.getMaxRows() - 1, head.length).setNumberFormat('@');
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows.map(r => r.map(v => typeof v === 'number' ? v : cell_(String(v)))));
}

function plain_(v) {
  if (!(v instanceof Date)) return v;
  if (v.getFullYear() < 1901) return Utilities.formatDate(v, TZ, 'HH:mm');
  const t = Utilities.formatDate(v, TZ, 'HH:mm');
  return Utilities.formatDate(v, TZ, 'yyyy-MM-dd') + (t === '00:00' || t === '12:00' ? '' : ' ' + t);
}

/** Einmalig ausführen: richtet den täglichen Trigger für rollDemoData ein (03:00 Uhr). */
function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'rollDemoData').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('rollDemoData').timeBased().everyDays(1).atHour(3).inTimezone(TZ).create();
}

/** Schnelltest im Editor: Ergebnis erscheint im Ausführungsprotokoll. */
function testLokal() {
  const inTwoWeeks = new Date(); inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  const out = new Date(inTwoWeeks); out.setDate(out.getDate() + 2);
  Logger.log(JSON.stringify(check_availability({ check_in: fmtDate_(inTwoWeeks), check_out: fmtDate_(out) }), null, 2));
  Logger.log(JSON.stringify(check_table({ restaurant: 'Belvedere', date: fmtDate_(inTwoWeeks), persons: 2 }), null, 2));
}
