# netlify-server

Last updated: 2026-03

## Overview

netlify-server is the primary origin service. It handles blob serving (delivering deployed site files), file and function uploads during deploys, request signature validation, and various API proxy routes. It has direct access to MongoDB and Memcache, and acts as a routing layer that either handles requests itself or proxies them to Functions Origin, Bitballoon, or Imageer.

- **Language**: Go
- **Tier**: Origin service (single region, horizontally scaled)
- **Position in request chain**: 4th (receives requests from Proxy)
- **Repository**: `netlify-server`

## Responsibilities

### Blob serving
- Serves deployed site files (HTML, CSS, JS, images, etc.) from blob storage (S3, GCS)
- Applies transformations: HTML processing pipeline, edge function bundling (eszip)
- Routes image transform requests to **Imageer** (does not perform transforms itself)
- Handles form submissions, processing and forwarding to origin
- Password protection (site-level and account-level basic auth)
- Large media handling for oversized files

### Deploy uploads
- **File uploads**: `PUT /api/v1/deploys/{deployID}/files/{filePath}` — individual file uploads with SHA tracking
- **Function uploads**: `PUT /api/v1/deploys/{deployID}/functions/{functionName}` — routes to Functions Origin (JWT-signed), with fallback to Bitballoon for custom AWS credentials
- **Zip uploads**: `PUT /api/v1/sites/{siteID}/deploys` — bulk deploy uploads
- Deploy permission caching (100-item LRU, 15-minute TTL)
- Concurrent upload limiting per deploy
- Lambda abuse detection and flagging via Memcache

### Request signature validation
- JWT-based signatures validate that requests came through the legitimate request chain
- Includes domain, cache status, password verification status
- Validated before site lookup to fail fast on unauthorized requests

### Site and deploy resolution
- Queries MongoDB for site configurations, deploy metadata, user/team data
- Multi-layer caching: Memcache (2-second TTL for sites, 1-hour for deploys) + in-memory LRU
- Secondary-preferred reads with staleness tolerance, fallback to primary
- Cache-gen header optimization for fast deploy ID resolution

### API proxying
- Multiple specialized routes that netlify-server intercepts and handles rather than forwarding to Bitballoon:
  - **Purge API** — cache invalidation requests
  - **WAF** — Web Application Firewall rule management
  - **Mutations** — site mutation operations
  - **AI gateway** — AI service routing
  - **Database** — database access proxying
  - **Observability** — observability data endpoints
  - **Trusted proxy** — proxy request header handling

### Routing to downstream services
- Requests not handled by netlify-server are proxied to **Bitballoon**
- Function upload requests are proxied to **Functions Origin**
- Image transform requests are routed to **Imageer**
- The decision of "handle locally vs. proxy to Bitballoon" is based on whether netlify-server has implemented handling for that request type. Over time, more functionality has been migrated from Bitballoon to netlify-server.

## Upstream / Downstream

- **Receives from**: Proxy
- **Forwards to**:
  - **Functions Origin** — for function upload requests
  - **Bitballoon** — for any request that netlify-server doesn't handle itself
  - **Imageer** — for image transformation requests

## Key packages

- `server/` — Main HTTP server and request routing. Routes by URL path/host to upload handlers, blob serving, API proxies
- `origin/` — Domain model and MongoDB persistence. Key types: `Site`, `Account`, `Deploy`, `Repo`. `SiteFinder` (~1200 lines) handles complex site lookup with caching and secondary reads
- `blobstore/` — Storage abstraction with implementations for S3, GCS, Memcache, and FileStore. Supports chain-based read/write with fallback
- `blobserv/` — Blob serving logic (~43k lines). Request validation, CORS, authentication, file transformations, function bundling, forms processing
- `conf/` — Configuration from YAML (secrets + values). Config struct covers ports, blob stores, MongoDB, Memcache, Kafka, AWS, etc.
- `storage/` — MongoDB connection pooling, Memcache client abstraction, projection system for efficient queries
- `metrics/` — Request tracking via `RequestTracker`, Datadog integration, round-tripper wrapping for HTTP client metrics
- `filetracking/` — Upload state management with SHA tracking (MongoDB and in-memory implementations)
- `limiter/` — Concurrency limiter and banning rate limiter (Memcache-backed)
- `headerrules/` — HTTP header manipulation rules
- `matcher/` — Request matching logic (uses libredirect like Proxy)
- `funcorigin/` — Functions Origin integration for function upload proxying
- `manifests/` — Edge manifest storage and management

## Configuration

Configured via YAML files (values + secrets) loaded through `netlify/go-config`. Key sections:
- Ports: HTTP (8080), TLS (8443), debug/expvar (6060)
- Blob stores: S3 and GCS configurations with read/write chains
- MongoDB: Replica set config, auth, connection pooling
- Memcache: Internal and assets clusters with discovery endpoints
- Concurrency: Limiting configuration per port
- Kafka: Event publishing configuration
- AWS: S3, CloudFront, DynamoDB, STS credentials

## Build and test

- **Build**: `make build` (with `native_bucketing` tag for libredirect)
- **Test**: `make test` (requires MongoDB, Memcached), `make docker-test` (in container)
- **Local dev**: `make local` (docker-compose environment)
- **Lint**: `make lint` (golangci-lint)
- **Mock generation**: moq library via `go generate`
- **Docker**: Multi-stage build (prod, test, dev stages) on Ubuntu 24

## Dependencies

Key Netlify internal: `go-auth`, `go-config`, `go-headers`, `go-http`, `go-memcache`, `go-observability`, `go-waf`, `libredirect`, `go-flags/v2`, `runtime-schemas/v2`

Key external: MongoDB driver, AWS SDK v2 (S3, CloudFront, DynamoDB, STS), GCS client, chi (HTTP router), logrus (logging), Datadog (APM), kafka-go (Kafka), Bugsnag (errors), bcrypt (password hashing)

## Key considerations

- netlify-server and Bitballoon **both access MongoDB** and can read/write overlapping data. Be aware of data consistency concerns when working on either service.
- The migration pattern is: functionality gradually moves FROM Bitballoon TO netlify-server. When working on netlify-server, check if the behavior you're implementing already exists in Bitballoon.
- Request signature validation is critical for security — it prevents direct access to blob content without going through the legitimate request chain.
- The multi-layer caching (Memcache + LRU + cache-gen headers) is essential for performance. Changes to caching logic can have significant latency impact.
- Image transforms are NOT done by netlify-server — it detects the request and routes to Imageer.
