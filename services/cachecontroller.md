# Cachecontroller

Last updated: 2026-03

## Overview

Cachecontroller is a message consumer that runs on each CDN edge node and coordinates cache invalidation across the edge caching layers. It consumes purge messages from NATS and Kafka (published by origin services during deploys), then sends HTTP requests to Proxy, ATS, and Stargate in a specific order to invalidate cached content.

- **Language**: Go
- **Tier**: Edge service (deployed on all CDN nodes globally)
- **Position**: Side-channel — not in the request path, but critical for cache freshness
- **Repository**: `cachecontroller`
- **Deployment strategy**: Recreate (not RollingUpdate) to avoid NATS subscription conflicts

## Responsibilities

### Cache purge (primary)
Invalidates cached content across all edge caching layers. Purges are sent in a specific order that matters:

1. **Proxy** first — `PURGE /` with `X-Purge-Domain`, `X-Purge-Generation`, `X-Purge-ID` headers
2. **ATS** second — same purge request format
3. **Stargate** last — `POST /purge_metadata` with JSON body

**Why this order matters**: Purging Proxy before ATS prevents a race condition where a request could be served from Proxy's stale cache after ATS has been purged. Purging ATS before Stargate prevents stale metadata from being written to new Stargate pods during deployments.

### Certificate purge
Removes TLS certificates from the edge cache:
- `DELETE /certificates/{domain}` to Stargate with authorization headers

### URL-specific deletion
Removes individual URLs from the ATS cache (as opposed to domain-wide purges):
- `GET /delete_url?url={encoded_url}` to ATS (intercepted by the cache inspector plugin)

### Cache priming
Pre-warms cache by fetching URLs through ATS:
- `GET` request via ATS with `Accept-Encoding: gzip,deflate,sdch`

### Ban list management
Updates IP ban lists in Proxy:
- `BAN` request to Proxy with `X-Ban-Key` header

## Message consumers

### NATS
- TLS-authenticated connection to NATS cluster (3 servers)
- Subscribes to `cache_purges.{cdn_domain}` subjects
- Supports durable subscriptions via NATS Streaming for message resumption
- Static IP-to-hostname mappings for TLS handshake over private IPs

### Kafka
- SASL/SCRAM authenticated, TLS encrypted
- Consumer group per node (one consumer per CDN node)
- Topics: `prod.cache-purges.global`, `prod.cache-purges.regular`, `stag.cache-purges.regular`
- Messages use structured schemas (`runtime-schemas`) converted to legacy format for backward compatibility
- Offset committed after successful dispatch

## Message flow

```
Origin services (deploy, purge API, etc.)
    ↓ publish
NATS / Kafka
    ↓ consume
Cachecontroller
    ↓ HTTP requests (in order)
Proxy → ATS → Stargate
```

## Upstream / Downstream

- **Receives from**: NATS and Kafka messages (published by origin services)
- **Sends to**: Proxy, ATS, Stargate (all local to the CDN node, via HTTP)

## Key packages

- `commands/` — Command handlers: `purge.go`, `purge_certificate.go`, `content_delete.go`, `prime.go`, `banlist.go`. `CommandDispatcher` routes messages to handlers.
- `messaging/nats/` — NATS connection and consumer logic
- `messaging/kafka/` — Kafka consumer with SASL auth and schema conversion
- `conf/` — Configuration loading (secrets, host info, environment detection)
- `cmd/` — Cobra CLI entrypoint, health check server on `:8080`

## Configuration

- `NatsConfig` — NATS servers, TLS certs, command subject
- `KafkaConfig` — Brokers, SASL credentials, topics, consumer group
- `ProxyHost` — Local Proxy address for purge requests
- `ATSHost` — Local ATS address for purge requests
- `Stargate` / `StargateHeadless` — Stargate address(es) for purge requests

## Build and test

- **Build**: `make build` → `dist/cachecontroller` (CGO_ENABLED=0)
- **Test**: `make test` (unit tests), `make docker-test` (with Kafka)
- **CI**: CircleCI with Go + Kafka + Zookeeper
- **Docker**: Ubuntu 20 base, runs as `netlify` user with dumb-init

## Dependencies

Key: nats.go + stan.go (NATS/Streaming), kafka-go (Kafka), cenkalti/backoff (retry), Cobra (CLI), logrus (logging), go-observability (Datadog metriks), go-config, go-http, runtime-schemas

## Key considerations

- **Stateless**: No database, no persistent state. Pure message consumer and HTTP dispatcher.
- **Order matters**: Proxy → ATS → Stargate purge order prevents stale data race conditions. Do not change this order.
- **Recreate deployment**: Uses Recreate strategy (not RollingUpdate) to avoid two instances having conflicting NATS subscriptions on the same node. 120-second grace period for in-flight purges.
- **Retry with backoff**: Exponential backoff on transient failures (connection refused, timeout). Stops after 3 HTTP 5xx errors or 3+ consecutive connection refusals.
- **Multi-pod Stargate**: During Stargate rollouts, Cachecontroller resolves all Stargate pod IPs and attempts to purge all of them, tolerating individual failures.
- This is a ~2,800 LOC service — small and focused compared to other edge services.
