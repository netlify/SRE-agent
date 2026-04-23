# Functions Origin

Last updated: 2026-03

## Overview

Functions Origin is a specialized origin service that handles the upload and deployment of Netlify Functions to their execution destinations. It receives function bundles from deploy operations and uploads them to AWS Lambda, Deno-compatible storage, the Play platform, or Nimble (Kraft cloud) depending on the function type.

- **Language**: Go
- **Tier**: Origin service (single region, horizontally scaled)
- **Position in request chain**: Receives proxied requests from netlify-server (not directly in the main chain)
- **Repository**: `functions-origin`
- **Database**: MySQL (via GORM) — notably different from the MongoDB used by other core services

## Responsibilities

### Function uploads
- **Lambda functions**: Receives ZIP bundles, uploads to S3, creates AWS Lambda functions. Supports environment variables, VPC config, layers, and multi-region deployment.
- **Deno functions**: Uploads to Deno-specific S3 buckets for edge function execution
- **Edge functions**: Deploys to Nimble (Kraft cloud) via OCI image building and instance provisioning
- **Play functions**: Uploads scripts and Docker images for the Play platform (in-house Lambda alternative, not yet in production)
- **Lambda layers**: Manages shared dependency layers for Lambda functions

### Async processing
- **Kafka consumer**: Processes async messages for function patching — downloads ZIPs from S3, merges files from source repos, re-uploads merged ZIPs
- Separate `kafka-consumer` command for running the consumer independently

### Security
- JWT authentication on all upload endpoints
- Handler detection: Scans ZIPs for entry points, detects runtimes (JS/Python/Ruby/Go/Rust)
- CVE checking: Scans Next.js package.json for known vulnerabilities (CVE-2025-55182)
- Lambda abuse detection and flagging

## Upload flow (Lambda)

1. Parse multipart form request (ZIP + metadata: site ID, deploy ID, function name, runtime, memory, timeout, env vars)
2. Authenticate via JWT
3. Validate bundle size (max 250MB)
4. Compute SHA256 of ZIP, generate function ID (hash of all parameters)
5. Upload ZIP to S3 at `{siteID}/{SHA256}` (per-region buckets)
6. Save Function record to MySQL (skip if duplicate — idempotent)
7. Call AWS Lambda CreateFunction API (S3 reference, layers, env vars, VPC, tags)
8. Poll Lambda until state is ACTIVE
9. Save Lambda record to MySQL

## Data model

- **Function** — Immutable spec: name, runtime, memory, timeout, env vars, SHA256. Stored in MySQL.
- **Lambda** — AWS Lambda function linked to a Function (1:N for multi-region). Stored in MySQL.
- **LambdaLayer** — Shared dependency layers for Lambda functions
- **FunctionToken** — JWT tokens for function access

## Why MySQL (not MongoDB)

Functions Origin uses MySQL with GORM, unlike the MongoDB used by netlify-server and Bitballoon. This is intentional — Netlify has encountered scaling issues with MongoDB and newer services adopt MySQL or Postgres for better scaling characteristics. MongoDB remains for existing services where migration cost is prohibitive.

## Upstream / Downstream

- **Receives from**: netlify-server (proxied requests for function uploads)
- **Forwards to**: AWS S3/Lambda, Deno S3 buckets, Kraft cloud (Nimble), Play platform

## Key packages

- `api/` — HTTP API handlers: Lambda uploads (`lambda.go`), Deno uploads (`deno.go`), edge functions (`edge_functions.go`), Play uploads (`play.go`), authentication, health
- `models/` — GORM data models: Function, Lambda, LambdaLayer, FunctionToken
- `aws/` — AWS service abstractions: `ServiceStore` interface (Lambda, S3, STS), `AccountStore` for assuming roles and selecting accounts per site (~150 configured AWS accounts)
- `blobstore/` — S3 storage abstraction (v1 and v2 SDK versions)
- `internal/handler/` — Runtime handler detection: scans ZIPs for entry points, detects runtimes
- `internal/patching/` — Kafka consumer for async function patching
- `nimble/` — Kraft cloud deployment: OCI image building, instance provisioning
- `consumer/` — Kafka reader loop, message dispatch
- `config/` — Configuration loading, external service initialization
- `database/` — GORM-based MySQL ORM with auto-migration

## Configuration

Configured via YAML files (values + secrets) loaded through `netlify/go-config`:
- `DBConnect` — MySQL connection string
- `Lambda` — ~150 AWS accounts, regions, roles for Lambda deployment
- `LambdaS3`, `DenoS3`, `Play` — S3 bucket configs per region
- `JWTKey` — Secret for request authentication
- `Kraft` — Kraft cloud credentials and metros for edge functions
- Feature flags via DevCycle

## Build and test

- **Build**: `make build` (CGO_ENABLED=0)
- **Test**: `make test` (requires MySQL + LocalStack via docker-compose)
- **Local dev**: `make up` (MySQL 8.0 + LocalStack), `make migrate`, `make dev`
- **Lint**: `make lint` (golangci-lint)
- **Docker compose**: MySQL on 3306, LocalStack on 4566 (S3, Lambda, STS)

## Dependencies

Key Netlify internal: `go-http` (server routing), `go-config`, `go-observability`, `go-auth`, `go-headers`, `go-flags/v2`, `runtime-schemas/v2`, `play/shared`

Key external: AWS SDK v1 + v2 (Lambda, S3, STS), GORM + MySQL driver, Cobra (CLI), golang-jwt (JWT), kafka-go (Kafka consumer), logrus (logging), Bugsnag (errors), DevCycle (feature flags), kraftkit/sdk (Kraft cloud)

## Key considerations

- Functions Origin does NOT handle function invocation — that's initiated by Proxy (Lambda) or Stargate (edge functions). Functions Origin only handles the upload/deployment side.
- The separation between function invocation (Proxy/Stargate) and function deployment (Functions Origin) is deliberate — they have very different scaling and latency requirements.
- ~150 AWS accounts are configured for Lambda deployment. Account selection is per-site.
- Idempotent uploads — duplicate function specs (same SHA256 + params) are detected and skipped.
- Nimble is the internal name for the Unikraft-based edge function runtime. The deployment path goes through Kraft cloud APIs.
