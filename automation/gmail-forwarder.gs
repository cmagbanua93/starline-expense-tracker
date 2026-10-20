/**
 * StarLine Ledger — Gmail receipt forwarder
 *
 * Runs inside your own Google account (script.google.com). Every 10 minutes it
 * looks for payment confirmation emails from GCash, your banks and your billers,
 * sends them to your ledger, and labels them "StarLine/Forwarded" so each email
 * is only sent once. The ledger then marks the matching bill as paid.
 *
 * Setup (about 3 minutes):
 *   1. Go to https://script.google.com → New project. Paste this whole file.
 *   2. Fill in LEDGER_URL and INGEST_TOKEN below (copy both from the ledger:
 *      Settings → Receipt forwarding).
 *   3. Choose the function "setup" in the toolbar and press Run. Google asks you
 *      to allow access to Gmail — allow it. That's it.
 *
 * To stop it: Triggers (clock icon on the left) → delete the trigger.
 */

const LEDGER_URL = 'PASTE_THE_INGEST_URL_HERE';     // e.g. https://starline-app-web-production.up.railway.app/api/ingest
const INGEST_TOKEN = 'PASTE_THE_INGEST_TOKEN_HERE';

// Who sends your payment confirmations. Add a sender here if a receipt is missed.
const SENDERS = [
  'gcash', 'bpi.com.ph', 'unionbankph.com', 'bdo.com.ph', 'eastwestbanker.com',
  'pldt', 'globe.com.ph', 'veco', 'visayanelectric', 'aboitizpower'
];
// Words that appear in the subject of a payment confirmation.
const SUBJECT_WORDS = [
  'receipt', 'payment', 'paid', 'debit', 'bills', 'confirmation', 'transaction', 'successful'
];
const LABEL = 'StarLine/Forwarded';
const LOOKBACK = '3d';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'forwardReceipts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('forwardReceipts').timeBased().everyMinutes(10).create();
  forwardReceipts();
  Logger.log('Done. Receipts will be forwarded every 10 minutes.');
}

function forwardReceipts() {
  if (LEDGER_URL.indexOf('PASTE') === 0 || INGEST_TOKEN.indexOf('PASTE') === 0) {
    throw new Error('Fill in LEDGER_URL and INGEST_TOKEN at the top of the script first.');
  }
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const query = 'newer_than:' + LOOKBACK + ' -label:' + LABEL.replace('/', '-') +
    ' {' + SENDERS.map(function (s) { return 'from:' + s; }).join(' ') + '}' +
    ' {' + SUBJECT_WORDS.map(function (w) { return 'subject:' + w; }).join(' ') + '}';
  const threads = GmailApp.search(query, 0, 25);
  if (!threads.length) return;

  const items = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      items.push({
        source: 'email',
        messageId: m.getId(),
        from: m.getFrom(),
        subject: m.getSubject(),
        text: m.getPlainBody().slice(0, 20000),
        receivedAt: m.getDate().toISOString()
      });
    });
  });

  const res = UrlFetchApp.fetch(LEDGER_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + INGEST_TOKEN },
    payload: JSON.stringify({ items: items.slice(0, 50) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Ledger answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  threads.forEach(function (t) { t.addLabel(label); });
  Logger.log('Forwarded ' + items.length + ' email(s): ' + res.getContentText().slice(0, 500));
}
