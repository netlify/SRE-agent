# 🤖 🗺️ Blueprints 🗺️ 🤖

Shared architectural context for Netlify's core services, designed to be consumed by AI coding agents and humans to provide cross-service understanding when working in individual repositories.

## Goals

1. **Cross-service understanding**: When an AI agent works in one repo (e.g., `proxy`), it should understand how that service fits into the broader system — what's upstream, what's downstream, what data flows through it, and what contracts it must honor.

2. **Prevent incorrect assumptions**: AI agents lack tribal knowledge. This repo makes implicit relationships, constraints, and trade-offs explicit so agents don't accidentally break cross-service contracts or undo deliberate design decisions.

3. **Consistent mental model**: All engineers using AI agents across different repos get the same foundational context, ensuring agents produce work that's architecturally coherent.

## How it works

This repo is **not a service**. It produces no artifacts, has no CI, and is never deployed. It is a knowledge base.

Engineers clone it as a sibling directory alongside their service repos:

```
~/work/
├── blueprints/    <- this repo
├── stargate/
├── netlify-ats-plugin/
├── proxy/
├── netlify-server/
├── functions-origin/
├── bitballoon/
├── imageer/
└── cachecontroller/
```

Each service repo has a `CLAUDE.md` (or `AGENTS.md`) at its root with `/read` directives that pull in relevant files from this repo. When an engineer runs Claude Code in a service repo, the agent automatically ingests the shared context it needs.

Example `/read` directives in a service repo's `CLAUDE.md`:

```
/read ../blueprints/architecture.md
/read ../blueprints/services/proxy.md
```

## Repository structure

```
architecture.md        # System-level overview of the request chain and how
                       # services relate. Most service repos /read this.

services/              # One file per service.
├── stargate.md        # Edge: TLS, edge functions, WAF, rate limiting, routing
├── ats.md             # Edge: caching, cache invalidation, A/B testing
├── proxy.md           # Edge: rewrites/redirects, Lambda invocation, durable cache
├── netlify-server.md  # Origin: blob serving, uploads, API proxying, MongoDB
├── bitballoon.md      # Origin: Rails API monolith, core platform
├── functions-origin.md # Origin: function upload/deployment to Lambda, Nimble, etc.
├── imageer.md         # Origin: image transformation (Image CDN)
└── cachecontroller.md # Edge (side-channel): cache invalidation coordination

contracts/             # API contracts between services. How service A calls
                       # service B: endpoints, payloads, auth, error handling.

north-stars/           # Long-term architectural direction. Desired end states
                       # for services and capabilities, so day-to-day work
                       # moves toward (not against) the long-term vision.

conventions/           # Cross-repo engineering standards.
└── go-services.md    # Shared Go libraries (go-http, go-auth, go-observability,
                      #   go-utils, go-service-boilerplate), error handling,
                      #   logging, testing, configuration patterns
```

## Contributing

### Principles

1. **Keep files independently useful.** Each file should make sense on its own when read by an AI agent via a `/read` directive. Don't create files that require reading three others first.

2. **Prefer flat over deep.** Two levels of nesting maximum. Deeper structures create longer `/read` paths and more maintenance burden.

3. **Put stable information first.** Within each file, lead with foundational context. Put volatile or frequently changing details toward the end.

4. **Include a "Last updated" line** at the top of each file so agents and humans can judge staleness.

5. **Keep files focused.** If a file is growing past ~300 lines, it probably covers multiple concerns and should be split.

6. **Write for an AI audience.** Be explicit about things a human might infer from tribal knowledge. State relationships, constraints, and non-obvious behavior directly.

### What belongs here vs. in a service repo

| Put it here (blueprints)                        | Put it in the service repo (CLAUDE.md)  |
| ----------------------------------------------- | --------------------------------------- |
| How services relate to each other               | How to build, test, and run locally     |
| Cross-service contracts and data flows          | Project structure and key directories   |
| Long-term architectural direction (north stars) | Repo-specific conventions and patterns  |
| System-wide patterns and constraints            | Common tasks for that specific codebase |

### Adding a new service

1. Create `services/<service-name>.md` following the existing format (overview, responsibilities, upstream/downstream, key packages, configuration, build/test, key considerations)
2. Update `architecture.md` if the service is part of the request chain or interacts with existing services
3. Create a `CLAUDE.md` in the service repo with `/read` directives pointing to the relevant files here

### Updating existing content

When a service's architecture changes (new responsibilities, new integrations, changed contracts), update both:

- The service file here (`services/<name>.md`) for cross-service context
- The service repo's `CLAUDE.md` for repo-specific details
