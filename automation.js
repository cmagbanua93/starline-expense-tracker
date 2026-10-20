'use strict';

// Bill automation for StarLine Ledger.
//
// Nothing here moves money. Payments happen at the source (bank auto-debit,
// GCash scheduled payments, or by hand); this module keeps the ledger in step:
//   - reads payment receipts (email or pasted text) and works out which bill they settle
//   - marks the matching month's line as paid
//   - works out what is due soon, what is overdue, and how much each funding
//     account needs to hold so auto-debits don't bounce
//   - writes the daily reminder digest

const TZ = process.env.TZ_NAME || 'Asia/Manila';

const PAY_MODES = ['auto-debit', 'scheduled', 'manual'];
const DEFAULT_FUNDING = [
  { id: 'gcash', name: 'GCash' },
  { id: 'bpi', name: 'BPI' },
  { id: 'unionbank', name: 'UnionBank' },
  { id: 'bdo', name: 'BDO' },
  { id: 'eastwest', name: 'EastWest' }
];
const KNOWN_BILLERS = ['GLOBE', 'PLDT', 'VECO', 'MERALCO', 'BPI', 'EASTWEST', 'UNIONBANK', 'BDO', 'HOME CREDIT', 'CONVERGE', 'SMART'];

/* ------------------------------------------------------------- dates --- */

function manilaParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(d || new Date());
  const o = {};
  parts.forEach(function (p) { o[p.type] = p.value; });
  return { date: o.year + '-' + o.month + '-' + o.day, hour: Number(o.hour), key: o.year + '-' + o.month };
}
function todayISO() { return manilaParts().date; }
function monthKeyOf(iso) { return String(iso).slice(0, 7); }
function daysIn(key) { const p = key.split('-'); return new Date(Number(p[0]), Number(p[1]), 0).getDate(); }
function dueISO(key, day) {
  const p = key.split('-');
  const d = day ? Math.min(Number(day), daysIn(key)) : daysIn(key);
  return p[0] + '-' + p[1] + '-' + String(d).padStart(2, '0');
}
function addMonths(key, n) {
  const p = key.split('-');
  let y = Number(p[0]), m = Number(p[1]) + n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}
function dayDiff(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }
function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

/* ----------------------------------------------------------- upgrade --- */

function guessFund(method) {
  const m = String(method || '').toLowerCase();
  if (m.indexOf('gcash') >= 0) return 'gcash';
  if (m.indexOf('bpi') >= 0) return 'bpi';
  if (m.indexOf('union') >= 0) return 'unionbank';
  if (m.indexOf('bdo') >= 0) return 'bdo';
  if (m.indexOf('eastwest') >= 0) return 'eastwest';
  return '';
}
function guessKeys(name) {
  const up = String(name || '').toUpperCase();
  return KNOWN_BILLERS.filter(function (b) { return up.indexOf(b) >= 0; })
    .map(function (b) { return b.charAt(0) + b.slice(1).toLowerCase(); }).join(', ');
}

// Brings an older ledger document up to the shape this version expects.
// Only adds fields; never changes what the owner already set.
function upgradeDoc(d) {
  if (!d || typeof d !== 'object') return d;
  d.v = Math.max(Number(d.v) || 1, 2);
  d.meta = d.meta || { org: 'StarLine', currency: '₱', updatedAt: null };
  d.months = d.months || {};
  d.cats = Array.isArray(d.cats) ? d.cats : [];
  d.groups = Array.isArray(d.groups) ? d.groups : [];
  d.methods = Array.isArray(d.methods) ? d.methods : [];
  ['BPI', 'UnionBank', 'BDO', 'EastWest'].forEach(function (m) { if (d.methods.indexOf(m) < 0) d.methods.push(m); });
  if (!Array.isArray(d.funding) || !d.funding.length) {
    d.funding = DEFAULT_FUNDING.map(function (f) { return { id: f.id, name: f.name, balance: null, asOf: null }; });
  }
  d.automation = Object.assign({ leadDays: 3, autoCreateMonth: true, notifyOnPayment: true, digestHour: 8 }, d.automation || {});
  d.cats.forEach(function (c) {
    if (PAY_MODES.indexOf(c.payMode) < 0) c.payMode = /auto/i.test(c.method || '') ? 'auto-debit' : 'manual';
    if (typeof c.enrolled !== 'boolean') c.enrolled = false;
    if (c.fundFrom === undefined) c.fundFrom = guessFund(c.method);
    if (c.accountNo === undefined) {
      const digits = String(c.detail || '').replace(/[\s-]/g, '');
      c.accountNo = /^\d{6,}$/.test(digits) ? digits : '';
    }
    if (c.matchKeys === undefined) c.matchKeys = guessKeys(c.name);
  });
  return d;
}

/* -------------------------------------------------------- month rows --- */

function uid() { return 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
function rowFromCat(c) {
  return {
    id: uid(), catId: c.id, name: c.name, detail: c.detail || '', group: c.group,
    kind: c.kind, amount: (c.kind === 'fixed' ? (c.amount == null ? null : c.amount) : null),
    dueDay: c.dueDay || null, paidOn: '', method: c.method || '', note: ''
  };
}
// Same behaviour as "Build the month from my expense list" in the app.
function seedMonth(d, key) {
  if (!d.months[key]) d.months[key] = { income: [], rows: [], note: '' };
  const m = d.months[key], have = {};
  m.rows.forEach(function (r) { if (r.catId) have[r.catId] = true; });
  let added = 0;
  d.cats.forEach(function (c) {
    if (!c.active || have[c.id]) return;
    m.rows.push(rowFromCat(c)); added++;
  });
  return added;
}

/* ----------------------------------------------------------- parsing --- */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function toNum(s) { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

function findAmount(t) {
  // Money written with a currency marker: PHP 1,234.00 / Php1234 / ₱ 1,234.50 / P1,234.00
  const money = /(?:^|[^A-Za-z])(?:PHP|Php|php|₱|P)\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/g;
  const found = [];
  let m;
  while ((m = money.exec(t))) {
    const v = toNum(m[1]);
    if (v != null && v > 0) found.push({ v: v, at: m.index });
  }
  // "Amount: 1,234.00" without a currency marker
  const labelled = /(?:amount(?: paid| due)?|total(?: amount)?|payment)\s*[:\-]?\s*(?:PHP|₱|P)?\s?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/gi;
  while ((m = labelled.exec(t))) {
    const v = toNum(m[1]);
    if (v != null && v > 0) found.push({ v: v, at: m.index, labelled: true });
  }
  if (!found.length) return null;
  // Prefer an amount that sits right after words like "amount", "paid", "total".
  const cue = /(amount|paid|payment|total|debited|deducted)/gi;
  let best = null, bestDist = Infinity;
  found.forEach(function (f) {
    cue.lastIndex = 0;
    let c;
    while ((c = cue.exec(t))) {
      const dist = f.at - c.index;
      if (dist >= 0 && dist < 60 && dist < bestDist) { best = f; bestDist = dist; }
    }
  });
  return (best || found[0]).v;
}

function findRef(t) {
  const re = /(?:ref(?:erence)?\.?\s*(?:no\.?|number|#|code|id)?|transaction\s*(?:no\.?|id|number|reference)|confirmation\s*(?:no\.?|number|code)|trace\s*no\.?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{5,})/i;
  const m = re.exec(t);
  return m ? m[1].replace(/-+$/, '') : '';
}

function validDate(y, mo, d) {
  if (!(y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function findDate(t) {
  let m;
  if ((m = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(t))) return validDate(+m[1], +m[2], +m[3]);
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/i.exec(t))) {
    return validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  }
  if ((m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})/i.exec(t))) {
    return validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  }
  // Philippine banks write MM/DD/YYYY
  if ((m = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/.exec(t))) return validDate(+m[3], +m[1], +m[2]);
  return '';
}

function parseReceipt(text, receivedAt) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const fallback = receivedAt ? manilaParts(new Date(receivedAt)).date : todayISO();
  let date = findDate(t);
  // A date far from when the message arrived is probably a due date or statement date.
  if (!date || Math.abs(dayDiff(date, fallback)) > 45) date = fallback;
  return { amount: findAmount(t), ref: findRef(t), date: date };
}

/* ---------------------------------------------------------- matching --- */

function expectedAmount(d, cat) {
  // The most recent recorded amount for this bill, else its list amount.
  const keys = Object.keys(d.months).sort().reverse();
  for (let i = 0; i < keys.length; i++) {
    const rows = d.months[keys[i]].rows || [];
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].catId === cat.id && rows[j].amount != null && rows[j].amount !== '') return Number(rows[j].amount);
    }
  }
  return cat.amount == null ? null : Number(cat.amount);
}

function matchBill(d, text, amount) {
  const up = String(text || '').toUpperCase();
  const digits = String(text || '').replace(/\D/g, '');
  const out = [];
  d.cats.forEach(function (c) {
    if (!c.active) return;
    let score = 0;
    const why = [];
    const acct = String(c.accountNo || '').replace(/\D/g, '');
    if (acct.length >= 6 && digits.indexOf(acct) >= 0) { score += 100; why.push('account number'); }
    else if (acct.length >= 4) {
      const last4 = acct.slice(-4);
      if (new RegExp('[*xX•]{2,}\\s?' + last4 + '(?!\\d)').test(text || '')) { score += 40; why.push('account ending ' + last4); }
    }
    let kw = 0;
    String(c.matchKeys || '').split(',').map(function (k) { return k.trim().toUpperCase(); })
      .filter(function (k) { return k.length >= 3; })
      .forEach(function (k) { if (up.indexOf(k) >= 0 && kw < 30) { kw += 15; why.push('"' + k.toLowerCase() + '"'); } });
    score += kw;
    if (score > 0 && amount != null) {
      const exp = expectedAmount(d, c);
      // GCash adds a small convenience fee, so allow a few pesos either way.
      if (exp != null && Math.abs(Number(amount) - exp) <= Math.max(15, exp * 0.005)) { score += 25; why.push('amount'); }
    }
    if (score > 0) out.push({ catId: c.id, name: c.name, score: score, why: why });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  const top = out[0], second = out[1];
  let best = null;
  if (top && top.score >= 15 && (!second || top.score - second.score >= 15)) best = top.catId;
  return { best: best, candidates: out.slice(0, 5) };
}

/* ---------------------------------------------------------- applying --- */

function rowDue(key, r) { return dueISO(key, r.dueDay); }

// Marks the open line for `catId` that is closest to the payment date as paid.
// Returns { status, monthKey, rowId } — status is applied | duplicate | no_open_line.
function applyPayment(d, p) {
  const cat = d.cats.find(function (c) { return c.id === p.catId; });
  if (!cat) return { status: 'unknown_bill' };
  const paidOn = p.paidOn || todayISO();
  const pk = monthKeyOf(paidOn);
  const keys = [addMonths(pk, -1), pk, addMonths(pk, 1)];

  if (p.ref) {
    for (let i = 0; i < keys.length; i++) {
      const m = d.months[keys[i]];
      if (m && m.rows.some(function (r) { return r.catId === p.catId && r.ref === p.ref; })) {
        return { status: 'duplicate', monthKey: keys[i] };
      }
    }
  }
  if (!d.months[pk] || !d.months[pk].rows.some(function (r) { return r.catId === p.catId; })) seedMonth(d, pk);

  let pick = null, pickKey = null, pickDist = Infinity;
  keys.forEach(function (k) {
    const m = d.months[k];
    if (!m) return;
    m.rows.forEach(function (r) {
      if (r.catId !== p.catId || r.paidOn) return;
      const dist = Math.abs(dayDiff(rowDue(k, r), paidOn));
      if (dist < pickDist) { pick = r; pickKey = k; pickDist = dist; }
    });
  });
  if (!pick) return { status: 'no_open_line' };

  pick.paidOn = paidOn;
  const fund = (d.funding || []).find(function (f) { return f.id === cat.fundFrom; });
  pick.method = p.method || pick.method || (fund ? fund.name : '');
  if (p.ref) pick.ref = p.ref;
  pick.confirmedBy = p.source || 'receipt';
  if (p.amount != null) {
    if (pick.amount == null || pick.amount === '') pick.amount = Number(p.amount);
    else if (Math.abs(Number(pick.amount) - Number(p.amount)) >= 1) {
      pick.note = 'Receipt showed ₱' + Number(p.amount).toFixed(2) + (pick.note ? ' · ' + pick.note : '');
    }
  }
  return { status: 'applied', monthKey: pickKey, rowId: pick.id, name: pick.name, amount: pick.amount };
}

/* ---------------------------------------------------------- overview --- */

function fmtMoney(d, v) {
  const n = Number(v) || 0;
  return ((d.meta && d.meta.currency) || '₱') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDay(iso) {
  const p = iso.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1] + ' ' + Number(p[2]);
}

// What is coming up, what is late, and what each funding account must hold.
function buildOverview(d, today) {
  today = today || todayISO();
  const tk = monthKeyOf(today);
  const lead = Number(d.automation && d.automation.leadDays) || 3;
  const catBy = {};
  d.cats.forEach(function (c) { catBy[c.id] = c; });
  const items = [];

  [addMonths(tk, -1), tk, addMonths(tk, 1)].forEach(function (k) {
    const m = d.months[k];
    const seen = {};
    if (m) {
      m.rows.forEach(function (r) {
        if (r.catId) seen[r.catId] = true;
        const c = catBy[r.catId] || {};
        items.push({
          monthKey: k, rowId: r.id, catId: r.catId || null, name: r.name,
          amount: r.amount == null || r.amount === '' ? (c.amount == null ? null : Number(c.amount)) : Number(r.amount),
          amountKnown: !(r.amount == null || r.amount === ''),
          due: rowDue(k, r), hasDueDay: !!r.dueDay, paidOn: r.paidOn || '', ref: r.ref || '',
          payMode: c.payMode || 'manual', enrolled: !!c.enrolled, fundFrom: c.fundFrom || '', projected: false
        });
      });
    }
    // Next month is usually not built yet; project it from the bill list so
    // early-month due dates still show up in the 30-day view.
    if (k >= tk && (k > tk || !m)) {
      d.cats.forEach(function (c) {
        if (!c.active || seen[c.id]) return;
        items.push({
          monthKey: k, rowId: null, catId: c.id, name: c.name,
          amount: c.amount == null ? null : Number(c.amount), amountKnown: c.kind === 'fixed' && c.amount != null,
          due: dueISO(k, c.dueDay), hasDueDay: !!c.dueDay, paidOn: '', ref: '',
          payMode: c.payMode, enrolled: !!c.enrolled, fundFrom: c.fundFrom || '', projected: true
        });
      });
    }
  });

  const open = items.filter(function (i) { return !i.paidOn; });
  open.forEach(function (i) { i.daysLeft = dayDiff(i.due, today); });
  const overdue = open.filter(function (i) { return i.daysLeft < 0 && i.monthKey <= tk; })
    .sort(function (a, b) { return a.due < b.due ? -1 : 1; });
  const upcoming = open.filter(function (i) { return i.daysLeft >= 0 && i.daysLeft <= 31; })
    .sort(function (a, b) { return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0); });
  const dueSoon = upcoming.filter(function (i) { return i.daysLeft <= lead; });

  const funding = (d.funding || []).map(function (f) {
    const mine = open.filter(function (i) { return i.fundFrom === f.id && i.daysLeft <= 30; });
    const sum = function (arr) { return arr.reduce(function (a, i) { return a + (Number(i.amount) || 0); }, 0); };
    const need7 = sum(mine.filter(function (i) { return i.daysLeft <= 7; }));
    const need30 = sum(mine);
    const bal = f.balance == null || f.balance === '' ? null : Number(f.balance);
    return {
      id: f.id, name: f.name, balance: bal, asOf: f.asOf || null,
      need7: need7, need30: need30, count: mine.length,
      short7: bal == null ? null : Math.max(0, need7 - bal),
      short30: bal == null ? null : Math.max(0, need30 - bal)
    };
  });

  const active = d.cats.filter(function (c) { return c.active; });
  const coverage = {
    total: active.length,
    autoDebit: active.filter(function (c) { return c.payMode === 'auto-debit' && c.enrolled; }).length,
    scheduled: active.filter(function (c) { return c.payMode === 'scheduled' && c.enrolled; }).length,
    pending: active.filter(function (c) { return c.payMode !== 'manual' && !c.enrolled; }).length,
    manual: active.filter(function (c) { return c.payMode === 'manual'; }).length
  };
  coverage.automated = coverage.autoDebit + coverage.scheduled;

  return { today: today, leadDays: lead, overdue: overdue, upcoming: upcoming, dueSoon: dueSoon, funding: funding, coverage: coverage };
}

function modeLabel(i) {
  if (i.payMode === 'auto-debit') return i.enrolled ? 'auto-debit' : 'auto-debit (not yet enrolled)';
  if (i.payMode === 'scheduled') return i.enrolled ? 'GCash scheduled' : 'GCash scheduled (not yet set up)';
  return 'pay manually';
}

// Plain-text daily digest. Returns '' when there is nothing worth sending.
function digestText(d, ov, reviewCount) {
  const lines = [];
  const fundName = function (id) { const f = (d.funding || []).find(function (x) { return x.id === id; }); return f ? f.name : ''; };
  ov.overdue.forEach(function (i) {
    const auto = i.payMode !== 'manual' && i.enrolled;
    lines.push('🔴 OVERDUE · ' + i.name + ' · ' + fmtMoney(d, i.amount) + ' · was due ' + fmtDay(i.due) +
      (auto ? ' — auto-payment not confirmed yet, check ' + (fundName(i.fundFrom) || 'the account') : ''));
  });
  ov.dueSoon.forEach(function (i) {
    const when = i.daysLeft === 0 ? 'due TODAY' : (i.daysLeft === 1 ? 'due tomorrow' : 'due ' + fmtDay(i.due));
    const f = fundName(i.fundFrom);
    let how;
    if (i.payMode !== 'manual' && i.enrolled) how = 'auto-pays from ' + (f || 'its account') + ' — keep the funds in';
    else how = 'pay ' + (f ? 'via ' + f : 'manually');
    lines.push((i.daysLeft === 0 ? '🟠 ' : '🟡 ') + i.name + ' · ' + (i.amount == null ? 'amount not set' : fmtMoney(d, i.amount)) + ' · ' + when + ' · ' + how);
  });
  ov.funding.forEach(function (f) {
    if (f.short7 && f.short7 > 0) {
      lines.push('💰 ' + f.name + ' needs ' + fmtMoney(d, f.need7) + ' this week but only ' + fmtMoney(d, f.balance) +
        ' is recorded — top up ' + fmtMoney(d, f.short7));
    }
  });
  if (reviewCount > 0) lines.push('🧾 ' + reviewCount + ' receipt' + (reviewCount === 1 ? '' : 's') + ' could not be matched to a bill — open the Autopay center to assign');
  if (!lines.length) return '';
  return 'StarLine bills — ' + fmtDay(ov.today) + '\n\n' + lines.join('\n');
}

module.exports = {
  TZ, PAY_MODES, manilaParts, todayISO, monthKeyOf, addMonths, addDays,
  upgradeDoc, seedMonth, parseReceipt, matchBill, applyPayment, buildOverview, digestText, fmtMoney
};
