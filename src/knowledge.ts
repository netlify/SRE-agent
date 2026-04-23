import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeBase } from "./types/index.js";

function loadDir(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf-8")])
  );
}

export function loadKnowledge(basePath: string): KnowledgeBase {
  const systemPromptPath = join(basePath, "system-prompt.md");
  if (!existsSync(systemPromptPath)) {
    throw new Error(
      `Knowledge base is missing required file: system-prompt.md (looked in ${basePath})`
    );
  }
  return {
    systemPrompt: readFileSync(systemPromptPath, "utf-8"),
    workflows: loadDir(join(basePath, "workflows")),
    standards: loadDir(join(basePath, "standards")),
    templates: loadDir(join(basePath, "templates")),
  };
}
