# Blueprints

This repository contains shared architectural context for Netlify's core services. It is designed to be consumed by AI coding agents (primarily Claude Code) to provide cross-service understanding when working in individual service repositories.

## How this repo is used

This repo is **not a service**. It produces no artifacts, has no CI, and is never deployed. It exists solely as a knowledge base.

Engineers clone this repo as a sibling directory alongside their service repos:

```
~/work/
├── blueprints/    ← this repo
├── stargate/
├── ats/
├── proxy/
├── netlify-server/
├── functions-origin/
└── bitballoon/
```

Each service repo has its own `CLAUDE.md` with `/read` directives that pull in relevant files from this repo. When an engineer runs Claude Code in a service repo, the agent automatically ingests the shared context it needs.

## Repository structure

- `architecture.md` — System-level overview of the Netlify request chain and how services relate. **This is the most important file.** Most service repos should `/read` this.
- `services/` — One file per service. Covers what it does, what it owns, its public interface, and non-obvious implementation details.
- `contracts/` — API contracts and integration points between services. Describes how service A calls service B: endpoints, payloads, auth, error handling.
- `north-stars/` — Long-term architectural direction. Describes desired end states for services and capabilities that everyone should be aware of, so that day-to-day work moves toward (or at least doesn't work against) the long-term vision.
- `conventions/` — Cross-repo engineering standards: shared libraries, error handling patterns, API design, testing philosophy.

## Contributing

When updating this repo, follow these principles:

1. **Keep files independently useful.** Each file should make sense on its own when read by an AI agent via a `/read` directive. Don't create files that require reading three others first.
2. **Prefer flat over deep.** Two levels of nesting maximum. Deeper structures create longer `/read` paths and more maintenance burden.
3. **Put stable information first.** Within each file, lead with foundational context. Put volatile or frequently changing details toward the end.
4. **Include a "Last updated" line** at the top of each file so agents and humans can judge staleness.
5. **Keep files focused.** If a file is growing past ~300 lines, it probably covers multiple concerns and should be split.
6. **Write for an AI audience.** Be explicit about things a human might infer from tribal knowledge. State relationships, constraints, and non-obvious behavior directly.
