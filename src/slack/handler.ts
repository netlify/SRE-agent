/**
 * Slack event handler.
 *
 * Registers handlers on the Bolt App for:
 *   app_mention — developer @sre-agent in any channel
 *   message     — follow-up messages in threads with an active session
 *
 * Design:
 * - Acknowledge within 3s (Slack's hard timeout) by adding a 👀 reaction
 * - Process asynchronously — kick off without awaiting
 * - Stream Claude's response by periodically updating the placeholder message
 */

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  getOrCreateSession,
  appendMessage,
  logInteraction,
} from "../db/sessionManager.js";
import { streamResponse, detectSreTag, extractConfidence } from "../agent/claudeClient.js";

// Update the in-progress Slack message every N characters of streamed output.
// Lower = more responsive, higher = fewer API calls.
const STREAM_UPDATE_INTERVAL = 150;

export function registerHandlers(app: App): void {
  // -------------------------------------------------------------------------
  // app_mention — developer sends @sre-agent in a channel
  // -------------------------------------------------------------------------
  app.event("app_mention", async ({ event, client }) => {
    const channelId = event.channel;
    const threadTs = ("thread_ts" in event && event.thread_ts) || event.ts;
    const messageTs = event.ts;
    const userId = event.user ?? "unknown";

    // Acknowledge immediately so Slack doesn't time out
    await reactSafely(client, channelId, messageTs, "eyes");

    // Process asynchronously — don't await
    void processMessage({
      text: event.text ?? "",
      channelId,
      threadTs,
      messageTs,
      userId,
      client,
    });
  });

  // -------------------------------------------------------------------------
  // message — follow-up in a thread where we have an active session
  // -------------------------------------------------------------------------
  app.message(async ({ message, client }) => {
    // Ignore bot messages and top-level (non-thread) messages
    if (
      message.subtype === "bot_message" ||
      !("thread_ts" in message) ||
      !message.thread_ts
    ) {
      return;
    }

    // Only respond if there's already a session for this thread
    const { getDb } = await import("../db/database.js");
    const sql = getDb();
    const rows = await sql`
      SELECT 1 FROM sessions WHERE thread_ts = ${message.thread_ts}
    `;
    if (rows.length === 0) return;

    const channelId = message.channel;
    const threadTs = message.thread_ts;
    const messageTs = message.ts;
    const userId = ("user" in message && message.user) ? message.user : "unknown";
    const text = ("text" in message && message.text) ? message.text : "";

    await reactSafely(client, channelId, messageTs, "eyes");

    void processMessage({
      text,
      channelId,
      threadTs,
      messageTs,
      userId,
      client,
    });
  });
}

// ---------------------------------------------------------------------------
// Core message processing
// ---------------------------------------------------------------------------

interface ProcessMessageArgs {
  text: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  client: WebClient;
}

async function processMessage({
  text,
  channelId,
  threadTs,
  messageTs,
  userId,
  client,
}: ProcessMessageArgs): Promise<void> {
  const cleanText = stripBotMention(text);
  if (!cleanText.trim()) return;

  try {
    // Load or create session
    const session = await getOrCreateSession(threadTs, channelId);

    // Append user message to history
    await appendMessage(threadTs, "user", cleanText);
    const messages = [
      ...session.messages,
      { role: "user" as const, content: cleanText },
    ];

    // Post a placeholder message we'll update as Claude streams
    const placeholder = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_thinking..._",
    });
    const placeholderTs = placeholder.ts!;

    // Stream Claude's response, updating the placeholder periodically
    let accumulated = "";
    let charsSinceUpdate = 0;
    const chunks: string[] = [];

    for await (const chunk of streamResponse(messages)) {
      chunks.push(chunk);
      accumulated += chunk;
      charsSinceUpdate += chunk.length;

      if (charsSinceUpdate >= STREAM_UPDATE_INTERVAL) {
        await updateMessageSafely(client, channelId, placeholderTs, accumulated + " ▌");
        charsSinceUpdate = 0;
      }
    }

    const fullResponse = chunks.join("");

    // Final update — remove cursor indicator
    await updateMessageSafely(client, channelId, placeholderTs, fullResponse);

    // Swap reactions: remove 👀, add ✅
    await removeReactSafely(client, channelId, messageTs, "eyes");
    await reactSafely(client, channelId, messageTs, "white_check_mark");

    // Persist assistant response
    await appendMessage(threadTs, "assistant", fullResponse);

    // Detect SRE tagging and confidence
    const sreTagged = detectSreTag(fullResponse);
    const confidence = extractConfidence(fullResponse);

    // Write audit log
    await logInteraction({
      threadTs,
      channelId,
      userId,
      action: "message",
      serviceName: session.serviceName ?? undefined,
      workflow: session.workflow ?? undefined,
      inputText: cleanText,
      responseText: fullResponse,
      confidence,
      sreTagged,
      contextUsed: session.contextRefs,
    });

    if (sreTagged) {
      console.info(
        `SRE tagged in thread ${threadTs} (service: ${session.serviceName}, confidence: ${confidence})`
      );
    }
  } catch (err) {
    console.error(`Error processing message in thread ${threadTs}:`, err);
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "⚠️ Something went wrong on my end. Please try again.",
      });
      await removeReactSafely(client, channelId, messageTs, "eyes");
      await reactSafely(client, channelId, messageTs, "x");
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}

async function reactSafely(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch {
    // Reaction failures are non-fatal (e.g. already reacted)
  }
}

async function removeReactSafely(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch {
    // best effort
  }
}

async function updateMessageSafely(
  client: WebClient,
  channel: string,
  ts: string,
  text: string
): Promise<void> {
  try {
    await client.chat.update({ channel, ts, text });
  } catch {
    // Update failures during streaming are non-fatal
  }
}
