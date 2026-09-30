import { Navbar } from "@/components/layout/Navbar";
import { SettingsView } from "@/components/settings/SettingsView";
import { getSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATIC_SUPABASE_SCHEMA = `-- 1. Settings Table
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
  groq_model TEXT DEFAULT 'llama-3.3-70b-versatile',
  ollama_api_key TEXT,
  ollama_base_url TEXT DEFAULT 'https://ollama.com',
  ollama_model TEXT DEFAULT 'llama3.3',
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  telegram_enabled BOOLEAN NOT NULL DEFAULT true
);
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

-- 3. Dose Schedules Table
CREATE TABLE IF NOT EXISTS dose_schedules (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  time_of_day TEXT NOT NULL,
  quantity NUMERIC(6, 2) NOT NULL DEFAULT 1,
  interval_days INTEGER NOT NULL DEFAULT 1,
  instructions TEXT
);

-- 4. Channel Configurations Table
CREATE TABLE IF NOT EXISTS channel_configs (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  lead_time_min_days INTEGER NOT NULL,
  lead_time_max_days INTEGER NOT NULL,
  available BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(medicine_id, channel)
);

-- 5. Restock Events Table
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

-- 6. Stock Adjustments Table
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  delta NUMERIC(6, 2) NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 7. Row-Level Security (RLS)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE restock_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;`;

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="min-h-screen flex flex-col bg-[#090c14] text-white">
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <SettingsView initialSettings={settings} sqlSchema={STATIC_SUPABASE_SCHEMA} />
      </main>
    </div>
  );
}
