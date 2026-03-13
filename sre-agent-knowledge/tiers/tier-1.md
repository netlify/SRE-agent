# Tier 1 — Reliability Requirements

Tier 1 services are on the customer-critical path. An outage directly and
immediately impacts paying customers and Netlify's core product experience.

## Examples
- `proxy` — handles all inbound customer traffic
- `netlify-server` — core API for site and deploy management

## SLO targets
- Availability: 99.9% (30-day rolling)
- Latency p99: 500ms

## Error budget
- 43.2 minutes per 30-day window

## Required monitors
- SLO burn rate (fast: 14x over 1h/5m, slow: 6x over 6h/30m)
- Availability drop below target
- Latency p99 breach
- Error rate spike (>5% for >2 minutes)
- Dependency unavailability

## On-call
- 24/7 paging to owning team on-call
- SRE escalation path must be defined in the runbook

## Runbook requirement
A complete runbook is required before a Tier 1 service goes to production.
The runbook must include: failure modes, rollback procedure, support commands,
and escalation path.

## Deploy requirements
- Feature flags required for any user-facing change
- Canary deploys strongly recommended
- Rollback must be achievable in under 5 minutes
