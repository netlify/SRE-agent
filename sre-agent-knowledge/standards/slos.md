# SLO Standards

## Overview

SLOs at Netlify are defined per service capability, not per service. A service
with three distinct user-facing capabilities should have three sets of SLOs.

All SLOs use a **30-day rolling window**. This is the standard — deviations
require explicit justification documented in the SLO config.

---

## SLI types

**Availability** — the proportion of requests that succeed. Success is defined
as a non-5xx HTTP response for request-response services, or successful task
completion for async services and pipelines.

**Latency** — the proportion of requests that complete within a defined
threshold. Always measured at p99 unless the service has specific reasons to
use a different percentile.

**Error rate** — used in addition to availability when the service has
meaningful error classifications beyond HTTP status codes (e.g. partial
failures, degraded responses).

---

## Tier-based targets

These are starting points. The developer and SRE should agree on the final
threshold based on current baseline, upstream SLA commitments, and product
agreements.

| Tier | Availability | Latency (p99) | Notes |
|---|---|---|---|
| Tier 1 | 99.9% | 500ms | Customer-critical path. On-call coverage required. |
| Tier 2 | 99.5% | 1000ms | Important but not on the critical path. |
| Tier 3 | 99.0% | 2000ms | Internal or background services. |
| Tier 4 | 95.0% | 5000ms | Best-effort. Batch jobs, non-critical features. |

---

## Error budget

The error budget is derived automatically from the SLO target and the window.

For a Tier 2 service with a 99.5% availability target over 30 days:
- Total minutes in window: 43,200
- Error budget: 0.5% x 43,200 = 216 minutes of allowable downtime

When the error budget is below 50%, the team should slow down risky deploys
and prioritise reliability work.

---

## Output format

SLO configs are produced as Datadog YAML. See `artifacts/slo-template.yaml`
for the full template.

Required tags on every SLO:
- `service:[service-name]`
- `tier:[tier-number]`
- `team:[owning-team-slug]`
