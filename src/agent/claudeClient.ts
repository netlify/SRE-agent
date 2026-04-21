/**
 * Claude API client.
 *
 * Wraps the Anthropic SDK with:
 * - Streaming responses (text appears progressively in Slack)
 * - System prompt loading from the knowledge repo
 * - Context injection into the final user message
 * - SRE tag detection and confidence extraction from responses
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/config.js";
import type { Message } from "../types/index.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Cached system prompt — loaded once at startup
let _systemPrompt: string | null = null;

/**
 * Load the system prompt from the knowledge repo.
 * Falls back to the inline fallback if the file isn't available yet.
 */
export function loadSystemPrompt(knowledgePath?: string): string {
  const basePath = knowledgePath ?? config.knowledgeLocalPath;
  const promptPath = join(basePath, "system-prompt.md");

  if (existsSync(promptPath)) {
    _systemPrompt = readFileSync(promptPath, "utf-8");
    console.info(`System prompt loaded from ${promptPath}`);
  } else {
    _systemPrompt = FALLBACK_SYSTEM_PROMPT;
    console.warn(
      `Knowledge repo not found at ${promptPath} — using fallback system prompt`
    );
  }

  return _systemPrompt;
}

export function getSystemPrompt(): string {
  if (!_systemPrompt) loadSystemPrompt();
  return _systemPrompt!;
}

// ---------------------------------------------------------------------------
// Streaming response
// ---------------------------------------------------------------------------

/**
 * Stream a response from Claude, yielding text chunks as they arrive.
 *
 * @param messages - Full conversation history
 * @param injectedContext - Extra context prepended to the last user message
 *                          (blueprint file, README, etc.)
 */
export async function* streamResponse(
  messages: Message[],
  injectedContext?: string
): AsyncGenerator<string> {
  const prepared = prepareMessages(messages, injectedContext);

  console.debug(
    "[streamResponse] messages count:", prepared.length,
    "| shapes:", JSON.stringify(prepared.map(m => ({ role: m.role, contentType: typeof m.content, contentLength: typeof m.content === "string" ? m.content.length : null })))
  );

  try {
    const stream = client.messages.stream({
      model: config.claudeModel,
      max_tokens: config.maxTokens,
      system: getSystemPrompt(),
      messages: prepared,
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        yield chunk.delta.text;
      }
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      yield "\n\n⚠️ Rate limit reached — please try again in a moment.";
    } else {
      console.error("Anthropic API error:", err);
      yield "\n\n⚠️ I ran into an API error. Please try again.";
    }
  }
}

/**
 * Non-streaming completion. Useful for short internal calls
 * (e.g. service name extraction, confidence scoring).
 */
export async function complete(
  messages: Message[],
  injectedContext?: string
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamResponse(messages, injectedContext)) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

/**
 * Non-streaming completion with an explicit system prompt.
 * Used by workflow state machines that need a specific system prompt
 * (e.g. JSON extraction calls, artifact generation).
 */
export async function completeWithSystemPrompt(
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages,
    });
    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Rate limit reached — please try again in a moment.");
    }
    console.error("Anthropic API error:", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Response analysis helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the response contains an @sre-team mention.
 * The agent is instructed to include this when confidence is low.
 */
export function detectSreTag(responseText: string): boolean {
  return (
    responseText.includes("@sre-team") ||
    (Boolean(config.sreTeamSlackId) &&
      responseText.includes(config.sreTeamSlackId))
  );
}

/**
 * Extract a self-assessed confidence level from the response text.
 * Returns a value between 0 and 1, or undefined if not expressed.
 */
export function extractConfidence(responseText: string): number | undefined {
  // Matches "Confidence: 75%" or "about 60% confident"
  const match =
    responseText.match(/confidence[:\s]+(\d{1,3})\s*%/i) ??
    responseText.match(/(\d{1,3})\s*%\s+confident/i);
  if (!match) return undefined;
  const pct = parseInt(match[1], 10);
  return Math.min(Math.max(pct / 100, 0), 1);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Prepend injected context to the last user message.
 * Context appears before the developer's question so Claude reads it first.
 */
function prepareMessages(
  messages: Message[],
  injectedContext?: string
): Message[] {
  if (!injectedContext || messages.length === 0) return messages;

  const prepared = [...messages];
  const last = prepared[prepared.length - 1];

  if (last.role === "user") {
    prepared[prepared.length - 1] = {
      role: "user",
      content: `${injectedContext}\n\n---\n\n${last.content}`,
    };
  }

  return prepared;
}

// ---------------------------------------------------------------------------
// Fallback system prompt (used before knowledge repo is cloned)
// ---------------------------------------------------------------------------

const FALLBACK_SYSTEM_PROMPT = `
You are the SRE Production Readiness Advisor for Netlify.

Your role is to help developers build observable, reliable, and operable
services. You guide — you don't gatekeep. The goal is to unblock developers,
not add process.

When a developer asks for help:
1. Identify which service they're working on. If they haven't specified, ask.
2. Provide concrete, actionable guidance grounded in their actual architecture.
3. Produce copy-paste-ready artifacts where relevant.

When you're uncertain about a recommendation:
- State your confidence level as a percentage
- Tag @sre-team for review
- Explain what information would increase your confidence

Keep responses focused and actionable. Lead with the recommendation,
then explain the reasoning.
`.trim();
