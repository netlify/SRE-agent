/**
 * Application entrypoint.
 *
 * Wires together:
 * - Database pool + migrations
 * - Claude client (system prompt loading)
 * - Slack app (Socket Mode for local dev, HTTP for production)
 * - Graceful shutdown on SIGINT / SIGTERM
 */

import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import http from "node:http";
import { runMigrations, closeDb } from "./db/database.js";
import { loadSystemPrompt } from "./agent/claudeClient.js";
import { loadKnowledge } from "./knowledge.js";
import { registerHandlers } from "./slack/handler.js";
import { config, useSocketMode } from "./config/config.js";

async function main(): Promise<void> {
  if (!config.slackBotToken) {
    console.error("Error: SLACK_BOT_TOKEN is required. Add it to your .env file.");
    process.exit(1);
  }

  console.info(`Starting SRE agent (environment: ${config.nodeEnv})`);

  // Apply DB migrations
  await runMigrations();

  // Load system prompt from knowledge repo (falls back to inline if not found)
  loadSystemPrompt();

  // Load full knowledge base for workflows
  const knowledge = loadKnowledge(config.knowledgeLocalPath);
  console.info(`Knowledge base loaded (${Object.keys(knowledge.workflows).length} workflows)`);

  // In HTTP mode, create an explicit ExpressReceiver so we can add /health
  // to the same Express app that handles Slack events, before starting.
  // In Socket Mode, Bolt opens no HTTP port, so we run a minimal server instead.
  const receiver = useSocketMode
    ? undefined
    : new ExpressReceiver({ signingSecret: config.slackSigningSecret });

  if (receiver) {
    receiver.router.get("/health", (_req, res) => {
      res.status(200).json({ status: "ok" });
    });
  } else {
    const healthPort = parseInt(process.env.PORT ?? "3000", 10);
    http
      .createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      })
      .listen(healthPort);
  }

  // Initialise Slack app
  const app = new App({
    token: config.slackBotToken,
    ...(receiver
      ? { receiver }
      : { socketMode: true, appToken: config.slackAppToken }),
    logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Register event handlers
  registerHandlers(app, knowledge);

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
