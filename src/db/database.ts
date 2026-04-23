/**
 * PostgreSQL connection and schema.
 *
 * Uses the `postgres` package (postgres.js) — a modern, lightweight Postgres
 * client with excellent TypeScript support and tagged template literals for
 * safe parameterised queries.
 *
 * Schema:
 *   sessions   — one row per Slack thread
 *   audit_log  — one immutable row per interaction
 */

import postgres from "postgres";
import { config } from "../config/config.js";

// Module-level singleton — one pool shared across the app.
let _sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!_sql) {
    _sql = postgres(config.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}, // suppress NOTICE messages from CREATE IF NOT EXISTS
    });
  }
  return _sql;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  thread_ts       TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  service_name    TEXT,
  workflow        TEXT,
  workflow_state  JSONB NOT NULL DEFAULT '{}',
  messages        JSONB NOT NULL DEFAULT '[]',
  context_refs    JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_channel_id_idx ON sessions (channel_id);
CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (updated_at DESC);


CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  thread_ts       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  action          TEXT NOT NULL,
  service_name    TEXT,
  workflow        TEXT,
  input_text      TEXT,
  response_text   TEXT,
  confidence      FLOAT,
  sre_tagged      BOOLEAN NOT NULL DEFAULT FALSE,
  context_used    JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_thread_ts_idx   ON audit_log (thread_ts);
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx     ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx  ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_sre_tagged_idx  ON audit_log (sre_tagged)
  WHERE sre_tagged = TRUE;


CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

/**
 * Apply schema migrations. Idempotent — safe to call on every startup.
 */
export async function runMigrations(): Promise<void> {
  const sql = getDb();
  await sql.unsafe(SCHEMA_SQL);
  console.info("Database migrations applied");
}
