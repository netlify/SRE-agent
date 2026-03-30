/**
 * Tests for the README Drafter workflow state machine.
 *
 * Unit tests mock the Claude client so they run without ANTHROPIC_API_KEY.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, KnowledgeBase } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Stub knowledge base used by all tests
// ---------------------------------------------------------------------------
const stubKnowledge: KnowledgeBase = {
  systemPrompt: "You are an SRE advisor.",
  workflows: {
    "readme-drafter": `# README Drafter
Guide the user through 7 steps to produce a production-ready README.`,
  },
  standards: {},
  templates: {
    readme: `# {{service_name}}

{{description}}

## Architecture

{{architecture_diagram_link}}

## Dependencies

{{dependencies}}

## Consumers

{{consumers}}

## Inputs / Outputs

{{inputs_outputs}}

## Configuration

{{configuration}}

## Dashboards & Runbook

{{links}}

## Local development

{{local_dev}}

## Deployment

{{deployment}}`,
  },
};

// ---------------------------------------------------------------------------
// Helper to build a Session at a given step
// ---------------------------------------------------------------------------
function makeSession(
  step: number,
  inputs: Record<string, string> = {},
  minsAgo = 0
): Session {
  const updatedAt = new Date(Date.now() - minsAgo * 60 * 1000);
  return {
    threadTs: "test-readme-drafter",
    channelId: "C123",
    serviceName: inputs.serviceName ?? null,
    workflow: step > 0 ? "readme_drafter" : null,
    workflowState:
      step > 0 || Object.keys(inputs).length > 0
        ? { workflow: "readme_drafter", step, inputs }
        : {},
    messages: [],
    contextRefs: [],
    createdAt: new Date(),
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Mock the Claude client so no real API calls are made
// ---------------------------------------------------------------------------
vi.mock("../src/agent/claudeClient.js", () => ({
  completeWithSystemPrompt: vi.fn(),
  streamResponse: vi.fn(),
  complete: vi.fn(),
  loadSystemPrompt: vi.fn(),
  getSystemPrompt: vi.fn(),
  detectSreTag: vi.fn().mockReturnValue(false),
  extractConfidence: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../src/github.js", () => ({
  parseGithubUrl: vi.fn(),
  fetchRepoContext: vi.fn(),
}));

async function mockClaudeResponse(response: string) {
  const { completeWithSystemPrompt } = await import(
    "../src/agent/claudeClient.js"
  );
  vi.mocked(completeWithSystemPrompt).mockResolvedValue(response);
}

async function importWorkflow() {
  return import("../src/workflows/readmeDrafter.js");
}

// ---------------------------------------------------------------------------
// Unit tests (no DB, no Claude)
// ---------------------------------------------------------------------------
describe("README Drafter — advanceWorkflow (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("step 0: returns a question asking for service name and description", async () => {
    await mockClaudeResponse(
      "What's the name of your service and can you give a one-paragraph description?"
    );
    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(makeSession(0), "hello", stubKnowledge);
    expect(result.done).toBe(false);
    expect(result.artifact).toBeUndefined();
    expect(result.response).toBeTruthy();
  });

  it("step 0 → 1: advances when user provides service name and description", async () => {
    await mockClaudeResponse(
      '{"serviceName": "compute-orchestrator", "description": "Manages compute resources."}'
    );
    const { advanceWorkflow } = await importWorkflow();
    const session = makeSession(0);
    const result = await advanceWorkflow(
      session,
      "Service is compute-orchestrator. It manages compute resources.",
      stubKnowledge
    );
    expect(result.done).toBe(false);
    expect(result.artifact).toBeUndefined();
    expect(result.updatedState?.step).toBe(1);
  });

  it("step 1: asks about dependencies", async () => {
    await mockClaudeResponse(
      "What are the upstream services, datastores, and external APIs that compute-orchestrator depends on?"
    );
    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(1, {
        serviceName: "compute-orchestrator",
        description: "Manages compute.",
      }),
      "start",
      stubKnowledge
    );
    expect(result.done).toBe(false);
  });

  it("step 6: returns done=true and a non-empty artifact", async () => {
    await mockClaudeResponse(`# compute-orchestrator

Manages compute resources.

## Architecture

N/A

## Dependencies

- postgres
- redis

## Consumers

- api-gateway

## Inputs / Outputs

REST API in, JSON out

## Configuration

See .env.example

## Dashboards & Runbook

https://datadog.example.com

## Local development

docker compose up

## Deployment

Deploy via CI`);

    const { advanceWorkflow } = await importWorkflow();
    const session = makeSession(6, {
      serviceName: "compute-orchestrator",
      description: "Manages compute resources.",
      dependencies: "postgres, redis",
      consumers: "api-gateway",
      inputsOutputs: "REST API in, JSON out",
      links: "https://datadog.example.com",
      localDev: "docker compose up",
      deployment: "Deploy via CI",
    });
    const result = await advanceWorkflow(session, "", stubKnowledge);
    expect(result.done).toBe(true);
    expect(result.artifact).toBeTruthy();
    expect(result.artifact).toContain("compute-orchestrator");
  });

  it("throws a timeout error when session has not been updated in >30 minutes", async () => {
    const { advanceWorkflow } = await importWorkflow();
    const staleSession = makeSession(2, {}, 31); // 31 minutes ago
    await expect(
      advanceWorkflow(staleSession, "hello", stubKnowledge)
    ).rejects.toThrow(/timeout/i);
  });

  it("returns done=false and no artifact for intermediate steps", async () => {
    await mockClaudeResponse("Got it. What are the consumers of this service?");
    const { advanceWorkflow } = await importWorkflow();
    for (const step of [1, 2, 3, 4, 5]) {
      const session = makeSession(step, {
        serviceName: "svc",
        description: "desc",
        dependencies: "dep",
        consumers: "con",
        inputsOutputs: "io",
        links: "link",
      });
      const result = await advanceWorkflow(session, "yes confirmed", stubKnowledge);
      expect(result.done).toBe(false);
      expect(result.artifact).toBeUndefined();
    }
  });

  it("updatedState is returned on each advance", async () => {
    await mockClaudeResponse(
      '{"serviceName": "my-svc", "description": "Does things."}'
    );
    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(0),
      "my-svc, it does things",
      stubKnowledge
    );
    expect(result.updatedState).toBeDefined();
    expect(result.updatedState?.workflow).toBe("readme_drafter");
    expect(result.updatedState?.inputs.serviceName).toBe("my-svc");
  });
});

// ---------------------------------------------------------------------------
// GitHub URL pre-population tests
// ---------------------------------------------------------------------------
async function mockGithub(repoFiles: Record<string, string> = {}) {
  const { parseGithubUrl, fetchRepoContext } = await import(
    "../src/github.js"
  );
  vi.mocked(parseGithubUrl).mockImplementation((msg: string) =>
    msg.includes("github.com") ? { owner: "netlify", repo: "my-svc" } : null
  );
  vi.mocked(fetchRepoContext).mockResolvedValue({
    owner: "netlify",
    repo: "my-svc",
    files: repoFiles,
  });
}

const fullInference = JSON.stringify({
  serviceName: "my-svc",
  description: "Routes traffic to backend services.",
  dependencies: "postgres, redis",
  consumers: "api-gateway",
  inputsOutputs: "HTTP in, JSON out",
  links: "N/A",
  localDev: "docker compose up",
  deployment: "CI to k8s",
});

describe("README Drafter — GitHub repo URL detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not trigger GitHub path when message has no URL", async () => {
    await mockGithub();
    const { parseGithubUrl } = await import("../src/github.js");
    vi.mocked(parseGithubUrl).mockReturnValue(null);
    await mockClaudeResponse(
      '{"serviceName": "my-svc", "description": "Does things."}'
    );

    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(0),
      "just a service name",
      stubKnowledge
    );
    expect(result.done).toBe(false);

    const { fetchRepoContext } = await import("../src/github.js");
    expect(vi.mocked(fetchRepoContext)).not.toHaveBeenCalled();
  });

  it("does not trigger GitHub path when session is past step 0", async () => {
    await mockGithub();
    await mockClaudeResponse("What are the dependencies?");

    const { advanceWorkflow } = await importWorkflow();
    const session = makeSession(1, {
      serviceName: "my-svc",
      description: "desc",
    });
    await advanceWorkflow(
      session,
      "https://github.com/netlify/my-svc",
      stubKnowledge
    );

    const { fetchRepoContext } = await import("../src/github.js");
    expect(vi.mocked(fetchRepoContext)).not.toHaveBeenCalled();
  });

  it("calls fetchRepoContext when a GitHub URL is detected at step 0", async () => {
    await mockGithub({ "README.md": "# my-svc" });
    await mockClaudeResponse(fullInference);

    const { advanceWorkflow } = await importWorkflow();
    await advanceWorkflow(
      makeSession(0),
      "https://github.com/netlify/my-svc",
      stubKnowledge
    );

    const { fetchRepoContext } = await import("../src/github.js");
    expect(vi.mocked(fetchRepoContext)).toHaveBeenCalledWith({
      owner: "netlify",
      repo: "my-svc",
    });
  });

  it("pre-populates all inputs when inference returns all fields", async () => {
    await mockGithub({ "package.json": '{"name":"my-svc"}' });
    const { completeWithSystemPrompt } = await import(
      "../src/agent/claudeClient.js"
    );
    vi.mocked(completeWithSystemPrompt)
      .mockResolvedValueOnce(fullInference) // inference call
      .mockResolvedValueOnce("# my-svc\n..."); // artifact generation

    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(0),
      "https://github.com/netlify/my-svc",
      stubKnowledge
    );
    expect(result.done).toBe(true);
    expect(result.artifact).toBeTruthy();
  });

  it("advances to the first unfilled step when some fields are missing", async () => {
    await mockGithub({ "README.md": "# my-svc" });
    const partialInference = JSON.stringify({
      serviceName: "my-svc",
      description: "Routes traffic.",
      dependencies: "postgres",
    });
    const { completeWithSystemPrompt } = await import(
      "../src/agent/claudeClient.js"
    );
    vi.mocked(completeWithSystemPrompt)
      .mockResolvedValueOnce(partialInference)
      .mockResolvedValueOnce("Who are the consumers?");

    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(0),
      "https://github.com/netlify/my-svc",
      stubKnowledge
    );
    expect(result.done).toBe(false);
    expect(result.response).toBeTruthy();
    expect(result.updatedState?.step).toBe(2); // consumers step
  });

  it("stays at step 0 and asks normal question when inference returns empty", async () => {
    await mockGithub({});
    const { completeWithSystemPrompt } = await import(
      "../src/agent/claudeClient.js"
    );
    vi.mocked(completeWithSystemPrompt)
      .mockResolvedValueOnce("null") // inference returns nothing
      .mockResolvedValueOnce("What is your service name?");

    const { advanceWorkflow } = await importWorkflow();
    const result = await advanceWorkflow(
      makeSession(0),
      "https://github.com/netlify/my-svc",
      stubKnowledge
    );
    expect(result.done).toBe(false);
    expect(result.response).toBeTruthy();
  });

  it("propagates fetchRepoContext errors to the caller", async () => {
    const { fetchRepoContext } = await import("../src/github.js");
    vi.mocked(fetchRepoContext).mockRejectedValue(
      new Error("Repository not found.")
    );
    const { parseGithubUrl } = await import("../src/github.js");
    vi.mocked(parseGithubUrl).mockReturnValue({
      owner: "netlify",
      repo: "no-such",
    });

    const { advanceWorkflow } = await importWorkflow();
    await expect(
      advanceWorkflow(
        makeSession(0),
        "https://github.com/netlify/no-such",
        stubKnowledge
      )
    ).rejects.toThrow("Repository not found.");
  });
});
