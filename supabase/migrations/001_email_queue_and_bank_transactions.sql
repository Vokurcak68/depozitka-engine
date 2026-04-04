-- ============================================================
-- Depozitka Engine: Email Queue + Bank Transactions
-- Run on Depozitka Supabase (tqcgkucripirysfqfezl)
-- ============================================================

-- Email queue for async email sending via Resend
CREATE TABLE IF NOT EXISTS dpt_email_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email      text NOT NULL,
  subject       text NOT NULL,
  html_body     text,
  text_body     text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  transaction_id uuid REFERENCES dpt_transactions(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status 
  ON dpt_email_queue(status) WHERE status = 'pending';

-- Bank transactions from FIO sync
CREATE TABLE IF NOT EXISTS dpt_bank_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_tx_id              text UNIQUE NOT NULL,
  amount                  numeric(12,2) NOT NULL,
  variable_symbol         text,
  date                    date NOT NULL,
  counter_account         text,
  message                 text,
  matched                 boolean NOT NULL DEFAULT false,
  matched_transaction_id  uuid REFERENCES dpt_transactions(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_vs 
  ON dpt_bank_transactions(variable_symbol) WHERE variable_symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_matched 
  ON dpt_bank_transactions(matched) WHERE matched = false;

-- RLS: only service_role should access these (engine runs as service_role)
ALTER TABLE dpt_email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpt_bank_transactions ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically, so no policies needed.
-- If admin UI needs read access, add policies later.

-- Add columns to dpt_transactions if they don't exist yet
DO $$ BEGIN
  -- paid_amount for cumulative payment tracking
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS paid_amount numeric(12,2) DEFAULT 0;
  -- payout tracking
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS payout_status text DEFAULT 'none'
    CHECK (payout_status IN ('none', 'pending', 'sent', 'confirmed', 'error'));
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS payout_sent_at timestamptz;
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS payout_error text;
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS seller_iban text;
  ALTER TABLE dpt_transactions ADD COLUMN IF NOT EXISTS payment_vs text;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Some columns may already exist, continuing...';
END $$;
