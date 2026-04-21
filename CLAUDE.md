# SRE Agent

This repo is a service that runs a Slack-based SRE agent intended to help internal developers with various production readiness tasks. Tasks include:

- Creating READMEs
- Building architecture diagrams
- Adding observability
- Other production readiness workflows

## Stack

- TypeScript/Node.js, Slack Bolt, Anthropic SDK, PostgreSQL (postgres.js)
- Only `app_mention` Slack events are handled — users must @mention the bot
- Session state (per Slack thread) is persisted in PostgreSQL as JSONB in the `sessions` table
- Knowledge base (system prompt, workflow docs, templates) is cloned from a private GitHub repo at pod startup into `/data/sre-agent-knowledge`

## Local development

```bash
npm run dev:cli   # REPL loop, no Slack needed. Generated files saved to ./output/
npm run test:ci   # typecheck + full test suite (runs automatically on git push)
```

## Database

- RDS PostgreSQL in staging/prod
- `npm run db:setup` only works locally (it shells out to psql with your local username)
- To run migrations against a remote DB, use the `migrate.ts` script at the project root:
  ```bash
  DATABASE_URL="postgres://..." npx tsx migrate.ts
  ```

## Staging

- Runs in the `sre-agent-staging` k8s namespace
- Secrets (DATABASE_URL, ANTHROPIC_API_KEY, Slack tokens, GitHub token) are managed via Vault, encrypted at `_infra/config/staging/secrets.enc.yaml`
- The k8s manifest references `sre-agent-secrets` — this is provisioned via Vault, not `kubectl create secret`
