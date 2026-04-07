/**
 * Terminal REPL for local development and testing.
 *
 * Exercises knowledge loading, GitHub context fetching, and the workflow
 * state machine without requiring Slack credentials.
 *
 * Usage:
 *   npm run dev:cli
 *   npm run dev:cli -- --reset
 */

import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config();

import { loadKnowledge } from "./knowledge.js";
import { advanceWorkflow } from "./workflows/readmeDrafter.js";
import type { Session, KnowledgeBase, ReadmeDrafterState } from "./types/index.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  reset: boolean;
  workflow?: string;
}

export function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = { reset: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reset") result.reset = true;
    if (args[i] === "--workflow" && args[i + 1]) {
      result.workflow = args[++i];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reset command detection
// ---------------------------------------------------------------------------

const RESET_TRIGGERS = new Set(["reset", "start over", "restart", "begin again"]);

export function isResetCommand(text: string): boolean {
  return RESET_TRIGGERS.has(text.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Artifact saving
// ---------------------------------------------------------------------------

export function saveArtifact(
  serviceName: string,
  content: string,
  outputDir = "./output"
): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const slug = serviceName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const filename = `${slug}-readme.md`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, content, "utf-8");
  return filepath;
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

function freshSession(): Session {
  const now = new Date();
  return {
    threadTs: "cli-session",
    channelId: "cli",
    serviceName: null,
    workflow: null,
    workflowState: {},
    messages: [],
    contextRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Error: ANTHROPIC_API_KEY is not set. Add it to your .env file."
    );
    process.exit(1);
  }

  const knowledgePath =
    process.env.KNOWLEDGE_LOCAL_PATH ??
    join(process.cwd(), "sre-agent-knowledge");

  let knowledge: KnowledgeBase;
  try {
    knowledge = loadKnowledge(knowledgePath);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log("\nSRE Agent — local dev CLI");
  console.log("─────────────────────────────────────────");
  console.log("Paste a GitHub URL to auto-populate fields,");
  console.log("or answer the prompts one step at a time.");
  console.log('Type "reset" to start over. Ctrl+C to quit.\n');

  let session = freshSession();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  rl.on("close", () => {
    console.log("\nGoodbye.");
    process.exit(0);
  });

  // Kick off with the opening question from the workflow
  try {
    const opening = await advanceWorkflow(session, "", knowledge);
    console.log(`Agent: ${opening.response}\n`);
    if (opening.updatedState) {
      session = {
        ...session,
        workflowState: opening.updatedState,
        updatedAt: new Date(),
      };
    }
  } catch (err) {
    console.error(`Failed to start workflow: ${(err as Error).message}`);
    rl.close();
    return;
  }

  // REPL loop
  for (;;) {
    let userInput: string;
    try {
      userInput = await question("You: ");
    } catch {
      break; // EOF
    }

    if (!userInput.trim()) continue;

    if (isResetCommand(userInput)) {
      session = freshSession();
      console.log("\nAgent: Session reset.\n");
      const opening = await advanceWorkflow(session, "", knowledge);
      console.log(`Agent: ${opening.response}\n`);
      if (opening.updatedState) {
        session = {
          ...session,
          workflowState: opening.updatedState,
          updatedAt: new Date(),
        };
      }
      continue;
    }

    try {
      const result = await advanceWorkflow(session, userInput, knowledge);

      console.log(`\nAgent: ${result.response}`);

      if (result.artifact) {
        const state = (result.updatedState ?? session.workflowState) as Partial<ReadmeDrafterState>;
        const serviceName = state.inputs?.serviceName ?? "service";
        const filepath = saveArtifact(serviceName, result.artifact);
        console.log(`\n[Artifact saved → ${filepath}]\n`);
        console.log("─── README ───────────────────────────────");
        console.log(result.artifact);
        console.log("──────────────────────────────────────────\n");
      } else {
        console.log();
      }

      if (result.updatedState) {
        session = {
          ...session,
          workflowState: result.updatedState,
          updatedAt: new Date(),
        };
      }

      if (result.done) {
        console.log('Workflow complete. Type "reset" to start a new one.\n');
      }
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}\n`);
    }
  }

  rl.close();
}

// Run only when executed directly — not when imported in tests
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
