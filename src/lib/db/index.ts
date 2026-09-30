import { createClient, Client } from "@libsql/client";
import postgres from "postgres";
import { format } from "date-fns";
import {
  Medicine,
  DoseSchedule,
  ChannelConfig,
  RestockEvent,
  StockAdjustment,
  AppSettings,
  CalculatedMedicineState,
} from "../types";
import {
  computeMedicineState,
  DEFAULT_SETTINGS,
  safeParseDate,
  safeFormatDate,
} from "../calculations";
import path from "path";
import fs from "fs";

let sqliteClient: Client | null = null;
let pgClient: postgres.Sql | null = null;
let isPostgres = false;
let initialized = false;

function toIsoDateString(val: unknown): string {
  if (!val) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (s.includes("T")) return s.split("T")[0];
    if (s.includes(" ")) return s.split(" ")[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return s;
  }
  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    if (val.getUTCHours() === 0 && val.getUTCMinutes() === 0 && val.getUTCSeconds() === 0 && val.getUTCMilliseconds() === 0) {
      return val.toISOString().split("T")[0];
    }
    return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, "0")}-${String(val.getDate()).padStart(2, "0")}`;
  }
  return String(val);
}

function getClients() {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    isPostgres = true;
    if (!pgClient) {
      pgClient = postgres(dbUrl, {
        ssl: "require",
        max: 10,
        idle_timeout: 20,
        types: {
          date: {
            to: 1082,
            from: [1082],
            serialize: (x: unknown) => String(x),
            parse: (x: unknown) => String(x),
          },
        },
      });
    }
    return { isPg: true, pg: pgClient, sqlite: null };
  }

  isPostgres = false;
  if (!sqliteClient) {
    if (dbUrl && (dbUrl.startsWith("libsql://") || dbUrl.startsWith("https://") || dbUrl.startsWith("http://"))) {
      sqliteClient = createClient({
        url: dbUrl,
        authToken: process.env.DATABASE_AUTH_TOKEN,
      });
    } else {
      const dataDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const dbPath = fs.existsSync(path.join(dataDir, "medtracker.db"))
        ? path.join(dataDir, "medtracker.db")
        : path.join(dataDir, "trackmed.db");
      sqliteClient = createClient({
        url: `file:${dbPath}`,
      });
    }
  }

  return { isPg: false, pg: null, sqlite: sqliteClient };
}

async function queryRows(sqlText: string, params: (string | number | boolean | null)[] = []): Promise<Record<string, unknown>[]> {
  const { isPg, pg, sqlite } = getClients();

  if (isPg && pg) {
    let pIdx = 1;
    const pgSql = sqlText.replace(/\?/g, () => `$${pIdx++}`);
    const pgParams = params.map((p) => (typeof p === "boolean" ? Boolean(p) : p));
    const rows = await pg.unsafe(pgSql, pgParams as (string | number | boolean | null)[]);
    return rows as unknown as Record<string, unknown>[];
  }

  if (sqlite) {
    const sqliteParams = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
    const res = await sqlite.execute({
      sql: sqlText,
      args: sqliteParams as (string | number | null)[],
    });
    return res.rows as unknown as Record<string, unknown>[];
  }

  return [];
}

async function executeCommand(sqlText: string, params: (string | number | boolean | null)[] = []): Promise<void> {
  const { isPg, pg, sqlite } = getClients();

  if (isPg && pg) {
    let pIdx = 1;
    const pgSql = sqlText.replace(/\?/g, () => `$${pIdx++}`);
    const pgParams = params.map((p) => (typeof p === "boolean" ? Boolean(p) : p));
    await pg.unsafe(pgSql, pgParams as (string | number | boolean | null)[]);
    return;
  }

  if (sqlite) {
    const sqliteParams = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
    await sqlite.execute({
      sql: sqlText,
      args: sqliteParams as (string | number | null)[],
    });
  }
}

export async function initDb() {
  if (initialized) return;
  initialized = true;
  try {
    const { isPg, pg, sqlite } = getClients();
    if (isPg && pg) {
      await executeCommand(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY,
          default_apollo_lead_min INTEGER NOT NULL DEFAULT 7,
          default_apollo_lead_max INTEGER NOT NULL DEFAULT 10,
          default_mr_med_lead_min INTEGER NOT NULL DEFAULT 3,
          default_mr_med_lead_max INTEGER NOT NULL DEFAULT 5,
          default_offline_lead_min INTEGER NOT NULL DEFAULT 0,
          default_offline_lead_max INTEGER NOT NULL DEFAULT 1,
          default_safety_buffer_days INTEGER NOT NULL DEFAULT 5,
          app_passcode TEXT,
          reminder_email TEXT,
          reminder_time TEXT NOT NULL DEFAULT '08:00',
          reminders_enabled BOOLEAN NOT NULL DEFAULT true,
          ai_provider TEXT NOT NULL DEFAULT 'groq',
          groq_api_key TEXT,
          groq_model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b',
          ollama_api_key TEXT,
          ollama_base_url TEXT NOT NULL DEFAULT 'https://ollama.com/v1',
          ollama_model TEXT NOT NULL DEFAULT 'ollamacloud/gemma4:31b',
          openai_api_key TEXT,
          telegram_bot_token TEXT,
          telegram_chat_id TEXT,
          telegram_enabled BOOLEAN DEFAULT true,
          has_seeded BOOLEAN DEFAULT false
        );
      `);
      await executeCommand(`
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
      `);
      await executeCommand(`
        CREATE TABLE IF NOT EXISTS dose_schedules (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          time_of_day TEXT NOT NULL,
          quantity NUMERIC(6, 2) NOT NULL DEFAULT 1,
          interval_days INTEGER NOT NULL DEFAULT 1,
          instructions TEXT
        );
      `);
      await executeCommand(`
        CREATE TABLE IF NOT EXISTS channel_configs (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          lead_time_min_days INTEGER NOT NULL,
          lead_time_max_days INTEGER NOT NULL,
          available BOOLEAN NOT NULL DEFAULT true
        );
      `);
      await executeCommand(`
        CREATE TABLE IF NOT EXISTS restock_events (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          pack_count INTEGER,
          units_per_pack INTEGER,
          quantity_added NUMERIC(10, 2) NOT NULL,
          ordered_date DATE NOT NULL,
          expected_arrival_date DATE,
          received_date DATE,
          cost NUMERIC(10, 2),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await executeCommand(`
        CREATE TABLE IF NOT EXISTS stock_adjustments (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          delta NUMERIC(6, 2) NOT NULL,
          reason TEXT NOT NULL,
          notes TEXT,
          date DATE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await executeCommand(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
      try {
        await executeCommand(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS has_seeded BOOLEAN DEFAULT false;`);
      } catch {}
      // Enable Row Level Security (RLS) on all public tables to prevent unauthorized PostgREST API access
      try {
        await executeCommand(`ALTER TABLE settings ENABLE ROW LEVEL SECURITY;`);
        await executeCommand(`ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;`);
        await executeCommand(`ALTER TABLE dose_schedules ENABLE ROW LEVEL SECURITY;`);
        await executeCommand(`ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;`);
        await executeCommand(`ALTER TABLE restock_events ENABLE ROW LEVEL SECURITY;`);
        await executeCommand(`ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;`);
      } catch {}
    } else if (sqlite) {
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY,
          default_apollo_lead_min INTEGER NOT NULL DEFAULT 7,
          default_apollo_lead_max INTEGER NOT NULL DEFAULT 10,
          default_mr_med_lead_min INTEGER NOT NULL DEFAULT 3,
          default_mr_med_lead_max INTEGER NOT NULL DEFAULT 5,
          default_offline_lead_min INTEGER NOT NULL DEFAULT 0,
          default_offline_lead_max INTEGER NOT NULL DEFAULT 1,
          default_safety_buffer_days INTEGER NOT NULL DEFAULT 5,
          app_passcode TEXT,
          reminder_email TEXT,
          reminder_time TEXT NOT NULL DEFAULT '08:00',
          reminders_enabled INTEGER NOT NULL DEFAULT 1,
          ai_provider TEXT NOT NULL DEFAULT 'groq',
          groq_api_key TEXT,
          groq_model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b',
          ollama_api_key TEXT,
          ollama_base_url TEXT NOT NULL DEFAULT 'https://ollama.com/v1',
          ollama_model TEXT NOT NULL DEFAULT 'ollamacloud/gemma4:31b',
          openai_api_key TEXT,
          telegram_bot_token TEXT,
          telegram_chat_id TEXT,
          telegram_enabled INTEGER DEFAULT 1,
          has_seeded INTEGER DEFAULT 0
        );
      `);
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS medicines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          strength TEXT,
          form TEXT NOT NULL DEFAULT 'tablet',
          unit_label TEXT NOT NULL DEFAULT 'tablets',
          units_per_pack INTEGER NOT NULL DEFAULT 1,
          baseline_stock REAL NOT NULL DEFAULT 0,
          baseline_date TEXT NOT NULL,
          safety_buffer_days INTEGER,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS dose_schedules (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          time_of_day TEXT NOT NULL,
          quantity REAL NOT NULL DEFAULT 1,
          interval_days INTEGER NOT NULL DEFAULT 1,
          instructions TEXT
        );
      `);
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS channel_configs (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          lead_time_min_days INTEGER NOT NULL,
          lead_time_max_days INTEGER NOT NULL,
          available INTEGER NOT NULL DEFAULT 1
        );
      `);
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS restock_events (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          pack_count INTEGER,
          units_per_pack INTEGER,
          quantity_added REAL NOT NULL,
          ordered_date TEXT NOT NULL,
          expected_arrival_date TEXT,
          received_date TEXT,
          cost REAL,
          notes TEXT,
          created_at TEXT NOT NULL
        );
      `);
      await sqlite.execute(`
        CREATE TABLE IF NOT EXISTS stock_adjustments (
          id TEXT PRIMARY KEY,
          medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
          delta REAL NOT NULL,
          reason TEXT NOT NULL,
          notes TEXT,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      await sqlite.execute(`INSERT OR IGNORE INTO settings (id) VALUES (1);`);
      try {
        await sqlite.execute(`ALTER TABLE settings ADD COLUMN has_seeded INTEGER DEFAULT 0;`);
      } catch {}
    }
  } catch (err) {
    console.error("Failed to initialize database tables:", err);
  }
}

// ----------------------------------------------------------------------------
// Settings Operations
// ----------------------------------------------------------------------------

export async function getSettings(): Promise<AppSettings> {
  await initDb();
  const rows = await queryRows("SELECT * FROM settings WHERE id = 1;");
  if (rows.length === 0) return DEFAULT_SETTINGS;
  const row = rows[0];
  return {
    id: Number(row.id || 1),
    default_apollo_lead_min: Number(row.default_apollo_lead_min ?? 7),
    default_apollo_lead_max: Number(row.default_apollo_lead_max ?? 10),
    default_mr_med_lead_min: Number(row.default_mr_med_lead_min ?? 3),
    default_mr_med_lead_max: Number(row.default_mr_med_lead_max ?? 5),
    default_offline_lead_min: Number(row.default_offline_lead_min ?? 0),
    default_offline_lead_max: Number(row.default_offline_lead_max ?? 1),
    default_safety_buffer_days: Number(row.default_safety_buffer_days ?? 2),
    app_passcode: row.app_passcode ? String(row.app_passcode) : null,
    reminder_email: row.reminder_email ? String(row.reminder_email) : null,
    reminder_time: String(row.reminder_time || "08:00"),
    reminders_enabled: Boolean(row.reminders_enabled),
    ai_provider: (row.ai_provider as AppSettings["ai_provider"]) || "groq",
    groq_api_key: row.groq_api_key ? String(row.groq_api_key) : null,
    groq_model: row.groq_model ? String(row.groq_model) : "openai/gpt-oss-120b",
    ollama_api_key: row.ollama_api_key ? String(row.ollama_api_key) : null,
    ollama_base_url: row.ollama_base_url ? String(row.ollama_base_url) : "https://ollama.com",
    ollama_model: row.ollama_model ? String(row.ollama_model) : "ollamacloud/gemma4:31b",
    telegram_bot_token: row.telegram_bot_token ? String(row.telegram_bot_token) : null,
    telegram_chat_id: row.telegram_chat_id ? String(row.telegram_chat_id) : null,
    telegram_enabled: row.telegram_enabled !== undefined && row.telegram_enabled !== null ? Boolean(row.telegram_enabled) : true,
    has_seeded: Boolean(row.has_seeded),
  };
}

export async function updateSettings(data: Partial<AppSettings>): Promise<AppSettings> {
  await initDb();
  const current = await getSettings();
  const merged: AppSettings = { ...current, ...data };

  await executeCommand(
    `
      UPDATE settings SET
        default_apollo_lead_min = ?,
        default_apollo_lead_max = ?,
        default_mr_med_lead_min = ?,
        default_mr_med_lead_max = ?,
        default_offline_lead_min = ?,
        default_offline_lead_max = ?,
        default_safety_buffer_days = ?,
        app_passcode = ?,
        reminder_email = ?,
        reminder_time = ?,
        reminders_enabled = ?,
        ai_provider = ?,
        groq_api_key = ?,
        groq_model = ?,
        ollama_api_key = ?,
        ollama_base_url = ?,
        ollama_model = ?,
        telegram_bot_token = ?,
        telegram_chat_id = ?,
        telegram_enabled = ?,
        has_seeded = ?
      WHERE id = 1;
    `,
    [
      merged.default_apollo_lead_min,
      merged.default_apollo_lead_max,
      merged.default_mr_med_lead_min,
      merged.default_mr_med_lead_max,
      merged.default_offline_lead_min,
      merged.default_offline_lead_max,
      merged.default_safety_buffer_days,
      merged.app_passcode || null,
      merged.reminder_email || null,
      merged.reminder_time,
      merged.reminders_enabled,
      merged.ai_provider || "groq",
      merged.groq_api_key || null,
      merged.groq_model || "openai/gpt-oss-120b",
      merged.ollama_api_key || null,
      merged.ollama_base_url || "https://ollama.com",
      merged.ollama_model || "ollamacloud/gemma4:31b",
      merged.telegram_bot_token || null,
      merged.telegram_chat_id || null,
      merged.telegram_enabled ?? true,
      merged.has_seeded ?? false,
    ]
  );

  return merged;
}

// ----------------------------------------------------------------------------
// Medicine Operations
// ----------------------------------------------------------------------------

export async function getMedicines(): Promise<Medicine[]> {
  const rows = await queryRows("SELECT * FROM medicines ORDER BY name ASC;");
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    strength: row.strength ? String(row.strength) : null,
    form: (row.form as Medicine["form"]) || "tablet",
    unit_label: String(row.unit_label || "tablets"),
    units_per_pack: Number(row.units_per_pack || 1),
    baseline_stock: Number(row.baseline_stock || 0),
    baseline_date: toIsoDateString(row.baseline_date),
    safety_buffer_days:
      row.safety_buffer_days !== null && row.safety_buffer_days !== undefined
        ? Number(row.safety_buffer_days)
        : null,
    notes: row.notes ? String(row.notes) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export async function getMedicineById(id: string): Promise<{
  medicine: Medicine;
  schedules: DoseSchedule[];
  channel_configs: ChannelConfig[];
  restocks: RestockEvent[];
  adjustments: StockAdjustment[];
} | null> {
  const [medRows, schedRows, chanRows, restockRows, adjRows] = await Promise.all([
    queryRows("SELECT * FROM medicines WHERE id = ?;", [id]),
    queryRows("SELECT * FROM dose_schedules WHERE medicine_id = ? ORDER BY time_of_day ASC;", [id]),
    queryRows("SELECT * FROM channel_configs WHERE medicine_id = ?;", [id]),
    queryRows("SELECT * FROM restock_events WHERE medicine_id = ? ORDER BY ordered_date DESC;", [id]),
    queryRows("SELECT * FROM stock_adjustments WHERE medicine_id = ? ORDER BY date DESC, created_at DESC;", [id]),
  ]);

  if (medRows.length === 0) return null;
  const row = medRows[0];
  const medicine: Medicine = {
    id: String(row.id),
    name: String(row.name),
    strength: row.strength ? String(row.strength) : null,
    form: (row.form as Medicine["form"]) || "tablet",
    unit_label: String(row.unit_label || "tablets"),
    units_per_pack: Number(row.units_per_pack || 1),
    baseline_stock: Number(row.baseline_stock || 0),
    baseline_date: toIsoDateString(row.baseline_date),
    safety_buffer_days:
      row.safety_buffer_days !== null && row.safety_buffer_days !== undefined
        ? Number(row.safety_buffer_days)
        : null,
    notes: row.notes ? String(row.notes) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };

  const schedules: DoseSchedule[] = schedRows.map((s) => ({
    id: String(s.id),
    medicine_id: String(s.medicine_id),
    time_of_day: String(s.time_of_day),
    quantity: Number(s.quantity),
    interval_days: Number(s.interval_days || 1),
    instructions: s.instructions ? String(s.instructions) : null,
  }));

  const channel_configs: ChannelConfig[] = chanRows.map((c) => {
    const isAvail =
      c.available === true ||
      c.available === 1 ||
      c.available === "t" ||
      c.available === "true" ||
      c.available === "1";
    return {
      id: String(c.id),
      medicine_id: String(c.medicine_id),
      channel: c.channel as ChannelConfig["channel"],
      lead_time_min_days: Number(c.lead_time_min_days),
      lead_time_max_days: Number(c.lead_time_max_days),
      available: isAvail,
    };
  });

  const restocks: RestockEvent[] = restockRows.map((r) => ({
    id: String(r.id),
    medicine_id: String(r.medicine_id),
    channel: r.channel as RestockEvent["channel"],
    pack_count: r.pack_count !== null ? Number(r.pack_count) : null,
    units_per_pack: r.units_per_pack !== null ? Number(r.units_per_pack) : null,
    quantity_added: Number(r.quantity_added),
    ordered_date: toIsoDateString(r.ordered_date),
    expected_arrival_date: r.expected_arrival_date ? toIsoDateString(r.expected_arrival_date) : null,
    received_date: r.received_date ? toIsoDateString(r.received_date) : null,
    cost: r.cost !== null ? Number(r.cost) : null,
    notes: r.notes ? String(r.notes) : null,
    created_at: String(r.created_at),
  }));

  const adjustments: StockAdjustment[] = adjRows.map((a) => ({
    id: String(a.id),
    medicine_id: String(a.medicine_id),
    delta: Number(a.delta),
    reason: a.reason as StockAdjustment["reason"],
    notes: a.notes ? String(a.notes) : null,
    date: toIsoDateString(a.date),
    created_at: String(a.created_at),
  }));

  return { medicine, schedules, channel_configs, restocks, adjustments };
}

export async function createMedicine(params: {
  name: string;
  strength?: string | null;
  form?: Medicine["form"];
  unit_label?: string;
  units_per_pack?: number;
  baseline_stock: number;
  baseline_date?: string;
  safety_buffer_days?: number | null;
  notes?: string | null;
  schedules?: Array<{
    time_of_day: string;
    quantity: number;
    interval_days?: number;
    instructions?: string | null;
  }>;
  channel_configs?: Array<{
    channel: ChannelConfig["channel"];
    lead_time_min_days: number;
    lead_time_max_days: number;
    available: boolean;
  }>;
}): Promise<string> {
  const id = `med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const baselineDate = params.baseline_date || todayStr;

  await executeCommand(
    `
      INSERT INTO medicines (
        id, name, strength, form, unit_label, units_per_pack,
        baseline_stock, baseline_date, safety_buffer_days, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    [
      id,
      params.name.trim(),
      params.strength?.trim() || null,
      params.form || "tablet",
      params.unit_label?.trim() || "tablets",
      Number(params.units_per_pack) || 1,
      Number(params.baseline_stock) || 0,
      baselineDate,
      params.safety_buffer_days !== undefined ? (params.safety_buffer_days ?? null) : null,
      params.notes?.trim() || null,
      now,
      now,
    ]
  );

  // Insert dose schedules
  if (params.schedules && params.schedules.length > 0) {
    for (const s of params.schedules) {
      const schedId = `sch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      await executeCommand(
        `
          INSERT INTO dose_schedules (
            id, medicine_id, time_of_day, quantity, interval_days, instructions
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        [
          schedId,
          id,
          s.time_of_day,
          Number(s.quantity) || 1,
          Number(s.interval_days) || 1,
          s.instructions || null,
        ]
      );
    }
  }

  // Insert channel configs
  const channels = params.channel_configs || [
    { channel: "apollo", lead_time_min_days: 7, lead_time_max_days: 10, available: true },
    { channel: "mr_med", lead_time_min_days: 3, lead_time_max_days: 5, available: true },
    { channel: "offline", lead_time_min_days: 0, lead_time_max_days: 1, available: true },
  ];

  for (const c of channels) {
    const chanId = `chn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await executeCommand(
      `
        INSERT INTO channel_configs (
          id, medicine_id, channel, lead_time_min_days, lead_time_max_days, available
        ) VALUES (?, ?, ?, ?, ?, ?);
      `,
      [
        chanId,
        id,
        c.channel,
        Number(c.lead_time_min_days),
        Number(c.lead_time_max_days),
        c.available ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
      ]
    );
  }

  return id;
}

export async function updateMedicine(
  id: string,
  params: {
    name?: string;
    strength?: string | null;
    form?: Medicine["form"];
    unit_label?: string;
    units_per_pack?: number;
    baseline_stock?: number;
    baseline_date?: string;
    safety_buffer_days?: number | null;
    notes?: string | null;
    schedules?: Array<{
      time_of_day: string;
      quantity: number;
      interval_days?: number;
      instructions?: string | null;
    }>;
    channel_configs?: Array<{
      channel: ChannelConfig["channel"];
      lead_time_min_days: number;
      lead_time_max_days: number;
      available: boolean;
    }>;
  }
) {
  const now = new Date().toISOString();

  const current = await getMedicineById(id);
  if (!current) throw new Error(`Medicine ${id} not found`);

  await executeCommand(
    `
      UPDATE medicines SET
        name = COALESCE(?, name),
        strength = ?,
        form = COALESCE(?, form),
        unit_label = COALESCE(?, unit_label),
        units_per_pack = COALESCE(?, units_per_pack),
        baseline_stock = COALESCE(?, baseline_stock),
        baseline_date = COALESCE(?, baseline_date),
        safety_buffer_days = ?,
        notes = ?,
        updated_at = ?
      WHERE id = ?;
    `,
    [
      params.name !== undefined ? params.name.trim() : null,
      params.strength !== undefined ? (params.strength?.trim() || null) : (current.medicine.strength ?? null),
      params.form || null,
      params.unit_label !== undefined ? params.unit_label.trim() : null,
      params.units_per_pack !== undefined ? Number(params.units_per_pack) : null,
      params.baseline_stock !== undefined ? Number(params.baseline_stock) : null,
      params.baseline_date || null,
      params.safety_buffer_days !== undefined ? (params.safety_buffer_days ?? null) : (current.medicine.safety_buffer_days ?? null),
      params.notes !== undefined ? (params.notes?.trim() || null) : (current.medicine.notes ?? null),
      now,
      id,
    ]
  );

  if (params.schedules !== undefined) {
    await executeCommand("DELETE FROM dose_schedules WHERE medicine_id = ?;", [id]);
    for (const s of params.schedules) {
      const schedId = `sch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      await executeCommand(
        `
          INSERT INTO dose_schedules (
            id, medicine_id, time_of_day, quantity, interval_days, instructions
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        [
          schedId,
          id,
          s.time_of_day,
          Number(s.quantity) || 1,
          Number(s.interval_days) || 1,
          s.instructions || null,
        ]
      );
    }
  }

  if (params.channel_configs !== undefined) {
    await executeCommand("DELETE FROM channel_configs WHERE medicine_id = ?;", [id]);
    for (const c of params.channel_configs) {
      const chanId = `chn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      await executeCommand(
        `
          INSERT INTO channel_configs (
            id, medicine_id, channel, lead_time_min_days, lead_time_max_days, available
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        [
          chanId,
          id,
          c.channel,
          Number(c.lead_time_min_days),
          Number(c.lead_time_max_days),
          c.available ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        ]
      );
    }
  }
}

export async function deleteMedicine(id: string) {
  const { isPg, pg } = getClients();
  if (isPg && pg) {
    // Single atomic cascading delete in PostgreSQL
    await pg.unsafe("DELETE FROM medicines WHERE id = $1;", [id]);
  } else {
    await executeCommand("DELETE FROM dose_schedules WHERE medicine_id = ?;", [id]);
    await executeCommand("DELETE FROM channel_configs WHERE medicine_id = ?;", [id]);
    await executeCommand("DELETE FROM restock_events WHERE medicine_id = ?;", [id]);
    await executeCommand("DELETE FROM stock_adjustments WHERE medicine_id = ?;", [id]);
    await executeCommand("DELETE FROM medicines WHERE id = ?;", [id]);
  }
}

// ----------------------------------------------------------------------------
// Restock Operations
// ----------------------------------------------------------------------------

export async function logRestock(params: {
  medicine_id: string;
  channel: RestockEvent["channel"];
  pack_count?: number | null;
  units_per_pack?: number | null;
  quantity_added: number;
  ordered_date: string;
  expected_arrival_date?: string | null;
  received_date?: string | null;
  cost?: number | null;
  notes?: string | null;
}): Promise<string> {
  const id = `rst_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();

  await executeCommand(
    `
      INSERT INTO restock_events (
        id, medicine_id, channel, pack_count, units_per_pack,
        quantity_added, ordered_date, expected_arrival_date,
        received_date, cost, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    [
      id,
      params.medicine_id,
      params.channel,
      params.pack_count !== undefined ? (params.pack_count ?? null) : null,
      params.units_per_pack !== undefined ? (params.units_per_pack ?? null) : null,
      Number(params.quantity_added),
      params.ordered_date,
      params.expected_arrival_date || null,
      params.received_date || null,
      params.cost !== undefined ? (params.cost ?? null) : null,
      params.notes?.trim() || null,
      now,
    ]
  );

  return id;
}

export async function markRestockReceived(id: string, receivedDate?: string) {
  const dateStr = receivedDate || format(new Date(), "yyyy-MM-dd");
  await executeCommand("UPDATE restock_events SET received_date = ? WHERE id = ?;", [dateStr, id]);
}

export async function deleteRestock(id: string) {
  await executeCommand("DELETE FROM restock_events WHERE id = ?;", [id]);
}

// ----------------------------------------------------------------------------
// Stock Adjustments
// ----------------------------------------------------------------------------

export async function logStockAdjustment(params: {
  medicine_id: string;
  delta: number;
  reason: StockAdjustment["reason"];
  notes?: string | null;
  date?: string;
  reset_baseline?: boolean;
  new_baseline_stock?: number;
}): Promise<string> {
  const id = `adj_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();
  const dateStr = params.date || format(new Date(), "yyyy-MM-dd");

  await executeCommand(
    `
      INSERT INTO stock_adjustments (
        id, medicine_id, delta, reason, notes, date, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    [
      id,
      params.medicine_id,
      Number(params.delta),
      params.reason,
      params.notes?.trim() || null,
      dateStr,
      now,
    ]
  );

  if (params.reset_baseline && typeof params.new_baseline_stock === "number") {
    await executeCommand(
      "UPDATE medicines SET baseline_stock = ?, baseline_date = ?, updated_at = ? WHERE id = ?;",
      [params.new_baseline_stock, dateStr, now, params.medicine_id]
    );
  }

  return id;
}

// ----------------------------------------------------------------------------
// Ultra High-Speed Single-Round-Trip State Resolver
// ----------------------------------------------------------------------------

export async function getAllCalculatedStates(referenceDate: Date = new Date()): Promise<{
  settings: AppSettings;
  states: CalculatedMedicineState[];
}> {
  const [settings, medRows, schedRows, chanRows, restockRows, adjRows] = await Promise.all([
    getSettings(),
    queryRows("SELECT * FROM medicines ORDER BY name ASC;"),
    queryRows("SELECT * FROM dose_schedules ORDER BY time_of_day ASC;"),
    queryRows("SELECT * FROM channel_configs;"),
    queryRows("SELECT * FROM restock_events ORDER BY ordered_date DESC;"),
    queryRows("SELECT * FROM stock_adjustments ORDER BY date DESC, created_at DESC;"),
  ]);

  // Group by medicine_id in memory (0ms)
  const schedMap = new Map<string, DoseSchedule[]>();
  for (const s of schedRows) {
    const medId = String(s.medicine_id);
    if (!schedMap.has(medId)) schedMap.set(medId, []);
    schedMap.get(medId)!.push({
      id: String(s.id),
      medicine_id: medId,
      time_of_day: String(s.time_of_day),
      quantity: Number(s.quantity),
      interval_days: Number(s.interval_days || 1),
      instructions: s.instructions ? String(s.instructions) : null,
    });
  }

  const chanMap = new Map<string, ChannelConfig[]>();
  for (const c of chanRows) {
    const medId = String(c.medicine_id);
    if (!chanMap.has(medId)) chanMap.set(medId, []);
    const isAvail =
      c.available === true ||
      c.available === 1 ||
      c.available === "t" ||
      c.available === "true" ||
      c.available === "1";
    chanMap.get(medId)!.push({
      id: String(c.id),
      medicine_id: medId,
      channel: c.channel as ChannelConfig["channel"],
      lead_time_min_days: Number(c.lead_time_min_days),
      lead_time_max_days: Number(c.lead_time_max_days),
      available: isAvail,
    });
  }

  const restockMap = new Map<string, RestockEvent[]>();
  for (const r of restockRows) {
    const medId = String(r.medicine_id);
    if (!restockMap.has(medId)) restockMap.set(medId, []);
    restockMap.get(medId)!.push({
      id: String(r.id),
      medicine_id: medId,
      channel: r.channel as RestockEvent["channel"],
      pack_count: r.pack_count !== null ? Number(r.pack_count) : null,
      units_per_pack: r.units_per_pack !== null ? Number(r.units_per_pack) : null,
      quantity_added: Number(r.quantity_added),
      ordered_date: toIsoDateString(r.ordered_date),
      expected_arrival_date: r.expected_arrival_date ? toIsoDateString(r.expected_arrival_date) : null,
      received_date: r.received_date ? toIsoDateString(r.received_date) : null,
      cost: r.cost !== null ? Number(r.cost) : null,
      notes: r.notes ? String(r.notes) : null,
      created_at: String(r.created_at),
    });
  }

  const adjMap = new Map<string, StockAdjustment[]>();
  for (const a of adjRows) {
    const medId = String(a.medicine_id);
    if (!adjMap.has(medId)) adjMap.set(medId, []);
    adjMap.get(medId)!.push({
      id: String(a.id),
      medicine_id: medId,
      delta: Number(a.delta),
      reason: a.reason as StockAdjustment["reason"],
      notes: a.notes ? String(a.notes) : null,
      date: toIsoDateString(a.date),
      created_at: String(a.created_at),
    });
  }

  const states: CalculatedMedicineState[] = medRows.map((row) => {
    const medicine: Medicine = {
      id: String(row.id),
      name: String(row.name),
      strength: row.strength ? String(row.strength) : null,
      form: (row.form as Medicine["form"]) || "tablet",
      unit_label: String(row.unit_label || "tablets"),
      units_per_pack: Number(row.units_per_pack || 1),
      baseline_stock: Number(row.baseline_stock || 0),
      baseline_date: toIsoDateString(row.baseline_date),
      safety_buffer_days:
        row.safety_buffer_days !== null && row.safety_buffer_days !== undefined
          ? Number(row.safety_buffer_days)
          : null,
      notes: row.notes ? String(row.notes) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };

    const schedules = schedMap.get(medicine.id) || [];
    const channelConfigs = chanMap.get(medicine.id) || [];
    const restocks = restockMap.get(medicine.id) || [];
    const adjustments = adjMap.get(medicine.id) || [];

    return computeMedicineState(
      medicine,
      schedules,
      channelConfigs,
      restocks,
      adjustments,
      settings,
      referenceDate
    );
  });

  return { settings, states };
}

// ----------------------------------------------------------------------------
// High-Speed Batch Seeding for All 15 Prescription Medicines
// ----------------------------------------------------------------------------

export async function seedSampleData() {
  await initDb();
  const { isPg, pg, sqlite } = getClients();
  // 1. Wipe all existing rows in single batch
  if (isPg && pg) {
    await pg.unsafe(`
      DELETE FROM dose_schedules;
      DELETE FROM channel_configs;
      DELETE FROM restock_events;
      DELETE FROM stock_adjustments;
      DELETE FROM medicines;
    `);
  } else if (sqlite) {
    await sqlite.execute("DELETE FROM dose_schedules;");
    await sqlite.execute("DELETE FROM channel_configs;");
    await sqlite.execute("DELETE FROM restock_events;");
    await sqlite.execute("DELETE FROM stock_adjustments;");
    await sqlite.execute("DELETE FROM medicines;");
  }

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const now = new Date().toISOString();

  const medsList = [
    {
      id: "med_cardio_01",
      name: "Cardio-Guard 40",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 79,
      notes: "6 tablets daily (2 Morning, 2 Afternoon, 2 Night with meals).",
      schedules: [
        { time_of_day: "morning", quantity: 2, interval_days: 1, instructions: "With breakfast" },
        { time_of_day: "afternoon", quantity: 2, interval_days: 1, instructions: "With lunch" },
        { time_of_day: "night", quantity: 2, interval_days: 1, instructions: "With dinner" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_lipid_02",
      name: "Lipid-Norm 10",
      strength: null,
      form: "capsule",
      unit_label: "capsules",
      units_per_pack: 10,
      baseline_stock: 30,
      notes: "1 capsule at night after dinner.",
      schedules: [
        { time_of_day: "night", quantity: 1, interval_days: 1, instructions: "After dinner" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_glyco_03",
      name: "Glyco-Balance 500",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 10,
      baseline_stock: 53,
      notes: "3 tablets daily (1 Morning, 1 Afternoon, 1 Night with meals).",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "With breakfast" },
        { time_of_day: "afternoon", quantity: 1, interval_days: 1, instructions: "With lunch" },
        { time_of_day: "night", quantity: 1, interval_days: 1, instructions: "With dinner" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_mineral_04",
      name: "Mineral-Complex 100",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 18,
      notes: "2 tablets daily. 2 strips ordered from Online Pharmacy.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning" },
        { time_of_day: "night", quantity: 1, interval_days: 1, instructions: "Night" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
      inTransit: {
        channel: "mr_med",
        pack_count: 2,
        units_per_pack: 15,
        qty: 30,
        eta: "2026-09-24",
        notes: "2 strips en route from Online Pharmacy (Expected 23–25 Sep)",
      },
    },
    {
      id: "med_vaso_05",
      name: "Vaso-Relax 30",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 28,
      notes: "1 tablet daily.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_acid_06",
      name: "Acid-Shield 20",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 61,
      notes: "2 tablets daily (1 Morning empty stomach, 1 Evening before food).",
      schedules: [
        { time_of_day: "before_breakfast", quantity: 1, interval_days: 1, instructions: "Empty stomach" },
        { time_of_day: "evening", quantity: 1, interval_days: 1, instructions: "Before evening meal" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_tensio_07",
      name: "Tensio-Care 40",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 29,
      notes: "2 tablets daily. 3 strips ordered from Online Pharmacy.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning" },
        { time_of_day: "night", quantity: 1, interval_days: 1, instructions: "Night" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
      inTransit: {
        channel: "mr_med",
        pack_count: 3,
        units_per_pack: 15,
        qty: 45,
        eta: "2026-09-24",
        notes: "3 strips en route from Online Pharmacy (Expected 23–25 Sep)",
      },
    },
    {
      id: "med_digest_08",
      name: "Digest-Pro Soluble",
      strength: null,
      form: "sachet",
      unit_label: "sachets",
      units_per_pack: 10,
      baseline_stock: 18,
      notes: "1 packet everyday. Takes 14 days to arrive from Online Pharmacy.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Mix with water daily" },
      ],
      channels: [
        { channel: "apollo", min: 10, max: 14, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_renal_09",
      name: "Renal-Guard 10",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 14,
      baseline_stock: 0,
      notes: "1 tablet daily. 2 strips ordered from Online Pharmacy.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: false },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
      inTransit: {
        channel: "mr_med",
        pack_count: 2,
        units_per_pack: 14,
        qty: 28,
        eta: "2026-09-24",
        notes: "2 strips en route from Online Pharmacy (Expected 23–25 Sep)",
      },
    },
    {
      id: "med_probiotic_10",
      name: "Pro-Bio Forte",
      strength: null,
      form: "capsule",
      unit_label: "capsules",
      units_per_pack: 10,
      baseline_stock: 30,
      notes: "1 capsule everyday.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning with water" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: false },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_peptide_11",
      name: "Peptide-Max 4000",
      strength: null,
      form: "injection",
      unit_label: "injections",
      units_per_pack: 1,
      baseline_stock: 2,
      notes: "1 injection to be taken every Saturday.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 7, instructions: "Every Saturday subcutaneous" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: false },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_thyro_12",
      name: "Thyro-Manage 50",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 120,
      baseline_stock: 180,
      notes: "1 tablet empty stomach in morning. 1 full bottle (120) + 1 continuing (~60) in stock.",
      schedules: [
        { time_of_day: "before_breakfast", quantity: 1, interval_days: 1, instructions: "Empty stomach before breakfast" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_thyro_13",
      name: "Thyro-Manage 25",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 120,
      baseline_stock: 60,
      notes: "1 tablet empty stomach in morning. 1 continuing bottle in stock.",
      schedules: [
        { time_of_day: "before_breakfast", quantity: 1, interval_days: 1, instructions: "Empty stomach before breakfast" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_biolog_14",
      name: "Bio-Insulin Cartridge",
      strength: null,
      form: "other",
      unit_label: "units",
      units_per_pack: 300,
      baseline_stock: 200,
      notes: "14 units insulin everyday at night.",
      schedules: [
        { time_of_day: "night", quantity: 14, interval_days: 1, instructions: "Daily night subcutaneous" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
    {
      id: "med_fluid_15",
      name: "Fluid-Balance 10",
      strength: null,
      form: "tablet",
      unit_label: "tablets",
      units_per_pack: 15,
      baseline_stock: 30,
      notes: "1 tablet daily in the morning.",
      schedules: [
        { time_of_day: "morning", quantity: 1, interval_days: 1, instructions: "Morning after food" },
      ],
      channels: [
        { channel: "apollo", min: 7, max: 10, avail: true },
        { channel: "mr_med", min: 3, max: 5, avail: true },
        { channel: "offline", min: 0, max: 1, avail: true },
      ],
    },
  ];

  for (const m of medsList) {
    await executeCommand(
      `
        INSERT INTO medicines (
          id, name, strength, form, unit_label, units_per_pack,
          baseline_stock, baseline_date, safety_buffer_days, notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        m.id,
        m.name,
        m.strength,
        m.form,
        m.unit_label,
        m.units_per_pack,
        m.baseline_stock,
        todayStr,
        2,
        m.notes,
        now,
        now,
      ]
    );

    for (const s of m.schedules) {
      const sId = `sch_${m.id}_${s.time_of_day}`;
      await executeCommand(
        `
          INSERT INTO dose_schedules (
            id, medicine_id, time_of_day, quantity, interval_days, instructions
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        [sId, m.id, s.time_of_day, s.quantity, s.interval_days, s.instructions]
      );
    }

    for (const c of m.channels) {
      const cId = `chn_${m.id}_${c.channel}`;
      await executeCommand(
        `
          INSERT INTO channel_configs (
            id, medicine_id, channel, lead_time_min_days, lead_time_max_days, available
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        [
          cId,
          m.id,
          c.channel,
          Number(c.min),
          Number(c.max),
          c.avail ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        ]
      );
    }

    if ("inTransit" in m && m.inTransit) {
      const rId = `rst_${m.id}_transit`;
      await executeCommand(
        `
          INSERT INTO restock_events (
            id, medicine_id, channel, pack_count, units_per_pack,
            quantity_added, ordered_date, expected_arrival_date,
            notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
        [
          rId,
          m.id,
          m.inTransit.channel,
          m.inTransit.pack_count,
          m.inTransit.units_per_pack,
          m.inTransit.qty,
          todayStr,
          m.inTransit.eta,
          m.inTransit.notes,
          now,
        ]
      );
    }
  }
  await executeCommand("UPDATE settings SET has_seeded = ? WHERE id = 1;", [true]);
}
