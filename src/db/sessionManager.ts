/**
 * Session manager — CRUD for sessions and audit_log.
 *
 * Each Slack thread maps 1:1 to a session row. All methods are stateless —
 * the database is the source of truth. This means the app can scale to
 * multiple replicas or recover from a pod restart with no data loss.
 */

import { getDb } from "./database.js";
import type {
  Session,
  Message,
  WorkflowName,
  WorkflowState,
  AuditEntry,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Row type returned from Postgres (snake_case, JSONB as unknown)
// ---------------------------------------------------------------------------

interface SessionRow {
  thread_ts: string;
  channel_id: string;
  service_name: string | null;
  workflow: string | null;
  workflow_state: unknown;
  messages: unknown;
  context_refs: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToSession(row: SessionRow): Session {
  return {
    threadTs: row.thread_ts,
    channelId: row.channel_id,
    serviceName: row.service_name,
    workflow: (row.workflow as WorkflowName) ?? null,
    workflowState: (row.workflow_state as WorkflowState) ?? {},
    messages: (row.messages as Message[]) ?? [],
    contextRefs: (row.context_refs as string[]) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/**
 * Return the existing session for this thread, or create a new one.
 * This is the main entry point — called at the start of every message handler.
 */
export async function getOrCreateSession(
  threadTs: string,
  channelId: string
): Promise<Session> {
  const sql = getDb();

  const rows = await sql<SessionRow[]>`
    SELECT * FROM sessions WHERE thread_ts = ${threadTs}
  `;

  if (rows.length > 0) {
    return rowToSession(rows[0]);
  }

  const inserted = await sql<SessionRow[]>`
    INSERT INTO sessions (thread_ts, channel_id)
    VALUES (${threadTs}, ${channelId})
    RETURNING *
  `;

  console.info(`New session created for thread ${threadTs} in ${channelId}`);
  return rowToSession(inserted[0]);
}

/**
 * Append a single message to the session's message history.
 * Uses a Postgres JSON append rather than a full read-modify-write.
 */
export async function appendMessage(
  threadTs: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const sql = getDb();
  const message: Message = { role, content };

  await sql`
    UPDATE sessions
    SET messages = messages || ${JSON.stringify([message])}::jsonb
    WHERE thread_ts = ${threadTs}
  `;
}

/**
 * Update the active workflow and its progress state.
 */
export async function updateWorkflow(
  threadTs: string,
  workflow: WorkflowName | null,
  workflowState: WorkflowState = {}
): Promise<void> {
  const sql = getDb();

  await sql`
    UPDATE sessions
    SET workflow       = ${workflow},
        workflow_state = ${JSON.stringify(workflowState)}::jsonb
    WHERE thread_ts = ${threadTs}
  `;
}

/**
 * Record which service this session is about once identified.
 */
export async function setServiceName(
  threadTs: string,
  serviceName: string
): Promise<void> {
  const sql = getDb();

  await sql`
    UPDATE sessions
    SET service_name = ${serviceName}
    WHERE thread_ts = ${threadTs}
  `;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Write one row to the audit log.
 * Errors are caught and logged — audit failures never break a response.
 */
export async function logInteraction(entry: AuditEntry): Promise<void> {
  const sql = getDb();

  try {
    await sql`
      INSERT INTO audit_log (
        thread_ts, channel_id, user_id, action,
        service_name, workflow,
        input_text, response_text,
        confidence, sre_tagged, context_used
      ) VALUES (
        ${entry.threadTs},
        ${entry.channelId},
        ${entry.userId},
        ${entry.action},
        ${entry.serviceName ?? null},
        ${entry.workflow ?? null},
        ${entry.inputText ?? null},
        ${entry.responseText ?? null},
        ${entry.confidence ?? null},
        ${entry.sreTagged},
        ${JSON.stringify(entry.contextUsed)}::jsonb
      )
    `;
  } catch (err) {
    console.error(`Failed to write audit log for thread ${entry.threadTs}:`, err);
  }
}
