# Stargate

Last updated: 2026-03

## Overview

Stargate is the frontdoor service to the Netlify edge. It is the entry point on each CDN node, responsible for TLS termination, edge function execution, security enforcement, and core routing decisions before requests are passed into the rest of the infrastructure.

- **Language**: Go
- **Tier**: Edge service (deployed on all CDN nodes globally)
- **Position in request chain**: 1st (receives raw client requests)
- **Repository**: `stargate`

## Responsibilities

### TLS and routing
- TLS termination for all incoming HTTPS requests via lazy-loaded certificate cache with negative caching and collapsed forwarding (deduplicates concurrent cert fetches for the same domain)
- Core routing decisions — determines which downstream service or handler should process the request
- HTTP reverse proxy to ATS (default path) or direct response for edge-handled requests

### Edge function execution
- **Deno Deploy**: Proxies matching requests to Deno Deploy for edge function execution
- **Nimble** (Unikraft): Proxies matching requests to Nimble, the newer in-house replacement for Deno Deploy
- Stargate acts as a reverse proxy to these runtimes — whatever the runtime returns is sent back to the client
- **Passthrough requests**: Edge functions can make HTTP calls that re-enter Stargate with a signal to skip edge function invocation, following the normal chain (ATS → Proxy → origin) — this prevents infinite loops
- **Bypass signal**: Edge functions can signal that the original request should continue down the normal chain as if no edge function matched
- **Post-cache edge functions**: When an edge function enables cache mode, the invocation is deferred to **Proxy** (not Stargate). Stargate still performs route matching and computes the invocation configuration, then sets that information as request headers. Proxy reads those headers and performs the actual invocation after the ATS cache layer, allowing edge function responses to benefit from caching.

### Security and filtering
- **WAF integration**: Web Application Firewall rules and DDoS challenge handling
- **Rate limiting**: Sliding window algorithm with per-IP and per-domain limits, burst detection, and tarpit (delayed responses to slow attackers)
- **IP banning**: Global bans via Consul, application-level bans, banlist syncing
- **Filter chain**: Host validation, HTTP method/User-Agent/URI/path/header validators, loop detection, verification signature checking

### Observability and eventing
- **GeoIP lookup**: MaxMind GeoIP2 database for geolocation on every request
- **Kafka event publishing**: Traffic events, WAF events, connection events, ban statistics
- **Request tracking**: Unique request IDs, OpenTelemetry tracing, ATS-compatible access logging

### Other routing
- **AI gateway**: Routes AI-specific requests
- **Programmable cache**: Routes programmable cache requests
- **Image transform detection**: Identifies Image CDN requests
- **Region reroute**: Regional failover for resilience
- **Asset CDN / Device server**: Specialized routing paths

## Request flow (simplified)

1. Create request tracker for metrics/logging
2. Parse spoofing headers (`x-nf-spoof` JWT for testing environments)
3. Extract control headers, validate proxied remote address
4. GeoIP lookup
5. Execute filter chain (host, rate limit, banlist, method/UA/URI/path/header validators, loop detection)
6. Check for edge function match → if match, proxy to Deno or Nimble and return response (unless bypass)
7. Fetch metadata from ATS
8. Check for specialized routing (DDoS challenge, image transforms, AI gateway, programmable cache, region reroute)
9. Prepare request (headers, cookies) and reverse proxy to ATS
10. Modify response (HSTS, headers, cookies)
11. Track and log

## Upstream / Downstream

- **Receives from**: Client (internet)
- **Forwards to**:
  - **Deno Deploy / Nimble** — for edge function execution (short-circuits the chain)
  - **ATS** — default path for all other requests

## Key packages

- `proxy/` — Core reverse proxy logic (82+ subdirectories). The main `Proxy` struct and `ServeHTTP` method (~1700 lines) orchestrate the entire request flow
- `proxy/deno/` — Deno edge function invocation and service management
- `proxy/nimble/` — Nimble (Unikraft) invocation, RPC handling, swarm node selection (~28k lines)
- `proxy/metadata/` — Single-flight cache pattern for site metadata fetching from ATS
- `proxy/certs/` — Certificate resolver with lazy loading, negative caching, collapsed forwarding
- `proxy/tracking/` — Request tracking, OpenTelemetry tracing, ATS-compatible access log formatting
- `ratelimit/` — Sliding window rate limiting with main + long window strategies
- `publisher/` — Kafka event publishing
- `consul/` — Consul client for service discovery and ban syncing
- `flags/` — Feature flag management
- `starlog/` — Logging abstraction over logrus

## Configuration

Configured via YAML files (secrets, info, values) loaded through `netlify/go-config`. Key sections:
- `Proxy` — Origin URLs, connection pooling, rate limiter thresholds, Deno/Nimble config, cert config, secrets
- `Server` — HTTP/HTTPS ports (8080/8443)
- `Kafka` — Broker config and topics for event publishing
- `Consul` — Service discovery endpoints
- `HostInfo` — Node metadata (region, group, geohash)

## Build and test

- **Build**: `make build` → `dist/stargate` (CGO_ENABLED=0)
- **Test**: `make test` (unit tests with coverage), `make kafka-test` (with Kafka broker)
- **Lint**: `make lint` (golangci-lint)
- **Run locally**: `make run` (with Kafka via docker-compose)
- **Docker**: Multi-stage build on Ubuntu 22, includes GeoIP2 MMDB database

## Dependencies

Key Netlify internal: `go-config`, `go-auth`, `go-flags/v2`, `go-observability`, `go-headers`, `proxy`, `go-waf`, `runtime-schemas/v2`, `go-trafficsources`

Key external: Cobra (CLI), logrus (logging), kafka-go (Kafka), consul/api (Consul), OpenTelemetry (tracing), gRPC (Nimble), golang-jwt (JWT), maxminddb-golang (GeoIP)

## Key considerations

- As the very first service in the chain, Stargate's performance directly impacts every request's latency. Any bug or outage affects 100% of traffic to a given CDN node.
- Edge function execution typically happens here, with one exception: post-cache edge functions are invoked by Proxy. Stargate always handles route matching and configuration, but defers invocation to Proxy when cache mode is enabled. Proxy handles serverless functions (Lambda) separately.
- The filter chain runs before metadata fetch — requests can be rejected early without hitting origin.
- Nimble is the internal name for the Unikraft-based edge function runtime. Always prefer the term "Nimble" over "Unikraft" in internal documentation.
- Deno Deploy is the older edge function runtime; Nimble is the newer replacement. Both coexist.
