import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brd_documents (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  doc_type TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted_links TEXT NOT NULL,
  parsing_confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  strategy_summary TEXT NOT NULL,
  requirements_checklist TEXT NOT NULL,
  content_plan TEXT NOT NULL,
  opportunity_score INTEGER NOT NULL,
  pdf_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  file_path TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moment_candidates (
  id TEXT PRIMARY KEY,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  timestamp_ms INTEGER NOT NULL,
  score REAL NOT NULL,
  detection_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_assignments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  segment_key TEXT NOT NULL,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  secondary_video_asset_id TEXT REFERENCES video_assets(id),
  trim_start REAL NOT NULL,
  trim_end REAL NOT NULL,
  order_index INTEGER NOT NULL,
  layout_template TEXT NOT NULL,
  crop_gameplay_rect TEXT,
  crop_facecam_rect TEXT,
  title_text TEXT
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL,
  tts_voice TEXT NOT NULL,
  music_asset_id TEXT REFERENCES video_assets(id),
  output_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS caption_words (
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL REFERENCES render_jobs(id),
  word TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
`;

// NOTE: intentionally caches by first call only, ignoring subsequent dbPath args — fine since
// each process only ever opens one database path in practice; resetDbCacheForTests() exists for
// tests that need a fresh path.
let cached: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (cached) return cached;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  cached = db;
  return db;
}

export function resetDbCacheForTests(): void {
  cached = null;
}
