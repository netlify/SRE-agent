# SRE Production Readiness Agent

An AI-powered Slack bot that helps Netlify engineers self-serve on production
readiness. Developers get on-demand guidance grounded in their actual service
architecture, without waiting for SRE availability.

---

## How it works

A developer mentions `@sre-agent` in their team Slack channel. The agent:

1. Loads the session for that thread (or creates a new one)
2. Identifies which service is being discussed
3. Pulls context from the blueprints repo and the service GitHub repo
4. Responds via Claude, grounded in the actual service architecture
5. Optionally runs a structured workflow (SLO Workshop, Runbook Drafter)
6. Produces copy-paste-ready artifacts attached to the thread as files
7. Tags `@sre-team` when confidence is low, creating a feedback loop

All conversation history is stored in PostgreSQL per Slack thread, so sessions
persist across pod restarts and multi-day conversations.

---

## Architecture overview

```
Developer in Slack
      |
      v
Slack Bot App (K8s)          receives events, manages threads, streams responses
      |
      v
Agent Service (K8s)          assembles context, runs prompt engine, calls Claude
      |
      v
Claude API                   streaming responses
      |
      v
PostgreSQL                   session state, conversation history, audit log
```

### Component table

| Component | File | Description |
|---|---|---|
| Entrypoint | `src/index.ts` | Wires everything together. Runs Socket Mode locally, HTTP in production. Handles graceful shutdown. |
| Slack handler | `src/slack/handler.ts` | Receives `app_mention` and thread `message` events. Acknowledges within 3s via reaction, processes async, streams response back as live Slack message updates. |
| Claude client | `src/agent/claudeClient.ts` | Wraps the Anthropic SDK streaming API. Injects context into prompts, detects SRE tags, extracts confidence scores. Falls back to inline system prompt if knowledge repo is unavailable. |
| Database | `src/db/database.ts` | PostgreSQL connection via postgres.js and schema definitions. `runMigrations()` is idempotent — safe to call on every startup. |
| Session manager | `src/db/sessionManager.ts` | CRUD for sessions and audit log. Each Slack thread maps to one session row. Audit writes are fire-and-forget so failures never break responses. |
| Config | `src/config/config.ts` | All environment config loaded and validated with Zod at startup. App exits immediately if required vars are missing. |
| Types | `src/types/index.ts` | Shared TypeScript types for sessions, workflows, messages, and audit entries. |
| System prompt | `sre-agent-knowledge/system-prompt.md` | The SRE persona, behavioral rules, and workflow guidance injected as the Claude system prompt. Editable without touching code. |
| SLO workflow | `sre-agent-knowledge/workflows/slo-workshop.md` | Structured workflow prompt for defining SLIs, setting thresholds, and generating Datadog YAML config. |
| Runbook workflow | `sre-agent-knowledge/workflows/runbook-drafter.md` | Structured workflow prompt for generating first-draft runbooks via classification + adaptive interview + draft generation. |
| K8s manifest | `k8s/deployment.yaml` | Deployment, Service, and secret references. Init containers clone blueprints and knowledge repos on startup. |

---

## Setup

### Prerequisites

- Node.js 22 or higher (`node --version` to check)
- PostgreSQL 14+
- A Slack app with the following bot token scopes:
  - `app_mentions:read`
  - `channels:history`
  - `chat:write`
  - `files:write`
  - `reactions:write`
- An Anthropic API key
- A GitHub token with read access to the service and blueprints repos

### Local development

**1. Clone the repo**

```bash
git clone https://github.com/netlify/sre-agent.git
cd sre-agent
```

**2. Install dependencies**

```bash
npm install
```

**3. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...       # Socket Mode token for local dev
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://sre_agent:password@localhost:5432/sre_agent
GITHUB_TOKEN=ghp_...
SRE_TEAM_SLACK_ID=S...
```

**4. Set up the database**

```bash
npm run db:setup
```

**5. Start the bot**

```bash
npm run dev
```

The bot connects via Socket Mode — no public URL or ngrok needed for local dev.
`tsx watch` provides hot reload on file changes.

---

## Database

### Overview

All state is stored in PostgreSQL via [postgres.js](https://github.com/porsager/postgres),
a modern TypeScript-native Postgres client with tagged template literals for
safe parameterised queries.

**`sessions`** — one row per Slack thread. Stores the full Claude conversation
history as JSONB, the active workflow and its progress state, and which
blueprint/README files were loaded into context.

**`audit_log`** — one immutable row per interaction. Stores the developer's
message, the agent's response, confidence level, whether SRE was tagged, and
which context files were used. Used for accountability and prompt improvement.

### Schema

```sql
sessions (
    thread_ts       TEXT PRIMARY KEY,   -- Slack thread timestamp (natural key)
    channel_id      TEXT,
    service_name    TEXT,               -- set once identified in conversation
    workflow        TEXT,               -- active workflow name, or NULL
    workflow_state  JSONB,              -- workflow-specific progress tracking
    messages        JSONB,              -- full Claude message history
    context_refs    JSONB,              -- which files were loaded
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ         -- auto-updated by trigger
)

audit_log (
    id              BIGSERIAL PRIMARY KEY,
    thread_ts       TEXT,
    channel_id      TEXT,
    user_id         TEXT,               -- Slack user ID
    action          TEXT,               -- 'message' | 'workflow_start' | 'workflow_complete' | 'sre_tagged'
    service_name    TEXT,
    workflow        TEXT,
    input_text      TEXT,
    response_text   TEXT,
    confidence      FLOAT,              -- 0.0-1.0, NULL if not expressed
    sre_tagged      BOOLEAN,
    context_used    JSONB,
    created_at      TIMESTAMPTZ
)
```

### Migrations

Migrations run automatically on startup via `runMigrations()` in
`src/db/database.ts`. The schema SQL uses `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS` — safe to run on every deploy.

---

## Knowledge repo

The agent's behavior is controlled by markdown files in `sre-agent-knowledge/`.
These files are loaded at startup from a local clone of the knowledge repo.
SRE engineers can update agent behavior by opening a PR — no code changes required.

```
sre-agent-knowledge/
├── system-prompt.md        # Core SRE persona and behavioral rules
├── standards/
│   ├── slos.md             # SLO definition standards by tier
│   └── alerting.md         # Required monitor types by tier
├── workflows/
│   ├── slo-workshop.md     # SLO Workshop workflow prompt
│   └── runbook-drafter.md  # Runbook Drafter workflow prompt
├── artifacts/
│   └── slo-template.yaml   # Output format for SLO configs
└── tiers/
    ├── tier-1.md           # Tier 1 reliability requirements
    └── tier-2.md           # Tier 2 reliability requirements
```

---

## Deployment

**Build and push the image**

```bash
docker build -t <registry>/sre-agent:latest .
docker push <registry>/sre-agent:latest
```

**Create the K8s secret**

```bash
kubectl create secret generic sre-agent-secrets \
  --from-literal=slack-bot-token=xoxb-... \
  --from-literal=slack-signing-secret=... \
  --from-literal=anthropic-api-key=sk-ant-... \
  --from-literal=database-url=postgresql://... \
  --from-literal=github-token=ghp_... \
  --from-literal=sre-team-slack-id=S... \
  --from-literal=blueprints-repo-url=https://github.com/netlify/blueprints.git \
  --from-literal=knowledge-repo-url=https://github.com/netlify/sre-agent-knowledge.git
```

**Apply manifests**

```bash
kubectl apply -f k8s/
```

The deployment uses init containers to clone the blueprints and knowledge repos
on startup. Sprint 2 will replace this with a git-sync sidecar for live updates.

---

## Artifact delivery

When a workflow produces a structured output (SLO YAML config, runbook draft),
the agent:

1. Posts a short summary in the Slack thread — what was generated, what TODOs remain
2. Attaches the full artifact as a `.md` or `.yaml` file to the same thread message

The developer downloads or copies the file into Notion or their editor.
Notion API integration (auto-create draft pages) is planned for Phase 2.

---

## Testing

```bash
# Run tests once
npm test

# Watch mode
npm run test:watch

# Type checking only
npm run typecheck
```

Tests use [Vitest](https://vitest.dev/), which has native TypeScript support
with no build step required. Sprint 1 tests cover the pure functions in the
Claude client and Slack handler. Integration tests (Sprint 2+) will cover
the context assembler and workflow logic.

---

## What's currently working

The Sprint 1 foundation is complete. The following components are fully
implemented and ready to run:

**Slack bot scaffolding** — the bot receives `app_mention` and thread `message`
events via Slack Bolt. It acknowledges within 3 seconds using a 👀 reaction,
processes messages asynchronously, and streams Claude's response back to the
thread as a live updating message. A ✅ reaction replaces 👀 when the response
is complete.

**Claude API client** — streaming responses from Claude using the Anthropic
TypeScript SDK. Context can be injected into the final user message (blueprint
files, README content) before the API call. The client detects `@sre-team`
mentions in responses and extracts self-assessed confidence scores for audit
logging.

**Session persistence** — every Slack thread maps to a PostgreSQL session row.
Conversation history, active workflow, workflow progress state, and loaded
context file references are all stored per thread. Sessions survive pod
restarts and support multi-day conversations.

**Database schema and migrations** — both tables (`sessions` and `audit_log`)
are defined and migrations run automatically on startup. The schema is
idempotent so it is safe to apply on every deploy.

**Audit logging** — every interaction is written to `audit_log` including the
user's message, the agent's response, confidence level, whether SRE was tagged,
and which context files were used. Audit write failures are caught and logged
without breaking the response.

**Configuration validation** — all environment variables are validated with
Zod at startup. The app exits immediately with a clear error message if any
required variable is missing, rather than failing at runtime.

**System prompt** — the SRE persona, behavioral rules, and workflow guidance
are defined in `sre-agent-knowledge/system-prompt.md` and loaded at startup.
The agent falls back to an inline prompt if the knowledge repo is not yet
cloned.

**Workflow designs** — the SLO Workshop and Runbook Drafter workflows are fully
designed and documented as markdown prompt files in `sre-agent-knowledge/workflows/`.
These are ready to be wired into the agent in Sprint 3.

**Kubernetes manifests** — deployment, service, and init containers for cloning
the blueprints and knowledge repos on startup are defined in `k8s/deployment.yaml`.

---

## What's partially working

**Free-form conversation** — the bot can hold a conversation with a developer
and respond via Claude using the system prompt. However it does not yet pull
any service-specific context (no blueprints, no GitHub README). All responses
are based on the system prompt alone, so recommendations are generic rather
than grounded in the actual service architecture. This is resolved in Sprint 2.

**Workflow routing** — the agent's system prompt describes the SLO Workshop and
Runbook Drafter workflows, so Claude will mention them when relevant. However
there is no structured workflow state machine yet — the agent cannot actually
run a workflow end-to-end, track phases, or produce a formatted artifact. This
is implemented in Sprint 3.

**Knowledge repo loading** — the system prompt loads from
`sre-agent-knowledge/system-prompt.md` if the file exists. The standards,
tiers, and workflow prompt files are designed and their directory structure is
in place, but the content files themselves have not been populated yet.

---

## What's planned

**Sprint 2 — context assembly**

- GitHub API integration to fetch service READMEs and relevant code files on demand
- Local clone of the blueprints repo, synced via webhook on push to main
- Context assembler that pulls blueprint + README + contracts for a named service and injects them into the Claude prompt
- Free-form conversation becomes fully grounded: recommendations reference the actual service architecture, dependencies, and tier

**Sprint 3 — workflows and artifact delivery**

- SLO Workshop workflow: guided multi-phase conversation covering capability identification, SLI definition, threshold setting, and Datadog YAML output
- Runbook Drafter workflow: classification, context assembly, adaptive interview (capped at 3 follow-ups), and full draft generation
- Artifact delivery: agent posts a summary in Slack and attaches the full `.md` or `.yaml` file to the thread

**Phase 2**

- Failure Mode Analysis workflow: systematic walkthrough of what happens when each dependency fails
- Alerting Review workflow: gap analysis against monitoring standards by service tier
- Notion API integration: agent creates a draft Notion page and posts the link in Slack instead of attaching a file
- git-sync sidecar: replace init container repo cloning with a live-syncing sidecar so the agent picks up knowledge repo changes without a redeploy
