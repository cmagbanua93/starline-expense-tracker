# StarLine Ledger

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

## Architecture

Deliberately small: an Express server, the `pg` driver, and one self-contained HTML
page. No build step, no framework, no bundler — `npm start` is the whole story.

```
server.js          API, auth, migrations (run at startup)
seed.js            the expense list a fresh database starts with
public/index.html  the entire client
```

The ledger lives in a single `jsonb` row (`ledger_state`) with an incrementing
version. `GET /api/state` returns it; `PUT /api/state` accepts `{data, version}` and
rejects with `409` if the version moved on — the client then reloads the winning copy.

| Table | Holds |
|---|---|
| `ledger_state` | the ledger document, its version, last-updated time |
| `app_admin` | the administrator username and scrypt password hash |
| `app_session` | live session ids and their expiry |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | On Railway: `${{Postgres.DATABASE_URL}}` |
| `ADMIN_PASSWORD` | first boot only | Creates the administrator. Ignored once the account exists — change the passcode from Settings after that. |
| `ADMIN_USERNAME` | no | Defaults to `admin`. |
| `PORT` | no | Railway sets this. |

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
