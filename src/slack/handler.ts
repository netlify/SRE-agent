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

import type { App, AllMiddlewareArgs } from "@slack/bolt";
import {
  getOrCreateSession,
  appendMessage,
  updateWorkflow,
  logInteraction,
} from "../db/sessionManager.js";
import { streamResponse, detectSreTag, extractConfidence } from "../agent/claudeClient.js";
import { parseGithubUrl } from "../github.js";
import { advanceWorkflow } from "../workflows/readmeDrafter.js";
import type { KnowledgeBase, ReadmeDrafterState } from "../types/index.js";

// Update the in-progress Slack message every N characters of streamed output.
// Lower = more responsive, higher = fewer API calls.
const STREAM_UPDATE_INTERVAL = 150;

export function registerHandlers(app: App, knowledge: KnowledgeBase): void {
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
      knowledge,
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
  client: AllMiddlewareArgs["client"];
  knowledge: KnowledgeBase;
}

async function processMessage({
  text,
  channelId,
  threadTs,
  messageTs,
  userId,
  client,
  knowledge,
}: ProcessMessageArgs): Promise<void> {
  const cleanText = stripBotMention(text);
  if (!cleanText.trim()) return;

  try {
    // Load or create session
    const session = await getOrCreateSession(threadTs, channelId);

    // Append user message to history
    await appendMessage(threadTs, "user", cleanText);

    // Check if this message should be routed to the readme-drafter workflow:
    // - Session has an active readme_drafter workflow state, OR
    // - Message contains a GitHub URL (auto-start readme-drafter)
    const wfState = session.workflowState as { workflow?: string };
    const isReadmeWorkflow = wfState.workflow === "readme_drafter";
    const hasGithubUrl = parseGithubUrl(cleanText) !== null;

    if (isReadmeWorkflow || hasGithubUrl) {
      const placeholder = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "_thinking..._",
      });
      const placeholderTs = placeholder.ts!;

      try {
        const result = await advanceWorkflow(session, cleanText, knowledge);

        if (result.artifact) {
          // Delete the placeholder so the file upload is the only message (no "(edited)")
          await deleteSafely(client, channelId, placeholderTs);
          const wfState = (result.updatedState ?? session.workflowState) as { inputs?: Record<string, string> };
          const serviceName = wfState.inputs?.serviceName ?? "service";
          const filename = `${serviceName.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-readme.md`;
          await uploadFileSafely(client, {
            channelId,
            threadTs,
            filename,
            content: result.artifact,
            initialComment: result.response,
          });
        } else {
          await updateMessageSafely(client, channelId, placeholderTs, result.response);
        }

        // Persist workflow state
        if (result.updatedState) {
          await updateWorkflow(
            threadTs,
            "readme_drafter",
            result.updatedState as ReadmeDrafterState
          );
        }
        if (result.done) {
          await updateWorkflow(threadTs, null, {});
        }

        await removeReactSafely(client, channelId, messageTs, "eyes");
        await reactSafely(client, channelId, messageTs, "white_check_mark");
        await appendMessage(threadTs, "assistant", result.response);

        await logInteraction({
          threadTs,
          channelId,
          userId,
          action: result.done ? "workflow_complete" : "message",
          serviceName: session.serviceName ?? undefined,
          workflow: "readme_drafter",
          inputText: cleanText,
          responseText: result.response,
          sreTagged: false,
          contextUsed: session.contextRefs,
        });
      } catch (workflowErr) {
        console.error(`Workflow error in thread ${threadTs}:`, workflowErr);
        const errMsg =
          workflowErr instanceof Error
            ? workflowErr.message
            : "An unexpected error occurred.";
        await updateMessageSafely(client, channelId, placeholderTs, `⚠️ ${errMsg}`);
        await removeReactSafely(client, channelId, messageTs, "eyes");
        await reactSafely(client, channelId, messageTs, "x");
      }
      return;
    }

    // Generic path: stream Claude's response
    const messages = [
      ...session.messages,
      { role: "user" as const, content: cleanText },
    ];

    const placeholder = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_thinking..._",
    });
    const placeholderTs = placeholder.ts!;

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

    await updateMessageSafely(client, channelId, placeholderTs, fullResponse);
    await removeReactSafely(client, channelId, messageTs, "eyes");
    await reactSafely(client, channelId, messageTs, "white_check_mark");
    await appendMessage(threadTs, "assistant", fullResponse);

    const sreTagged = detectSreTag(fullResponse);
    const confidence = extractConfidence(fullResponse);

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
  client: AllMiddlewareArgs["client"],
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

async function deleteSafely(
  client: AllMiddlewareArgs["client"],
  channel: string,
  ts: string
): Promise<void> {
  try {
    await client.chat.delete({ channel, ts });
  } catch {
    // best effort
  }
}

async function removeReactSafely(
  client: AllMiddlewareArgs["client"],
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

interface UploadFileArgs {
  channelId: string;
  threadTs: string;
  filename: string;
  content: string;
  initialComment: string;
}

async function uploadFileSafely(
  client: AllMiddlewareArgs["client"],
  { channelId, threadTs, filename, content, initialComment }: UploadFileArgs
): Promise<void> {
  try {
    const { upload_url, file_id } = await client.files.getUploadURLExternal({
      filename,
      length: Buffer.byteLength(content, "utf8"),
    }) as { upload_url: string; file_id: string };

    await fetch(upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    });

    await client.files.completeUploadExternal({
      files: [{ id: file_id, title: filename }],
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: initialComment,
    });
  } catch (err) {
    console.error("File upload failed:", err);
    // Fall back to posting the content inline as a code block
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `${initialComment}\n\`\`\`\n${content}\n\`\`\``,
    });
  }
}

async function updateMessageSafely(
  client: AllMiddlewareArgs["client"],
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
