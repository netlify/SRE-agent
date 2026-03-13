# Alerting Standards

## Overview

Alerts exist to notify the right person when a service needs human attention.
They should be actionable — every alert should have a corresponding runbook
entry or a clear next step.

---

## Required monitors by tier

### Tier 1 and Tier 2

- **SLO burn rate alert** — fires when the error budget is burning faster than
  sustainable. Use a multi-window burn rate: 1h and 5m windows at 14x burn rate
  for a fast alert, 6h and 30m windows at 6x burn rate for a slow alert.
- **Availability drop** — fires when availability falls below the SLO target
  for the current window.
- **Latency p99 breach** — fires when p99 latency exceeds the SLO threshold
  for more than 5 consecutive minutes.
- **Pod/Lambda error rate spike** — fires when the 5xx rate exceeds 5% for
  more than 2 minutes.
- **Dependency unavailability** — fires when a critical upstream dependency
  is unreachable (circuit breaker open, connection timeout).

### Tier 3

- SLO burn rate alert
- Availability drop
- Pod/Lambda error rate spike

### Tier 4

- Error rate spike (threshold relaxed — >20% for >10 minutes)

---

## Naming convention

```
[TIER][N] [team-slug] | [service-name] — [what is wrong]
```

Examples:
- `[TIER1] platform | envelope — availability below SLO`
- `[TIER2] builds | functions-origin — p99 latency breach`
- `[TIER3] deploy | imageer — error rate spike`

---

## Runbook links

Every monitor must include a link to the relevant runbook section in its
description field. If no runbook exists, creating one is a prerequisite
for the alert going live.

---

## On-call routing

- Tier 1 alerts page the owning team on-call immediately, 24/7
- Tier 2 alerts page the owning team on-call immediately during business hours;
  after hours only if the burn rate exceeds 2x
- Tier 3 and Tier 4 alerts create a ticket; no immediate page
