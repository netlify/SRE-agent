# Tier 2 — Reliability Requirements

Tier 2 services are important to the product but not on the immediate
customer-critical path. Degradation is noticeable and affects developer
experience, but a short outage does not immediately break core functionality.

## Examples
- `envelope` — environment variable storage and retrieval
- `functions-origin` — Netlify Functions execution layer
- `imageer` — image transformation service

## SLO targets
- Availability: 99.5% (30-day rolling)
- Latency p99: 1000ms

## Error budget
- 216 minutes per 30-day window

## Required monitors
- SLO burn rate (fast: 14x over 1h/5m, slow: 6x over 6h/30m)
- Availability drop below target
- Latency p99 breach
- Error rate spike (>5% for >2 minutes)
- Dependency unavailability for critical upstream services

## On-call
- Immediate page during business hours
- After hours: page only if burn rate exceeds 2x
- Escalation path to SRE must be defined in runbook

## Runbook requirement
A runbook is required before go-live. Must include failure modes and rollback
procedure at minimum. Support commands and escalation path strongly recommended.

## Deploy requirements
- Feature flags recommended for significant user-facing changes
- Rollback must be achievable in under 15 minutes
