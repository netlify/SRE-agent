/**
 * Application entrypoint.
 *
 * Wires together:
 * - Database pool + migrations
 * - Claude client (system prompt loading)
 * - Slack app (Socket Mode for local dev, HTTP for production)
 * - Graceful shutdown on SIGINT / SIGTERM
 */

import { App, LogLevel } from "@slack/bolt";
import { runMigrations, closeDb } from "./db/database.js";
import { loadSystemPrompt } from "./agent/claudeClient.js";
import { registerHandlers } from "./slack/handler.js";
import { config, isProduction, useSocketMode } from "./config/config.js";

async function main(): Promise<void> {
  console.info(`Starting SRE agent (environment: ${config.nodeEnv})`);

  // Apply DB migrations
  await runMigrations();

  // Load system prompt from knowledge repo (falls back to inline if not found)
  loadSystemPrompt();

  // Initialise Slack app
  const app = new App({
    token: config.slackBotToken,
    signingSecret: isProduction ? config.slackSigningSecret : undefined,
    socketMode: useSocketMode,
    appToken: useSocketMode ? config.slackAppToken : undefined,
    logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Register event handlers
  registerHandlers(app);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`${signal} received — shutting down`);
    await app.stop();
    await closeDb();
    console.info("SRE agent shut down cleanly");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (useSocketMode) {
    console.info("Starting in Socket Mode (local dev)");
    await app.start();
  } else {
    const port = parseInt(process.env.PORT ?? "3000", 10);
    console.info(`Starting HTTP server on port ${port}`);
    await app.start(port);
  }

  console.info("SRE agent is running");
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
