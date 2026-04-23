# ATS (Apache Traffic Server)

Last updated: 2026-03

## Overview

Apache Traffic Server powers the Netlify Edge Cache. Netlify runs ATS with a custom C++ plugin that handles caching, cache invalidation via generation IDs, A/B test alternate selection, JWT authentication, URL normalization, and stale-while-revalidate logic.

- **Language**: ATS core is C/C++; the Netlify custom plugin is **C++20**. Go is used only for integration tests and a runtime config generator.
- **Tier**: Edge service (deployed on all CDN nodes globally)
- **Position in request chain**: 2nd (receives requests from Stargate)
- **Repository**: `netlify-ats-plugin`

## Responsibilities

### Edge caching
- **Node-specific HTTP cache**: Items cached on one CDN node are NOT available on other nodes (distinct from the Durable Cache in Proxy, which is region-wide)
- **Cache generation/invalidation**: Uses generation IDs stored in **RocksDB** to track cache freshness. When a deploy happens, the generation ID for a domain is incremented, causing all cached content for that domain to become stale
- **Stale-while-revalidate**: Serves stale cached content immediately while triggering a background revalidation request to origin, giving users fast responses during cache refreshes

### Alternate selection (A/B testing)
- Supports caching multiple **alternates** (variants) of the same URL for split testing
- Client's `nf_ab` cookie value (a float like `0.34565`) is matched against variation ranges specified in `X-BB-Variation` headers (e.g., `branch=0.0-0.5`)
- ATS selects the cached alternate matching the client's variation assignment

### URL normalization
- **HTML requests**: Query parameters are stripped for cache key computation
- **Asset requests**: Only whitelisted query parameters (`nf_resize`, `w`, `h`) are preserved
- **Crawler requests**: Prefixed with `cr:` for separate cache entries
- **Vary header normalization**: Orders and normalizes header values for consistent cache keys

### Other responsibilities
- **JWT authentication**: Supports HS256/384/512 and RS256/384/512 for cache generation signing and A/B token validation
- **Protocol-based cache keys**: Different cache entries for HTTP vs HTTPS (via `X-Nf-Connection-Proto` header from Stargate)
- **Cache inspector API**: HTTP API (`/cache_inspect`) to look up and remove individual cache entries, restricted to VPC IP ranges

## Cache invalidation mechanism

1. Origin includes `X-BB-Cache: <domain-id>` header in responses
2. Plugin stores mapping `domain-id → gen-id` (timestamp) in RocksDB
3. Subsequent responses include `X-BB-Gen: <gen-id>` header
4. On purge (triggered by Cachecontroller), the generation ID is incremented in RocksDB
5. Next client request with the old `X-BB-Gen` will result in a cache miss, forcing an origin fetch
6. 40-second grace period after deploy to handle race conditions

## Key headers

| Header | Direction | Purpose |
|--------|-----------|---------|
| `X-BB-Cache` | Origin → ATS | Cache domain identifier |
| `X-BB-Gen` | ATS ↔ Client | Generation ID for cache validity |
| `X-BB-Deploy-Id` | Request | Deployment identifier |
| `X-BB-Site-Id` | Request | Site identifier |
| `X-BB-Variation` | Origin → ATS | A/B test variant specification |
| `X-BB-AB` | Request | A/B test assignment (cookie-based) |
| `X-Nf-Vary` | Origin → ATS | Netlify vary rules for cache key |
| `X-Nf-Cache-Control` | Origin → ATS | Custom cache control directive |
| `X-Nf-Connection-Proto` | Stargate → ATS | Protocol for cache key differentiation |
| `X-Nf-Cache-Result` | ATS → Client | Cache status (hit-fresh, hit-stale, miss, swr) |

## Upstream / Downstream

- **Receives from**: Stargate
- **Forwards to**: Proxy (on cache miss or for non-cacheable requests)

## Project structure

```
src/                    # C++ plugin source (19 .cc, 20 .h files)
├── netlify-plugin.cc   # Plugin entry point (TSPluginInit, global hooks)
├── transaction-handler.cc  # Per-transaction logic (~1500 lines)
├── cache-gen.cc        # Cache generation/invalidation
├── db.cc               # RocksDB wrapper
├── jwt.cc              # JWT verification (HMAC + RSA)
├── alternate-selection.cc  # A/B test variant matching
├── normalizer.cc       # URL normalization
├── variations.cc       # Cache key variation (Murmur3 hashing)
├── request-checker.cc  # Request type detection (HTML, purge, redirect)
├── statsd.cc           # UDP metrics client
└── cache_inspector.cc  # Cache inspection API

config/                 # ATS configuration files
integration_tests/      # Go-based integration test suite
cmd/runtime-config/     # Go utility to generate ATS configs from env vars
```

## Configuration

Plugin configured via JSON file (reloadable without restart, watches file mtime):
- `genid_db` / `hostid_db` — RocksDB database paths
- `host_id` — ATS instance identifier
- `cache_gen_jwt_secret` — Secret for signing generation headers
- `max_cache_tag_size` / `max_cache_tags` — Cache tag limits

## Build and test

- **Build plugin**: `make -C src release` (C++20, links against rocksdb, jsoncpp, re2, libcrypto, libtscppapi)
- **Debug build**: `make -C src debug` (with AddressSanitizer and UBSan)
- **Integration tests**: `docker-compose run --rm --build tests /run-tests.sh` (Go tests against docker-compose ATS environment)
- **Docker**: Multi-stage build producing ATS + plugin image on Ubuntu 24.04

## Dependencies

System libraries: RocksDB, jsoncpp, RE2, OpenSSL/libcrypto, ATS C++ API (libtscppapi)

Go (tests/config only): golang-jwt, logrus, testify, murmur3, yaml.v3

## Key considerations

- The edge cache is **node-specific** — distinct from the Durable Cache (Proxy), which is region-wide
- The custom C++ plugin is where most Netlify-specific logic lives. ATS itself is largely stock configuration.
- JWT auth and alternate selection happen at this layer — auth failures or A/B test misconfigurations surface here
- Cache invalidation is driven by Cachecontroller sending purge requests. The order (Proxy → ATS → Stargate) matters to prevent stale data races.
- Two RocksDB databases persist on each node: one for generation IDs, one for host ID mappings
- The cache inspector API is access-controlled to VPC IP ranges only
