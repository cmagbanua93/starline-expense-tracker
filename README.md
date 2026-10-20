# StarLine Bills & Expenses

A password-protected web app for tracking StarLine's monthly expenses — the bills
that are the same every month, the ones that change, and the one-offs — with a
report per month and per year.

Deployed on Railway, backed by Postgres.

## What it does

- **Administrator sign in.** One account. The passcode is stored only as a scrypt
  hash; the session is a `HttpOnly` `Secure` cookie valid for 30 days. Ten failed
  attempts from one IP locks logins for 15 minutes.
- **Master expense list.** Every recurring bill, marked *fixed* (carries its amount
  into each new month) or *varies* (left blank for you to encode), with an optional
  due day and usual payment method.
- **Monthly entry.** Build a month from the list in one click, fill in the amounts
  that change, record the date each bill was paid. Status is computed, never typed:
  Paid / Overdue / Pending. Income lines are recorded alongside.
- **Reports.** Month or full year — totals, net, outstanding, category breakdown with
  shares, payment status, every line, plus CSV download and a print stylesheet for PDF.
- **Autosave.** Every change is written to Postgres about a second after you stop
  typing, with a version check so two open windows can't silently overwrite each
  other. A local copy in the browser covers a dropped connection.

## Bill automation

Money moves at the source — bank auto-debit arrangements (ADA) and GCash scheduled
payments. The app does not hold bank or GCash credentials and never initiates a
payment. What it automates is everything around the payment:

- **Bills page.** Each bill records how it is paid (auto-debit, GCash scheduled, or
  manual), whether the enrollment is confirmed, which account funds it, and the
  biller account number used to recognise receipts.
- **Receipt inbox.** `POST /api/ingest` accepts payment confirmations (email or SMS
  text). The server reads the amount, reference number and date, matches the bill by
  account number, keywords and expected amount, and marks the closest unpaid line
  as paid. Unclear matches wait in the Autopay center for one click. Duplicates
  (same message or reference) and promos are ignored.
- **Gmail forwarder.** `automation/gmail-forwarder.gs` is a Google Apps Script that
  runs in your own Gmail every 10 minutes and posts receipts to the inbox. Get it
  pre-filled from *Settings → Receipt forwarding*.
- **Paste a receipt.** For anything paid by hand: paste the SMS/email in the Autopay
  center, confirm, done.
- **Reminders.** Every 10 minutes the server builds the new month on the 1st and,
  once a day at the chosen hour (Asia/Manila), sends a digest of overdue bills, bills
  due within the lead time, and accounts that need topping up. Channels: ntfy push,
  Telegram, or any webhook — configured in Settings.
- **Funding plan.** Totals what each GCash/bank account must hold for the next 7 and
  30 days and flags shortfalls against the balance you record.

## Architecture

Deliberately small: an Express server, the `pg` driver, and one self-contained HTML
page. No build step, no framework, no bundler — `npm start` is the whole story.

```
server.js                      API, auth, migrations, receipt inbox, scheduler
automation.js                  receipt parsing, bill matching, overview, digest
automation/gmail-forwarder.gs  Google Apps Script that forwards receipt emails
seed.js                        the expense list a fresh database starts with
public/index.html              the entire client
public/logo.webp               StarLine logo
```

The ledger lives in a single `jsonb` row (`ledger_state`) with an incrementing
version. `GET /api/state` returns it; `PUT /api/state` accepts `{data, version}` and
rejects with `409` if the version moved on — the client then reloads the winning copy.

| Table | Holds |
|---|---|
| `ledger_state` | the ledger document, its version, last-updated time |
| `app_admin` | the administrator username and scrypt password hash |
| `app_session` | live session ids and their expiry |
| `app_config` | ingest token and notification channel settings |
| `payment_event` | every receipt received, what it matched, and the result |
| `notification_log` | every reminder and confirmation sent |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | On Railway: `${{Postgres.DATABASE_URL}}` |
| `ADMIN_PASSWORD` | first boot only | Creates the administrator. Ignored once the account exists — change the passcode from Settings after that. |
| `ADMIN_USERNAME` | no | Defaults to `admin`. |
| `PORT` | no | Railway sets this. |
| `INGEST_TOKEN` | no | Overrides the receipt-inbox token generated at first boot. |
| `NTFY_TOPIC`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NOTIFY_WEBHOOK_URL` | no | Override the channels set in Settings. |
| `TZ_NAME` | no | Time zone for due dates and the digest. Defaults to `Asia/Manila`. |

## Running locally

```bash
npm install
createdb starline
DATABASE_URL=postgres://localhost/starline ADMIN_PASSWORD='choose-something-long' npm start
```

Then open <http://localhost:3000>. Tables are created and the expense list seeded on
first start.

## Deploying

Push to `main`. Railway builds and deploys the service automatically. The health
check is `GET /healthz`, which also pings the database.
