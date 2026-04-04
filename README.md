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
| `/api/cron/process-emails` | Odesílání emailů z fronty přes Resend | ↑ voláno z daily-jobs |
| `/api/cron/fio-payout` | Výplaty prodávajícím přes FIO import | ↑ voláno z daily-jobs |

## Env vars

| Proměnná | Popis |
|----------|-------|
| `SUPABASE_URL` | Depozitka Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `RESEND_API_KEY` | Resend API klíč |
| `EMAIL_FROM` | Odesílací adresa (default: `noreply@depozitka.eu`) |
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

## Resend setup

1. Registrace na [resend.com](https://resend.com)
2. Přidat doménu `depozitka.eu` → 3 DNS záznamy (MX, SPF, DKIM)
3. Vygenerovat API key → `RESEND_API_KEY`
