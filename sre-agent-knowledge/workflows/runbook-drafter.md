# Workflow: Runbook Drafter

## Purpose
Generate a first-draft runbook that a developer can put directly into Notion
and an SRE engineer can review without needing to rewrite from scratch.

Scope: K8s services, monolith services (Rails/bitballoon), Lambdas, features,
and pipelines. Not infrastructure-level operational manuals (e.g. database
cluster management).

---

## Phase 1: Classification

Before assembling context or asking questions, determine the runbook type.
Ask these three questions together in a single message:

1. Is this runbook for a **service or component** (something that runs
   continuously and can go down — K8s deployment, Lambda, pipeline) or a
   **feature** (a capability within a service that can break independently)?

2. Who is the expected reader — the **owning team only**, or **any on-call
   engineer** who may be unfamiliar with the service?

3. Does a runbook already exist that needs updating, or is this **net new**?

Do not proceed to Phase 2 until you have answers to all three.

Classification outcomes:

| Type | Reader | Tone | Depth |
|---|---|---|---|
| Service/component | Any on-call | Explanatory, hand-holding | Full 8 sections |
| Service/component | Owning team | Terse, command-focused | Full 8 sections, minimal prose |
| Feature | Any on-call | Explanatory | Abbreviated — skip architecture, consumers |
| Feature | Owning team | Terse | Abbreviated |

For updates to existing runbooks: ask the developer to paste the current
runbook, then diff what needs changing rather than regenerating from scratch.

---

## Phase 2: Context assembly

Pull the following automatically. Tell the developer what you found and what
is missing before asking any questions.

| Source | What to extract |
|---|---|
| Blueprints file for the service | Description, tier, dependencies, owner team |
| `contracts/` entries | What calls this service, what this service calls |
| Service README from GitHub | Deploy process, health check endpoints, env config |
| Prior workflow output (if any) | Failure modes from a Failure Mode Analysis session |

Example acknowledgment:
> "I found the Envelope blueprint (Tier 2, owned by platform-team) and its
> README. I can see it's called by bitballoon and netlify-server. I don't have
> dashboard links, IRB commands, or known failure modes — I'll ask you for
> those now."

If no blueprint exists for the service, say so explicitly and note that
recommendations will rely more heavily on the interview.

---

## Phase 3: Adaptive interview

### Opening batch

Ask the following questions together in a single message. Do not ask them
one at a time.

Frame the opening with what you already know so the developer doesn't repeat
what's in the blueprint.

**For a service/component runbook:**

> "To fill in the sections I can't get from the repo, I need a few things:
>
> 1. What are the 1-3 failure modes that actually happen — the things that
>    have woken someone up or been escalated to SRE? What's the first thing
>    you check when each one happens?
> 2. What's the rollback story for this service — deploy rollback, feature
>    flag flip, IRB state change, or something else?
> 3. If you got paged for this service right now, what would you type in IRB
>    or the CLI to understand what's wrong? Even one or two commands is helpful.
> 4. What's the primary Datadog dashboard URL for this service in prod?
>
> Answer what you know — I'll mark gaps as TODO."

**For a feature runbook:**

> "A few questions to fill in what I can't read from the code:
>
> 1. What does it look like when this feature breaks — what do users see,
>    what do monitors fire, what does the team notice first?
> 2. What are the 1-2 most likely causes when it does break?
> 3. Is there a kill switch — a feature flag, a config change, a deploy?
> 4. Who should be escalated to if the owning team is stuck?
>
> Answer what you know — I'll mark the rest as TODO."

### Follow-up rules

After the opening batch, you have a budget of **3 follow-ups total**.

Trigger a follow-up when an answer reveals a dependency, failure mode, or
procedure that one targeted question would materially clarify. Examples:

- Developer mentions KMS as a dependency: "When KMS is unavailable, does
  the service degrade gracefully or hard fail?"
- Developer mentions "we roll back via IRB": "What's the specific IRB command?"
- Developer mentions a feature flag: "What's the flag name and where is
  it managed — DevCycle, LaunchDarkly, or a config file?"

Do NOT follow up on things you could look up in the README or blueprints,
or anything appropriate as a TODO.

After 3 follow-ups, or when answers feel complete, say:
> "I have enough to draft. One moment."

---

## Phase 4: Draft generation

Generate the runbook as clean markdown using this section order.
Adapt based on classification (see omissions table below).

```markdown
# [Service/Feature Name] Runbook

> **Draft status:** Generated [date] from blueprints + developer interview.
> Sections marked [TODO] require input from the owning team before this
> runbook is considered complete.
> Sources: [list what was used]

---

## Overview
What this service/feature does, why it exists, who owns it, what tier it is.
Written for someone who has never seen it before.

## Architecture & Dependencies
How the service works internally. What it depends on (upstream). What depends
on it (downstream consumers). Include a dependency list, not a diagram.

## Consumers
Which services or clients call this service, and for what purpose.
Derived from contracts/ — if not available, mark TODO.

## Monitoring

| | Prod | Staging |
|---|---|---|
| Logs | [link or TODO] | [link or TODO] |
| Dashboard | [link or TODO] | [link or TODO] |
| APM | [link or TODO] | [link or TODO] |

## Common Failure Modes

### [Failure mode name]
**Symptoms:** What the on-call engineer sees.
**Likely cause:** What's usually wrong.
**Response:**
1. Step one
2. Step two

**Escalate to:** [team or person] if [condition].

## Deploy & Rollback
How to deploy and how to roll back. Include the actual command or UI location.

## Support Commands
IRB, CLI, or shell commands for inspecting or fixing state during an incident.

**[What it does]**
```language
[command]
```

## Escalation
**Primary owner:** [team]
**Escalate to SRE when:** [conditions]
**Out-of-hours:** [TODO]
```

### TODO discipline

Every TODO must:
1. Explain specifically what information is needed
2. Give an example of what good content looks like where helpful
3. Be on its own line so it's easy to search and track

Never leave a section empty without a TODO. Never write placeholder prose
that sounds complete but contains no real information.

### Draft header

Always open with:

> **Sources used:**
> - Blueprint: [found / not found]
> - README: [found / not found]
> - Contracts: [found / not found]
> - Interview: [summary of what developer provided]
>
> **Sections needing review:** [list sections with TODOs]

### Section omissions by type

| Runbook type | Omit |
|---|---|
| Feature (any reader) | Architecture & Dependencies, Consumers |
| Owning team (any type) | Reduce Overview to 2 sentences, omit explanatory prose |
| Lambda / pipeline | Deploy & Rollback becomes "Trigger & Retry" |

### Quality check before outputting

- Does every failure mode have a concrete response, not just "investigate"?
- Are support commands copy-pasteable as written?
- Is every TODO specific enough that someone else could fill it in?
- Does the Overview correctly identify the tier and owner from the blueprint?
- Are monitoring links present or clearly marked as TODO with guidance?
