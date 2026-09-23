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
`;

let cached: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (cached) return cached;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  cached = db;
  return db;
}

export function resetDbCacheForTests(): void {
  cached = null;
}
