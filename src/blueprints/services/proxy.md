# Proxy

Last updated: 2026-03

## Overview

Proxy is the last edge service in the request chain. It handles URL rewriting and redirects (via a C++ matching engine), invokes serverless functions (AWS Lambda), manages the Durable Cache (a region-wide caching layer backed by DynamoDB and S3), and routes image transformation requests to Imageer.

- **Language**: Go (with C++ for the rule matching engine, libredirect)
- **Tier**: Edge service (deployed on all CDN nodes globally)
- **Position in request chain**: 3rd (receives requests from ATS)
- **Repository**: `proxy`

## Responsibilities

### Rewrite and redirect rules
- URL rewriting and HTTP redirects based on site configuration
- Rule matching delegated to **libredirect**, a C++ engine compiled as a shared library and called from Go for performance
- Rules are loaded from origin and cached in an LRU cache keyed by domain
- First-match-wins semantics — rule order matters

### Serverless function invocation
- Matches request paths against function routes from site manifests
- Invokes **AWS Lambda** functions with payload encoding, retry logic, and exponential backoff
- Supports **background functions** (fire-and-forget invocation via `-background` suffix or mode setting)
- Supports **Play** platform functions (a new in-house alternative to Lambda, not yet in production)
- Handles streaming and buffered function responses
- Circuit breaker prevents cascading failures from failing functions

### Durable Cache
- Region-wide cache backed by **DynamoDB** (inventory) and **S3** (storage)
- Once an item is cached on any node in a region, all nodes in that region can serve it
- Mutex-based global revalidation coordination (prevents multiple nodes from revalidating simultaneously)
- Supports stale-while-revalidate: serves stale content while revalidating in background
- Generation-based invalidation for cache freshness
- Multi-region support with request rerouting to other regions

### Image CDN
- Detects image transformation requests and routes them to **Imageer** (origin service)
- Imageer handles the actual transform; Proxy relays the response

### Post-cache edge function invocation
- When an edge function enables cache mode ("post-cache edge functions"), Proxy performs the invocation instead of Stargate
- Stargate handles route matching and computes the invocation configuration, passing it as request headers
- Proxy reads those headers and invokes the edge function after the ATS cache layer, allowing responses to benefit from caching
- This is distinct from regular edge functions (invoked by Stargate) and serverless functions (Lambda, also invoked by Proxy)

### Other responsibilities
- **AI gateway**: Routes AI-specific requests to the AI gateway service
- **Programmable cache**: Caching layer for serverless function responses with custom cache control
- **Request signature validation**: Validates request signatures before processing
- **Region rerouting**: Can reroute requests to different Netlify regions for durable cache or failover

## Request flow (simplified)

1. Extract OpenTelemetry context, validate request (URI length limits, signature)
2. Check programmable cache, region reroute, stale-while-revalidate, AI gateway
3. Check for edge function matches (from cached rules)
4. Try to match request against cached rules (`proxyMatchFromCache()`)
5. If no cache hit, fetch rules from origin (`handleOriginRequest()`)
6. Route matched request to handler:
   - `handleFunctionRequest()` → Lambda/Play invocation
   - `handleProxyRequest()` → Proxy to origin
   - Direct redirect response
7. Stream or buffer response to client

## Upstream / Downstream

- **Receives from**: ATS
- **Forwards to**:
  - **netlify-server** — on cache miss, origin-bound requests
  - **AWS Lambda** — for serverless function invocation
  - **Imageer** — for image transformation requests

## Key packages

- `server/` — Core HTTP request handling (~46 files, ~19.5k LOC). Main `ServeHTTP`, function handling, proxy handling, central cache, region reroute
- `matcher/` — Rules/redirect/rewrite matching engine (C++ bindings via libredirect). `ProxyMatch` represents a matched rule
- `pkg/cache/` — Multi-tier caching: `RulesCache` (LRU, domain-keyed), `IDCache` (generation tracking), `GenCache` (durable cache generations)
- `pkg/functions/lambda/` — AWS Lambda invocation with STS credential management, retry, streaming
- `pkg/responsecache/` — Durable/central cache: DynamoDB inventory + S3 storage, Vary parsing, gzip compression, generation-based invalidation
- `pkg/programmablecache/` — Caching layer for serverless function responses
- `conf/` — Configuration loading from YAML (secrets + hosts files)
- `rproxy/` — Custom reverse proxy utilities
- `flags/` — Feature flag integration (DevCycle)

## Caching tiers

Proxy manages multiple caching layers (distinct from the ATS edge cache):

1. **Rules Cache** — LRU cache of site redirect/rewrite rules, keyed by domain. Validated against generation IDs.
2. **ID Cache** — Tracks deploy generation IDs to detect when cached rules are stale
3. **Gen Cache** — Tracks generations for durable cache assets
4. **Central/Durable Cache** — DynamoDB + S3 backed, region-wide persistence

## Configuration

Configured via YAML files (secrets + hosts) loaded through `netlify/go-config`. Key sections:
- `OriginURLs` — Web and API origin endpoints
- `Caching` — Rules cache size, default cache size
- `Functions` — Retry limits, STS credentials, tracking log
- `Kafka` — Brokers and topics for event publishing
- `CentralCacheCredentials` — DynamoDB/S3 for durable cache
- `PlayConfig` — Play platform endpoints per region
- `ImageConfig` — Imageer endpoints and secrets
- `GatewayConfig` — AI gateway credentials

## Build and test

- **Build**: `make build` → compiles Go binary + libredirect C++ library → `dist/proxy`
- **Test**: `make test` (75 test files, requires docker-compose for DynamoDB, S3/MinIO, Kafka)
- **Docker compose**: `make up/down` for test dependencies
- **Docker**: Multi-stage build on Ubuntu 24 base with libredirect and jemalloc

## Dependencies

Key Netlify internal: `libredirect` (C++ rule matching), `go-observability`, `go-headers`, `go-auth`, `go-flags/v2`, `runtime-schemas/v2`

Key external: AWS SDK v2 (Lambda, DynamoDB, S3, STS), Cobra (CLI), logrus (logging), kafka-go (Kafka), OpenTelemetry (tracing), golang-jwt (JWT), DevCycle (feature flags), Datadog (APM), Bugsnag (errors)

## Key considerations

- Proxy is the last edge service before requests hit origin. It's the boundary between globally distributed and centralized infrastructure.
- The **Durable Cache** vs **Edge Cache** distinction is critical: Edge Cache (ATS) is per-node, Durable Cache (Proxy) is per-region. See: https://docs.netlify.com/build/caching/caching-overview/#durable-directive
- Rule matching is delegated to C++ (libredirect) for performance — the Go code handles orchestration around it.
- Serverless function invocation happens here (Lambda). Edge function execution is typically in Stargate, except for post-cache edge functions which Proxy invokes using configuration headers set by Stargate.
- Feature flags (DevCycle) control behavior dynamically at runtime — cache sizes, retry limits, timeout thresholds.
- Strict request validation: URI path limit 4096, total request URI 15360, query string 10240 characters.
