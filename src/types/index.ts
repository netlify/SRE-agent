/**
 * Shared TypeScript types used across the application.
 *
 * Keeping types in one place makes the data model easy to reason about
 * and gives TypeScript full visibility for exhaustive checks.
 */

// ---------------------------------------------------------------------------
// Claude message types (mirrors Anthropic SDK MessageParam)
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

// ---------------------------------------------------------------------------
// Session — one per Slack thread
// ---------------------------------------------------------------------------

export interface Session {
  threadTs: string;
  channelId: string;
  serviceName: string | null;
  workflow: WorkflowName | null;
  workflowState: WorkflowState;
  messages: Message[];
  contextRefs: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export type WorkflowName = "slo_workshop" | "runbook_drafter" | "readme_drafter";

// Each workflow stores its own progress shape in the JSONB workflowState column.
// Using a discriminated union keeps the types precise without a schema change.

export type WorkflowState =
  | SloWorkflowState
  | RunbookWorkflowState
  | ReadmeDrafterState
  | Record<string, never>; // empty — no active workflow

export interface SloWorkflowState {
  workflow: "slo_workshop";
  phase:
    | "classification"
    | "capability_discovery"
    | "sli_definition"
    | "threshold_setting"
    | "output";
  capabilities: string[];
  slis: SliDefinition[];
}

export interface SliDefinition {
  name: string;
  type: "availability" | "latency" | "error_rate";
  query?: string;
  threshold?: number;
}

export interface ReadmeDrafterState {
  workflow: "readme_drafter";
  step: number;
  inputs: Record<string, string>;
}

export interface RunbookWorkflowState {
  workflow: "runbook_drafter";
  phase:
    | "classification"
    | "context_assembly"
    | "interview"
    | "draft";
  runbookType: "service" | "feature" | null;
  audience: "owning_team" | "any_oncall" | null;
  followUpCount: number; // tracks follow-up budget (max 3)
  interviewAnswers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditAction =
  | "message"
  | "workflow_start"
  | "workflow_complete"
  | "sre_tagged";

export interface AuditEntry {
  threadTs: string;
  channelId: string;
  userId: string;
  action: AuditAction;
  serviceName?: string;
  workflow?: string;
  inputText?: string;
  responseText?: string;
  confidence?: number;
  sreTagged: boolean;
  contextUsed: string[];
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  systemPrompt: string;
  workflows: Record<string, string>;
  standards: Record<string, string>;
  templates: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Workflow results
// ---------------------------------------------------------------------------

export interface WorkflowResult {
  response: string;
  artifact?: string;
  done: boolean;
  updatedState?: ReadmeDrafterState;
}

// ---------------------------------------------------------------------------
// Context assembler
// ---------------------------------------------------------------------------

export interface ServiceContext {
  serviceName: string;
  blueprint: string | null;     // contents of blueprints/<service>.md
  readme: string | null;        // contents of service GitHub README
  contracts: string | null;     // relevant contracts/ entries
  filesLoaded: string[];        // which files were successfully loaded
  filesMissing: string[];       // which files were not found
}
