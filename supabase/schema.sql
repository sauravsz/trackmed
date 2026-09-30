-- ====================================================================
-- Medicine Stock Tracker — Supabase / Postgres Database Schema
-- ====================================================================

-- 1. App Settings Table
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  default_apollo_lead_min INTEGER NOT NULL DEFAULT 7,
  default_apollo_lead_max INTEGER NOT NULL DEFAULT 10,
  default_mr_med_lead_min INTEGER NOT NULL DEFAULT 3,
  default_mr_med_lead_max INTEGER NOT NULL DEFAULT 5,
  default_offline_lead_min INTEGER NOT NULL DEFAULT 0,
  default_offline_lead_max INTEGER NOT NULL DEFAULT 1,
  default_safety_buffer_days INTEGER NOT NULL DEFAULT 2,
  app_passcode TEXT,
  reminder_email TEXT,
  reminder_time TEXT NOT NULL DEFAULT '08:00',
  reminders_enabled BOOLEAN NOT NULL DEFAULT true,
  ai_provider TEXT NOT NULL DEFAULT 'groq',
  groq_api_key TEXT,
  openai_api_key TEXT,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  telegram_enabled BOOLEAN NOT NULL DEFAULT true
);

-- Migration helper for existing settings table
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_provider TEXT DEFAULT 'groq';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS groq_api_key TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS openai_api_key TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS telegram_enabled BOOLEAN DEFAULT true;

-- Insert default settings row if missing
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Medicines Table
CREATE TABLE IF NOT EXISTS medicines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strength TEXT,
  form TEXT NOT NULL DEFAULT 'tablet',
  unit_label TEXT NOT NULL DEFAULT 'tablets',
  units_per_pack INTEGER NOT NULL DEFAULT 1,
  baseline_stock NUMERIC(10, 2) NOT NULL DEFAULT 0,
  baseline_date DATE NOT NULL,
  safety_buffer_days INTEGER,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);

-- 3. Dose Schedules Table
CREATE TABLE IF NOT EXISTS dose_schedules (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  time_of_day TEXT NOT NULL,
  quantity NUMERIC(6, 2) NOT NULL DEFAULT 1,
  interval_days INTEGER NOT NULL DEFAULT 1,
  instructions TEXT
);

CREATE INDEX IF NOT EXISTS idx_dose_schedules_med_id ON dose_schedules(medicine_id);

-- 4. Channel Configurations Table
CREATE TABLE IF NOT EXISTS channel_configs (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- 'apollo' | 'mr_med' | 'offline' | 'other'
  lead_time_min_days INTEGER NOT NULL,
  lead_time_max_days INTEGER NOT NULL,
  available BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(medicine_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_med_id ON channel_configs(medicine_id);

-- 5. Restock Events Table (Purchase & In-Transit Log)
CREATE TABLE IF NOT EXISTS restock_events (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  pack_count INTEGER,
  units_per_pack INTEGER,
  quantity_added INTEGER NOT NULL,
  ordered_date DATE NOT NULL,
  expected_arrival_date DATE,
  received_date DATE,
  cost NUMERIC(10, 2),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restock_events_med_id ON restock_events(medicine_id);
CREATE INDEX IF NOT EXISTS idx_restock_events_ordered_date ON restock_events(ordered_date);

-- 6. Stock Adjustments Table (Manual Audits & Spills)
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  delta NUMERIC(6, 2) NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_med_id ON stock_adjustments(medicine_id);

-- ============================================================================
-- 7. Security: Enable Row Level Security (RLS) on all public tables
-- ============================================================================
-- Prevents unauthorized access to tables via Supabase public PostgREST API (anon key).
-- Direct PostgreSQL connections (Next.js server backend) bypass RLS safely.
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE restock_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
