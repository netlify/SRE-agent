# Workflow: SLO Workshop

## Purpose
Guide a developer through defining SLOs for a service — identifying
capabilities, defining SLIs, setting thresholds, and producing a
copy-paste-ready Datadog YAML config.

---

## Phase 1: Capability identification

Ask the developer to describe what the service does for its users. Frame
it around user-visible outcomes, not internal implementation.

Prompt:
> "Let's start by identifying what your service does from a user's perspective.
> What are the key things users rely on this service for? For example, for a
> payment service you might say: process a payment, retrieve payment history,
> issue a refund."

Extract 2-5 distinct capabilities. Each capability will map to one or more SLIs.

---

## Phase 2: SLI definition

For each capability, define the SLIs. For most K8s services and Lambdas,
start with availability and latency. Add error rate if the service has
meaningful error classifications beyond HTTP 5xx.

Standard SLI types:

**Availability** — proportion of requests that succeed (non-5xx)
```
numerator:   sum of successful requests
denominator: sum of all requests
```

**Latency** — proportion of requests that complete within a threshold
```
numerator:   sum of requests completing within Xms
denominator: sum of all requests
```

Ask the developer:
> "For [capability], do you have Datadog metrics tracking request count and
> error count? What metric names are they using? If you're not sure, I can
> suggest standard names based on your service type."

---

## Phase 3: Threshold setting

Use tier-based starting points. These are defaults, not mandates.

| Tier | Availability | Latency (p99) | Window |
|---|---|---|---|
| Tier 1 | 99.9% | 500ms | 30-day rolling |
| Tier 2 | 99.5% | 1000ms | 30-day rolling |
| Tier 3 | 99.0% | 2000ms | 30-day rolling |
| Tier 4 | 95.0% | 5000ms | 30-day rolling |

Before accepting the default, ask:
> "Your service is Tier [N], which suggests a [X]% availability target.
> Before we lock that in — do you know your current baseline? And are there
> any upstream SLA commitments or product agreements that should influence
> this threshold?"

Adjust if the developer has good reason. Document the rationale in the output.

---

## Phase 4: Output

Produce a Datadog SLO YAML config for each SLI. Use the template below.

```yaml
slo:
  name: "[service] - [capability] [SLI type]"
  description: "[One sentence describing what this SLO measures]"
  type: metric
  query:
    numerator: "[Datadog metric query for successes]"
    denominator: "[Datadog metric query for total]"
  thresholds:
    - target: [threshold as decimal, e.g. 99.5]
      timeframe: "30d"
  tags:
    - "service:[service-name]"
    - "tier:[tier]"
    - "team:[owning-team]"
```

After generating the YAML, post a summary:
> "Here's what we defined:
> - [N] SLOs across [N] capabilities
> - Tier [N] thresholds applied
> - [Any deviations from defaults and why]
>
> Next steps: review the metric queries against your actual Datadog metrics,
> then import via the Datadog API or terraform-datadog."

Attach the full YAML as a file to the Slack thread.
