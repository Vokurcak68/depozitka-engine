# Depozitka Engine ⚙️

Backend worker pro Depozitka ekosystém. Běží na Vercelu jako Next.js app s cron joby.

## Architektura

```
depozitka-core        (Vite SPA) ← Admin UI
depozitka-test-bazar  (Vite SPA) ← Marketplace klient
depozitka-engine      (Next.js)  ← Backend worker (tento repo)
```

## Cron jobs

| Endpoint | Popis | Schedule |
|----------|-------|----------|
| `/api/cron/daily-jobs` | Master orchestrátor | Denně 8:00 UTC |
| `/api/cron/fio-sync` | Stahování plateb z FIO, párování dle VS | ↑ voláno z daily-jobs |
| `/api/cron/process-emails` | Odesílání emailů z fronty přes SMTP | ↑ voláno z daily-jobs |
| `/api/cron/fio-payout` | Výplaty prodávajícím přes FIO import | ↑ voláno z daily-jobs |

## Env vars

| Proměnná | Popis |
|----------|-------|
| `SUPABASE_URL` | Depozitka Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `SMTP_HOST` | SMTP host (např. `smtp.forpsi.com`) |
| `SMTP_PORT` | SMTP port (typicky `465` nebo `587`) |
| `SMTP_USER` | SMTP uživatel |
| `SMTP_PASS` | SMTP heslo |
| `SMTP_FROM` | Odesílací adresa (např. `noreplay@depozitka.eu`) |
| `SMTP_SECURE` | `true` pro SSL/TLS (typicky port 465) |
| `FIO_API_TOKEN` | FIO API token |
| `FIO_API_BASE` | FIO API base URL |
| `ADMIN_PAYOUT_IBAN` | Admin IBAN pro provize |
| `CRON_SECRET` | Vercel cron secret |

## Setup

1. `npm install`
2. Zkopíruj `.env.example` → `.env.local`, doplň hodnoty
3. Spusť SQL migraci `supabase/migrations/001_*.sql` na Supabase
4. Deploy na Vercel + nastav env vars

## SQL migrace

```bash
# Na Supabase SQL Editoru spustit:
supabase/migrations/001_email_queue_and_bank_transactions.sql
```

## SMTP setup (Forpsi)

1. V mail hostingu vytvoř mailbox/alias pro odesílání (např. `noreplay@depozitka.eu`)
2. Nastav SMTP údaje do env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`)
3. `SMTP_SECURE=true` pro port 465

## Poznámka

- `process-emails` používá SMTP transport (nodemailer), ne Resend.
- Fronta zůstává stejná: tabulka `dpt_email_queue`.
