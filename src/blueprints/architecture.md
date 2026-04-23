# Netlify Architecture Overview

Last updated: 2026-03

## The Request Chain

Netlify's runtime infrastructure processes requests through a series of services arranged in a pipeline called the **request chain**. Each service in the chain handles a specific responsibility before either fulfilling the request or passing it downstream.

Reference: https://docs.netlify.com/start/core-concepts/request-chain/

```
Client Request
      │
      ▼
┌──────────────┐
│  Stargate     │  TLS termination, edge function execution (Deno/Nimble),
│  (Go)         │  WAF, rate limiting, GeoIP, core routing
└──────┬───────┘
       │  (bypasses ATS/Proxy if edge function handles request)
       ▼
┌──────────────┐
│  ATS          │  Edge caching, cache generation/invalidation,
│  (C++ plugin) │  alternate selection (A/B), URL normalization
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Proxy        │  Rewrites, redirects, serverless function invocation
│  (Go)         │  (Lambda), durable cache, image transform routing
└──────┬───────┘
       │
       ▼  (cache miss / origin request)
┌─────────────────┐
│  netlify-server  │  Blob serving, file/function uploads, request
│  (Go)            │  signature validation, API proxying, MongoDB
└───┬────┬────┬───┘
    │    │    │
    ▼    ▼    ▼
┌────────┐ ┌────────────┐ ┌─────────┐
│ Fn     │ │ Bitballoon │ │ Imageer │
│ Origin │ │ (Ruby)     │ │ (Go)    │
│ (Go)   │ └────────────┘ └─────────┘
└────────┘

Side-channel (not in request path):
┌───────────────────┐
│  Cachecontroller   │  Consumes NATS/Kafka purge messages,
│  (Go, edge)        │  orchestrates cache invalidation
└────────────────────┘
  Purges: Proxy → ATS → Stargate (order matters)
```

## Service tiers

### Edge services

Stargate, ATS, Proxy, and Cachecontroller are **edge services**. They are deployed on CDN nodes distributed across many regions globally. For the request chain services (Stargate, ATS, Proxy), every request flows through them in order. Cachecontroller runs on each edge node but is not in the request path — it consumes messages and coordinates cache invalidation.

Key implication: changes to edge services affect all requests across all regions. These services must be highly performant and resilient, as they sit in the critical path for every single request.

### Origin services

netlify-server, Functions Origin, Bitballoon, and Imageer are **origin services**. They run in a single region with horizontal scaling. Requests only reach origin services when the edge cannot fulfill them (e.g., cache misses, API calls, function invocations, image transforms).

Key implication: origin services have more flexibility for complex logic and database access, but must handle the latency implications of being centralized.

## Function execution: two distinct paths

Netlify has two types of functions with different execution paths:

- **Edge Functions** — Typically executed by **Stargate** at the edge, before the request reaches ATS or Proxy. Stargate reverse-proxies to an external runtime (Deno Deploy or Nimble/Unikraft). If the edge function handles the request, the response goes directly back to the client. Edge functions can also issue **passthrough requests** (HTTP calls that re-enter Stargate with a signal to skip edge function invocation, following the normal chain). Edge functions can also return a **bypass signal**, letting the original request continue down the chain. **Exception — post-cache edge functions**: When an edge function enables cache mode, it becomes a "post-cache edge function" that is invoked by **Proxy** instead of Stargate. Stargate still handles route matching and computes the invocation configuration, but passes that information as request headers. Proxy reads those headers and performs the actual invocation after the ATS cache layer, allowing the edge function response to benefit from caching.

- **Serverless Functions** — Invoked by **Proxy**, which routes matching requests to AWS Lambda (or the Play platform, currently in development). The function invocation goes through origin infrastructure. Functions Origin handles the upload/deployment side, not invocation.

## Data stores

- **MongoDB** — Primary data store for Netlify's legacy and core services. Accessed by both netlify-server and Bitballoon. Contains site configurations, deploy metadata, user/team data, and more.
- **MySQL** — Used by newer services (e.g., Functions Origin). Netlify has been adopting MySQL/Postgres for new services due to better scaling characteristics, while MongoDB remains for existing services where migration cost is prohibitive.
- **Edge Cache (ATS-powered)** — Node-specific cache. A cached item on one CDN node is NOT available on other nodes. Uses generation IDs stored in RocksDB for invalidation.
- **Durable Cache (Proxy-powered)** — Region-wide cache backed by DynamoDB and S3. Once an item is cached on any node in a region, all nodes in that region can serve it. Reference: https://docs.netlify.com/build/caching/caching-overview/#durable-directive

## Cache invalidation

Cache invalidation is coordinated by **Cachecontroller**, an edge service that consumes purge messages from NATS and Kafka (published by origin services during deploys and other operations). When a purge is needed, Cachecontroller sends HTTP requests to each cache layer in a specific order: **Proxy → ATS → Stargate**. This order prevents race conditions where a request could be served from a stale layer after a fresher layer has been purged.

## How services communicate

Within the request chain, each service communicates with the next via HTTP reverse proxying. The request flows sequentially through the chain — there is no service mesh or async messaging between these services during request handling.

- **Stargate → ATS**: HTTP reverse proxy after TLS termination, edge function check, and filtering
- **ATS → Proxy**: HTTP reverse proxy after cache lookup and edge-level processing
- **Proxy → netlify-server**: HTTP reverse proxy on cache miss or origin-bound requests
- **Proxy → Imageer**: HTTP request for image transformation (Image CDN requests)
- **netlify-server → Bitballoon**: HTTP reverse proxy for requests that netlify-server doesn't handle
- **netlify-server → Functions Origin**: HTTP reverse proxy specifically for function upload requests

## Language and runtime

All edge and origin services are written in **Go**, with the exception of:
- **Bitballoon** — Ruby on Rails monolith
- **ATS plugin** — C++20 (ATS itself is C/C++; the Netlify-specific plugin is C++20 with Go used only for integration tests and runtime config generation)
