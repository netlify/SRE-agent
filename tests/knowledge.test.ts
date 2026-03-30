import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function importLoader() {
  return import("../src/knowledge.js");
}

function makeKnowledgeDir(
  overrides: { skipSystemPrompt?: boolean } = {}
): string {
  const base = mkdtempSync(join(tmpdir(), "sre-knowledge-"));
  if (!overrides.skipSystemPrompt) {
    writeFileSync(join(base, "system-prompt.md"), "You are an SRE advisor.");
  }
  mkdirSync(join(base, "workflows"));
  writeFileSync(
    join(base, "workflows", "readme-drafter.md"),
    "# README Drafter workflow"
  );
  writeFileSync(
    join(base, "workflows", "slo-workshop.md"),
    "# SLO Workshop workflow"
  );
  mkdirSync(join(base, "standards"));
  writeFileSync(join(base, "standards", "slo.md"), "# SLO standard");
  mkdirSync(join(base, "templates"));
  writeFileSync(join(base, "templates", "readme.md"), "# {{service_name}}");
  return base;
}

describe("loadKnowledge", () => {
  it("returns a KnowledgeBase with correct keys for a well-formed directory", async () => {
    const base = makeKnowledgeDir();
    try {
      const { loadKnowledge } = await importLoader();
      const kb = loadKnowledge(base);
      expect(kb.systemPrompt).toBe("You are an SRE advisor.");
      expect(kb.workflows["readme-drafter"]).toContain("README Drafter");
      expect(kb.workflows["slo-workshop"]).toContain("SLO Workshop");
      expect(kb.standards["slo"]).toContain("SLO standard");
      expect(kb.templates["readme"]).toContain("{{service_name}}");
    } finally {
      rmSync(base, { recursive: true });
    }
  });

  it("throws a clear error when system-prompt.md is missing", async () => {
    const base = makeKnowledgeDir({ skipSystemPrompt: true });
    try {
      const { loadKnowledge } = await importLoader();
      expect(() => loadKnowledge(base)).toThrow(/system-prompt\.md/);
    } finally {
      rmSync(base, { recursive: true });
    }
  });

  it("returns empty maps when subdirectories contain no files", async () => {
    const base = mkdtempSync(join(tmpdir(), "sre-knowledge-empty-"));
    writeFileSync(join(base, "system-prompt.md"), "prompt");
    mkdirSync(join(base, "workflows"));
    mkdirSync(join(base, "standards"));
    mkdirSync(join(base, "templates"));
    try {
      const { loadKnowledge } = await importLoader();
      const kb = loadKnowledge(base);
      expect(kb.workflows).toEqual({});
      expect(kb.standards).toEqual({});
      expect(kb.templates).toEqual({});
    } finally {
      rmSync(base, { recursive: true });
    }
  });

  it("keys files by stem (filename without extension)", async () => {
    const base = makeKnowledgeDir();
    try {
      const { loadKnowledge } = await importLoader();
      const kb = loadKnowledge(base);
      expect(Object.keys(kb.workflows)).toContain("readme-drafter");
      expect(Object.keys(kb.workflows)).not.toContain("readme-drafter.md");
    } finally {
      rmSync(base, { recursive: true });
    }
  });
});
