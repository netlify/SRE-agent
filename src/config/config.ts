/**
 * Runtime configuration.
 *
 * All values are loaded from environment variables and validated with Zod.
 * The app fails fast at startup if required variables are missing rather than
 * surfacing confusing errors later.
 */

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // Slack
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().default(""),       // Socket Mode (local dev)
  slackSigningSecret: z.string().default(""),  // HTTP mode (production)

  // Anthropic
  anthropicApiKey: z.string().min(1),

  // Database
  databaseUrl: z
    .string()
    .default("postgresql://sre_agent:password@localhost:5432/sre_agent"),

  // GitHub
  githubToken: z.string().default(""),
  githubOrg: z.string().default("netlify"),

  // Repos
  blueprintsRepoUrl: z.string().default(""),
  blueprintsLocalPath: z.string().default("/data/blueprints"),
  knowledgeRepoUrl: z.string().default(""),
  knowledgeLocalPath: z.string().default("/data/sre-agent-knowledge"),

  // Agent behaviour
  sreTeamSlackId: z.string().default(""),
  claudeModel: z.string().default("claude-opus-4-5"),
  maxTokens: z.coerce.number().default(4096),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
});

function loadConfig() {
  const result = configSchema.safeParse({
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    databaseUrl: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    githubOrg: process.env.GITHUB_ORG,
    blueprintsRepoUrl: process.env.BLUEPRINTS_REPO_URL,
    blueprintsLocalPath: process.env.BLUEPRINTS_LOCAL_PATH,
    knowledgeRepoUrl: process.env.KNOWLEDGE_REPO_URL,
    knowledgeLocalPath: process.env.KNOWLEDGE_LOCAL_PATH,
    sreTeamSlackId: process.env.SRE_TEAM_SLACK_ID,
    claudeModel: process.env.CLAUDE_MODEL,
    maxTokens: process.env.MAX_TOKENS,
    logLevel: process.env.LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
  });

  if (!result.success) {
    console.error("Invalid configuration:", result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;

export const isProduction = config.nodeEnv === "production";
export const useSocketMode = Boolean(config.slackAppToken) && !isProduction;
