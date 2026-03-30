/**
 * Tests for CLI utilities.
 *
 * Covers the pure, exported functions — parseCliArgs, isResetCommand,
 * and saveArtifact. The REPL loop itself (main) is not tested here
 * because it requires interactive stdin; it is exercised manually.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function importCli() {
  return import("../src/cli.js");
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("returns defaults when no flags are passed", async () => {
    const { parseCliArgs } = await importCli();
    const args = parseCliArgs([]);
    expect(args.reset).toBe(false);
    expect(args.workflow).toBeUndefined();
  });

  it("parses --reset flag", async () => {
    const { parseCliArgs } = await importCli();
    expect(parseCliArgs(["--reset"]).reset).toBe(true);
  });

  it("parses --workflow <name>", async () => {
    const { parseCliArgs } = await importCli();
    expect(parseCliArgs(["--workflow", "readme-drafter"]).workflow).toBe(
      "readme-drafter"
    );
  });

  it("parses both --reset and --workflow together", async () => {
    const { parseCliArgs } = await importCli();
    const args = parseCliArgs(["--reset", "--workflow", "slo-workshop"]);
    expect(args.reset).toBe(true);
    expect(args.workflow).toBe("slo-workshop");
  });

  it("parses flags in any order", async () => {
    const { parseCliArgs } = await importCli();
    const args = parseCliArgs(["--workflow", "readme-drafter", "--reset"]);
    expect(args.reset).toBe(true);
    expect(args.workflow).toBe("readme-drafter");
  });

  it("ignores unrecognised flags", async () => {
    const { parseCliArgs } = await importCli();
    const args = parseCliArgs(["--unknown", "value"]);
    expect(args.reset).toBe(false);
    expect(args.workflow).toBeUndefined();
  });

  it("returns undefined workflow when --workflow has no argument", async () => {
    const { parseCliArgs } = await importCli();
    expect(parseCliArgs(["--workflow"]).workflow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isResetCommand
// ---------------------------------------------------------------------------

describe("isResetCommand", () => {
  it('returns true for "reset"', async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("reset")).toBe(true);
  });

  it("is case-insensitive", async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("RESET")).toBe(true);
    expect(isResetCommand("Reset")).toBe(true);
  });

  it('returns true for "start over"', async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("start over")).toBe(true);
  });

  it('returns true for "restart"', async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("restart")).toBe(true);
  });

  it('returns true for "begin again"', async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("begin again")).toBe(true);
  });

  it("trims surrounding whitespace before matching", async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("  reset  ")).toBe(true);
    expect(isResetCommand("  start over  ")).toBe(true);
  });

  it("returns false for normal messages", async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("hello")).toBe(false);
    expect(isResetCommand("my-service")).toBe(false);
    expect(isResetCommand("https://github.com/netlify/my-svc")).toBe(false);
  });

  it("returns false for empty string", async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("")).toBe(false);
  });

  it("returns false for partial matches", async () => {
    const { isResetCommand } = await importCli();
    expect(isResetCommand("please reset this")).toBe(false);
    expect(isResetCommand("restart the server")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveArtifact
// ---------------------------------------------------------------------------

describe("saveArtifact", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true });
    }
    tmpDirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "sre-cli-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("creates the output directory if it does not exist", async () => {
    const { saveArtifact } = await importCli();
    const dir = join(tempDir(), "new-output");
    saveArtifact("my-service", "# Content", dir);
    expect(existsSync(dir)).toBe(true);
  });

  it("writes the artifact content to disk", async () => {
    const { saveArtifact } = await importCli();
    const dir = tempDir();
    const content = "# My Service\n\nDoes stuff.";
    saveArtifact("my-service", content, dir);
    const written = readFileSync(join(dir, "my-service-readme.md"), "utf-8");
    expect(written).toBe(content);
  });

  it("returns the full file path", async () => {
    const { saveArtifact } = await importCli();
    const dir = tempDir();
    const filepath = saveArtifact("my-service", "content", dir);
    expect(filepath).toBe(join(dir, "my-service-readme.md"));
  });

  it("slugifies the service name for the filename", async () => {
    const { saveArtifact } = await importCli();
    const dir = tempDir();
    const filepath = saveArtifact("My Service 2.0!", "content", dir);
    expect(filepath).toContain("my-service-2-0--readme.md");
  });

  it("lowercases the filename", async () => {
    const { saveArtifact } = await importCli();
    const dir = tempDir();
    const filepath = saveArtifact("ComputeOrchestrator", "content", dir);
    expect(filepath).toBe(join(dir, "computeorchestrator-readme.md"));
  });

  it("overwrites an existing file with the same name", async () => {
    const { saveArtifact } = await importCli();
    const dir = tempDir();
    saveArtifact("my-service", "version 1", dir);
    saveArtifact("my-service", "version 2", dir);
    const written = readFileSync(join(dir, "my-service-readme.md"), "utf-8");
    expect(written).toBe("version 2");
  });
});
