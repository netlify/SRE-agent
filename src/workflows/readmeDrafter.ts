import { completeWithSystemPrompt } from "../agent/claudeClient.js";
import { parseGithubUrl, fetchRepoContext } from "../github.js";
import type {
  KnowledgeBase,
  Session,
  WorkflowResult,
  ReadmeDrafterState,
} from "../types/index.js";
import type { RepoContext } from "../github.js";

const WORKFLOW = "readme-drafter";
const TIMEOUT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Extract a JSON object from text that may contain markdown code fences
// ---------------------------------------------------------------------------
function extractJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const fenced = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(fenced) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build workflow-specific system prompt
// ---------------------------------------------------------------------------
function buildWorkflowPrompt(knowledge: KnowledgeBase): string {
  const base = knowledge.systemPrompt;
  const workflowDoc = knowledge.workflows[WORKFLOW];
  if (!workflowDoc) return base;
  return `${base}\n\n## Workflow: ${WORKFLOW}\n\n${workflowDoc}`;
}

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------
interface StepDef {
  displayPrompt(inputs: Record<string, string>, userMessage: string): string;
  extractPrompt(inputs: Record<string, string>, userMessage: string): string;
  extractField: string | string[];
  canAdvance?(inputs: Record<string, string>): boolean;
}

const STEPS: StepDef[] = [
  // Step 0 — service name + description
  {
    displayPrompt(inputs, _userMessage) {
      if (inputs.serviceName && !inputs.description) {
        return `Got it — the service is *${inputs.serviceName}*. Now give me a one-paragraph description of what it does.`;
      }
      return `What is the name of your service, and what does it do? (You can give me both at once, or just the name first.)`;
    },
    extractPrompt(inputs, userMessage) {
      const context = inputs.serviceName
        ? `We already know the service name is "${inputs.serviceName}". `
        : "";
      return `${context}Extract any service name and/or description from this message. Reply with ONLY a JSON object using only the keys you found: e.g. {"serviceName": "..."} or {"description": "..."} or {"serviceName": "...", "description": "..."}. If there is nothing to extract, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: ["serviceName", "description"],
    canAdvance: (inputs) => !!(inputs.serviceName && inputs.description),
  },
  // Step 1 — dependencies
  {
    displayPrompt(inputs, _userMessage) {
      return `What upstream services, datastores, and external APIs does *${inputs.serviceName}* depend on? (e.g. PostgreSQL, Redis, S3, the auth-service — or "none")`;
    },
    extractPrompt(_inputs, userMessage) {
      return `Extract the list of dependencies from this message. Reply with ONLY a JSON object: {"dependencies": "..."}\n\nIf the user says "none", "skip", or similar, use {"dependencies": "none"}. If the message is unrelated to dependencies, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: "dependencies",
  },
  // Step 2 — consumers
  {
    displayPrompt(inputs, _userMessage) {
      return `Who are the consumers of *${inputs.serviceName}*? (Other services, teams, or external clients that call or depend on it — or "none")`;
    },
    extractPrompt(_inputs, userMessage) {
      return `Extract the consumers from this message. Reply with ONLY a JSON object: {"consumers": "..."}\n\nIf the user says "none", "skip", or similar, use {"consumers": "none"}. If the message is unrelated to consumers, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: "consumers",
  },
  // Step 3 — inputs / outputs
  {
    displayPrompt(inputs, _userMessage) {
      return `What are the inputs and outputs of *${inputs.serviceName}*? (e.g. REST API requests in, JSON responses out — or event types it consumes/produces)`;
    },
    extractPrompt(_inputs, userMessage) {
      return `Extract the inputs and outputs description from this message. Reply with ONLY a JSON object: {"inputsOutputs": "..."}\n\nIf the user says "skip" or "N/A", use {"inputsOutputs": "N/A"}. If the message is unrelated, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: "inputsOutputs",
  },
  // Step 4 — links
  {
    displayPrompt(inputs, _userMessage) {
      return `Do you have any links for *${inputs.serviceName}*? (Datadog dashboard, runbook, architecture diagram — or type "skip")`;
    },
    extractPrompt(_inputs, userMessage) {
      return `Extract links (dashboard, runbook, diagram URLs) or a skip signal from this message. Reply with ONLY a JSON object: {"links": "..."}\n\nUse "N/A" if the user skipped. If they didn't answer this question at all, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: "links",
  },
  // Step 5 — local dev + deployment
  {
    displayPrompt(inputs, _userMessage) {
      return `Any local development setup or deployment notes for *${inputs.serviceName}*? (Commands, env vars, deploy process — or type "skip")`;
    },
    extractPrompt(_inputs, userMessage) {
      return `Extract local dev setup and deployment notes from this message. Reply with ONLY a JSON object: {"localDev": "...", "deployment": "..."}\n\nUse "N/A" if skipped. If they didn't answer, reply: null\n\nMessage: "${userMessage}"`;
    },
    extractField: ["localDev", "deployment"],
  },
];

// ---------------------------------------------------------------------------
// GitHub repo inference helpers
// ---------------------------------------------------------------------------

function firstUnfilledStep(inputs: Record<string, string>): number {
  for (let i = 0; i < STEPS.length; i++) {
    const stepDef = STEPS[i];
    const can = stepDef.canAdvance
      ? stepDef.canAdvance(inputs)
      : defaultCanAdvance(stepDef, inputs);
    if (!can) return i;
  }
  return STEPS.length;
}

async function inferInputsFromRepo(
  repoContext: RepoContext,
  systemPrompt: string
): Promise<Record<string, string>> {
  const fileSections = Object.entries(repoContext.files)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  if (!fileSections) return {};

  const prompt = `You are analysing the following files from the GitHub repository ${repoContext.owner}/${repoContext.repo}.

${fileSections}

Based on these files, fill in ALL of the following fields. Every field must have a value — never omit a field.
- If you can determine the value from the files, provide it concisely.
- If the field does not apply to this type of project, write a short descriptive explanation (e.g. "N/A — CLI tool, not a networked service" for inputsOutputs on a command-line utility).
- For consumers, make a reasonable inference from context (e.g. "Internal engineering teams using this to deploy services" for a deployment tool).
- Return ONLY a JSON object — no markdown, no code fences.

Fields:
- serviceName: the canonical service/repo name
- description: a concise one-paragraph description of what this service does
- dependencies: upstream services, datastores, and external APIs this service depends on
- consumers: who uses this (infer from context — a library is used by developers, a CLI tool by internal teams, an API by other services)
- inputsOutputs: how data flows in and out — for CLI tools describe the commands and side effects; for services describe API contracts or event types
- links: any dashboard, runbook, or diagram URLs found in the files, or "N/A" if none
- localDev: how to run or install locally (from README, Makefile, etc.), or "N/A" if not documented
- deployment: how it is deployed or distributed (CI/CD, package registry, etc.), or "N/A" if not documented`;

  const response = await completeWithSystemPrompt(
    "You are a data extraction assistant. Return ONLY raw JSON — no markdown, no code fences, no explanation.",
    [{ role: "user", content: prompt }]
  );

  const extracted = extractJson(response);
  if (!extracted) return {};

  const result: Record<string, string> = {};
  const FIELDS = [
    "serviceName",
    "description",
    "dependencies",
    "consumers",
    "inputsOutputs",
    "links",
    "localDev",
    "deployment",
  ];
  for (const field of FIELDS) {
    const val = extracted[field];
    if (val != null && String(val).trim() !== "" && val !== "null") {
      result[field] = String(val);
    }
  }
  return result;
}

function defaultCanAdvance(
  stepDef: StepDef,
  inputs: Record<string, string>
): boolean {
  const fields = Array.isArray(stepDef.extractField)
    ? stepDef.extractField
    : [stepDef.extractField];
  return fields.some((f) => !!inputs[f]);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function advanceWorkflow(
  session: Session,
  userMessage: string,
  knowledge: KnowledgeBase
): Promise<WorkflowResult> {
  // Timeout check
  const ageMs = Date.now() - session.updatedAt.getTime();
  if (ageMs > TIMEOUT_MINUTES * 60 * 1000) {
    throw new Error(
      `Session timeout: no activity for more than ${TIMEOUT_MINUTES} minutes`
    );
  }

  // Extract step and inputs from workflowState
  const state = session.workflowState as
    | { workflow: string; step: number; inputs: Record<string, string> }
    | Record<string, never>;
  const step = Math.min(
    "step" in state ? state.step : 0,
    STEPS.length
  );
  const existingInputs: Record<string, string> =
    "inputs" in state ? state.inputs : {};

  const systemPrompt = buildWorkflowPrompt(knowledge);

  // GitHub repo path: fires on step 0 whenever a GitHub URL is detected
  if (step === 0 && userMessage.trim()) {
    const coords = parseGithubUrl(userMessage);
    if (coords) {
      const repoContext = await fetchRepoContext(coords); // throws on error
      const inferred = await inferInputsFromRepo(repoContext, systemPrompt);
      const mergedInputs = { ...inferred };

      const targetStep = firstUnfilledStep(mergedInputs);
      const updatedState: ReadmeDrafterState = {
        workflow: "readme_drafter",
        step: targetStep,
        inputs: mergedInputs,
      };

      const filledFields = Object.keys(mergedInputs);
      // All fields filled → generate immediately
      if (targetStep >= STEPS.length) {
        const generatePrompt = buildGeneratePrompt(mergedInputs, knowledge);
        const artifact = await completeWithSystemPrompt(systemPrompt, [
          { role: "user", content: generatePrompt },
        ]);
        return {
          response: `Here's the README for *${coords.repo}* — copy it straight into your repo.`,
          artifact,
          done: true,
          updatedState,
        };
      }

      const filledFields = Object.keys(mergedInputs);
      const ackPrefix = filledFields.length > 0
        ? `Fetched *${coords.owner}/${coords.repo}* — a few questions to fill in the gaps.\n\n`
        : `Fetched *${coords.owner}/${coords.repo}* — couldn't determine much from the files, so let's go through a few questions.\n\n`;

      const nextStepDef = STEPS[targetStep];
      return {
        response: `${ackPrefix}${nextStepDef.displayPrompt(mergedInputs, "")}`,
        done: false,
        updatedState,
      };
    }
  }

  // Terminal step: generate artifact
  if (step >= STEPS.length) {
    const generatePrompt = buildGeneratePrompt(existingInputs, knowledge);
    const artifact = await completeWithSystemPrompt(systemPrompt, [
      { role: "user", content: generatePrompt },
    ]);
    return {
      response: "Here's your README — copy it straight into your repo.",
      artifact,
      done: true,
    };
  }

  const stepDef = STEPS[step];

  // Extract structured data from user message (separate JSON-only call)
  let updatedInputs = { ...existingInputs };
  let anyExtracted = false;

  if (userMessage.trim()) {
    const extractResponse = await completeWithSystemPrompt(
      "You are a data extraction assistant. Return ONLY raw JSON — no markdown, no code fences, no explanation.",
      [{ role: "user", content: stepDef.extractPrompt(existingInputs, userMessage) }]
    );
    const extracted = extractJson(extractResponse);
    if (extracted) {
      const fields = Array.isArray(stepDef.extractField)
        ? stepDef.extractField
        : [stepDef.extractField];
      for (const f of fields) {
        const val = extracted[f];
        if (val != null && val !== "null" && String(val).trim() !== "") {
          updatedInputs[f] = String(val);
          anyExtracted = true;
        }
      }
    }
  }

  const canAdvance = stepDef.canAdvance
    ? stepDef.canAdvance(updatedInputs)
    : defaultCanAdvance(stepDef, updatedInputs);

  if (canAdvance) {
    const nextStep = firstUnfilledStep(updatedInputs);
    const updatedState: ReadmeDrafterState = {
      workflow: "readme_drafter",
      step: nextStep,
      inputs: updatedInputs,
    };

    if (nextStep >= STEPS.length) {
      const generatePrompt = buildGeneratePrompt(updatedInputs, knowledge);
      const artifact = await completeWithSystemPrompt(systemPrompt, [
        { role: "user", content: generatePrompt },
      ]);
      return {
        response: "Here's your README — copy it straight into your repo.",
        artifact,
        done: true,
        updatedState,
      };
    }

    const nextStepDef = STEPS[nextStep];
    return {
      response: nextStepDef.displayPrompt(updatedInputs, ""),
      done: false,
      updatedState,
    };
  }

  // Partial extraction — stay on this step, save partial progress
  const updatedState: ReadmeDrafterState = {
    workflow: "readme_drafter",
    step,
    inputs: updatedInputs,
  };

  // Suppress unused variable warning
  void anyExtracted;

  return {
    response: stepDef.displayPrompt(updatedInputs, userMessage),
    done: false,
    updatedState,
  };
}

function buildGeneratePrompt(
  inputs: Record<string, string>,
  knowledge: KnowledgeBase
): string {
  const template = knowledge.templates["readme"] ?? "";
  return `Generate a production-ready README for the service "${inputs.serviceName}" using the information below. Fill in the template provided. Return only the completed markdown, no preamble.

## Template
${template}

## Collected information
- **Service name:** ${inputs.serviceName ?? "N/A"}
- **Description:** ${inputs.description ?? "N/A"}
- **Dependencies:** ${inputs.dependencies ?? "N/A"}
- **Consumers:** ${inputs.consumers ?? "N/A"}
- **Inputs/Outputs:** ${inputs.inputsOutputs ?? "N/A"}
- **Links:** ${inputs.links ?? "N/A"}
- **Local dev:** ${inputs.localDev ?? "N/A"}
- **Deployment:** ${inputs.deployment ?? "N/A"}`;
}
