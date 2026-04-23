# Go Service Conventions

Last updated: 2026-03-02

## Shared libraries: use them, don't reimplement

Netlify maintains several shared Go libraries that provide common functionality across services. **AI agents must prefer these libraries over reimplementing equivalent functionality from scratch.** When existing functionality is close but not quite right, agents should first consider whether the shared library can be amended or expanded before deciding to reimplement.

### go-service-boilerplate

**Repo**: `go-service-boilerplate`
**Import**: N/A — this is a template repo, not an importable module
**Purpose**: Blueprint for creating new Go services

When creating a new Go service, always start from this boilerplate. It establishes the canonical service structure:

```
main.go                 # Entry point → cmd.RootCmd().Execute()
cmd/root.go             # Cobra CLI setup, config loading, server start
api/
├── api.go              # API struct implementing Start/Stop/Healthy/Info
├── routes.go           # HTTP route handlers
└── api_test.go         # Tests
config/
├── config.go           # Service-specific config struct with Validate()
├── generate.go         # Config generation from YAML files
└── external.go         # External service init (Datadog, DevCycle, Bugsnag)
_infra/config/dev/      # Local dev config (values.yaml, secrets.yaml)
Makefile                # build, test, deps, lint targets
```

**Usage**: Clone the repo, run `./scripts/bootstrap.sh <service-name>` to replace placeholders.

**Conventions it enforces**:
- Cobra CLI with `--secrets` and `--values` flags for config YAML files
- `config dump` subcommand for debugging configuration
- API lifecycle interface: `Start(router)`, `Stop()`, `Healthy()`, `Info()`
- Health check at `/health`
- Graceful shutdown on SIGINT/SIGTERM
- golangci-lint with strict warnings (see `.golangci.yml` for enabled linters)
- CGO_ENABLED=0 builds to `dist/nf-service`

---

### go-http

**Repo**: `go-http`
**Import**: `github.com/netlify/go-http`
**Purpose**: HTTP server setup, routing, TLS, middleware, error handling

Use this for all HTTP server setup. Do not set up raw `net/http` servers or bring in other routing libraries.

**Packages**:

| Package | Import | Use when you need to... |
|---------|--------|------------------------|
| `server` | `go-http/server` | Create and manage an HTTP server with graceful shutdown, health checks, TLS |
| `router` | `go-http/router` | Define API routes with error-returning handlers (`APIHandler`), structured error responses (`HTTPError`), middleware |
| `ntls` | `go-http/ntls` | Configure TLS (from files or PEM strings, custom CA pools, TLS 1.2+ minimum) |
| `nhttp` | `go-http/nhttp` | Make outbound HTTP calls safely (SSRF protection via private IP blocking), track response metrics |
| `headers` | `go-http/headers` | Parse RFC 9211 `Cache-Status` headers |
| `url` | `go-http/url` | URL path normalization, Bitballoon-compatible URL encoding |
| `proxypool` | `go-http/proxypool` | Memory pooling for `httputil.ReverseProxy` buffers |

**Key patterns**:

- **Server creation**: Use `server.New()` or `server.NewOpts()`. Implement the `APIDefinition` interface (Start/Stop/Info) and optionally `HealthChecker`.
- **Route handlers**: Use `router.APIHandler` (returns `error`) instead of raw `http.HandlerFunc`. Errors are automatically formatted as JSON responses with logging and Bugsnag notification.
- **Error responses**: Use `router.BadRequestError()`, `router.NotFoundError()`, `router.InternalServerError()`, etc. Attach context with `.WithInternalError()`, `.WithInternalMessage()`, `.WithField()`.
- **Middleware**: Use built-in middleware: `CheckAuth` (bearer token), `JWTAuth` (generic JWT), `Recoverer` (panic recovery), `VersionHeader`, `HealthCheck`, `TrackAllRequests` (APM).
- **SSRF protection**: Use `nhttp.SafeTransport()` or `nhttp.SafeDial()` for any HTTP client making requests to user-provided URLs. These block connections to private IP ranges.
- **JSON responses**: Use `router.SendJSON()` instead of manual marshaling.

---

### go-auth

**Repo**: `go-auth`
**Import**: `github.com/netlify/go-auth`
**Purpose**: JWT signing, validation, and key rotation

Use this for all JWT operations. Do not use `golang-jwt` directly.

**Package**: `njwt`

| Function / Type | Use when you need to... |
|----------------|------------------------|
| `njwt.NewRotatableJWTFactory(primary, secondary...)` | Create a reusable JWT factory with key rotation support (primary + secondary secrets for zero-downtime rotation) |
| `factory.Generate(claims)` | Sign claims and produce a JWT token string |
| `factory.Validate(token, claims, opts...)` | Validate a JWT token, trying all configured secrets |
| `njwt.Sign(secret, claims)` | One-off token signing with a single secret |
| `njwt.Extract(secret, token, claims)` | One-off token validation with a single secret |
| `njwt.BaseClaims(ttl, opts...)` | Build standard `jwt.RegisteredClaims` with TTL, issuer, subject, issuedAt |

**Key patterns**:
- All tokens use **HMAC-SHA256** (symmetric signing)
- Use `RotatableJWTFactory` for service-to-service auth — it supports key rotation with zero downtime
- Build custom claims structs that embed `jwt.RegisteredClaims` for service-specific data
- Per-service-pair secrets managed via YAML configuration

---

### go-observability

**Repo**: `go-observability`
**Import**: `github.com/netlify/go-observability`
**Purpose**: Metrics (Datadog StatsD), distributed tracing (Datadog APM), profiling

Use this for all metrics, tracing, and profiling. Do not use Datadog SDKs directly.

**Packages**:

#### `metriks` — Metrics

| Function | Use when you need to... |
|----------|------------------------|
| `metriks.Init(serviceName, config)` | Initialize metrics (once at startup) |
| `metriks.Inc(name, val, labels...)` | Increment a counter |
| `metriks.MeasureSince(name, start, labels...)` | Measure duration (use with `defer`) |
| `metriks.Sample(name, val, labels...)` | Record a histogram sample |
| `metriks.Gauge(name, val, labels...)` | Record a point-in-time value |
| `metriks.Distribution(name, val, labels...)` | Record a distribution metric |
| `metriks.NewPersistentGauge(name, tags...)` | Create a long-lived gauge that reports every 5s (e.g., connection counts) |
| `metriks.NewScheduledGauge(name, cb, tags...)` | Create a gauge that calls a callback every 5s |
| `metriks.L(name, value)` | Create a label (shorthand) |
| `metriks.NewDBStats(db, name, labels)` | Auto-report SQL connection pool metrics |

**Key patterns**:
- Label names and values are sanitized (`:`, ` `, `-` replaced with `_`) by default
- Use `metriks.L("key", "value")` for labels, not raw strings
- `MeasureSince` is idiomatic: `defer metriks.MeasureSince("handler.time", time.Now())`
- Runtime metrics (goroutines, heap, GC) are auto-exported unless `DisableRuntimeMetrics: true`
- Global client — initialize once, use anywhere

#### `tracing` — Distributed tracing

| Function | Use when you need to... |
|----------|------------------------|
| `tracing.Configure(config, log, serviceName)` | Initialize tracing (once at startup) |
| `tracing.NewTracer(w, r, log, service, resource)` | Create request tracer with span (returns wrapped writer, request, tracer) |
| `tracing.GetRequestID(r)` | Get request ID from context or headers (generates UUID if missing) |
| `tracing.RequestLogger(r, log)` | Get logger with request ID field, respects `nf-debug-logging` header |
| `tracing.GetLogger(r)` / `tracing.GetFromContext(ctx)` | Retrieve logger/tracer from request context |
| `tracing.SetLogField(r, key, value)` | Add field to all subsequent logs for this request |
| `tracing.SetFinalField(r, key, value)` | Add field only to the completion log |

**Key patterns**:
- Request ID flows via `nf-request-id` header (or legacy `bb-client-request-uuid`)
- `RequestTracer` wraps the response writer to track status codes and bytes written
- Use `Start()` and `Finish()` (or `defer rt.Finish()`) to log request lifecycle
- Spans are automatically tagged with HTTP method, URL, status code for Datadog APM
- `SetFinalField` is for data only known at request completion (e.g., cache hit status)

#### `profiling` — CPU/heap profiling

| Function | Use when you need to... |
|----------|------------------------|
| `profiling.Start(ctx, log, enabledFn, opts...)` | Start background profiler with dynamic enable/disable |

**Key patterns**:
- `enabledFn` is called periodically to check if profiling should be active (e.g., via feature flag)
- Profiles: CPU and Heap, sent to Datadog
- Default period: 5 minutes

---

### go-utils

**Repo**: `go-utils`
**Import**: `github.com/netlify/go-utils`
**Purpose**: Shared utilities for common operations

**Packages**:

| Package | Import | Use when you need to... |
|---------|--------|------------------------|
| `nutil` | `go-utils/nutil` | Serializable config types (`Duration`, `URL`, `Headers` for YAML/JSON), `AtomicBool`, `LimitedReader`, `ScheduledExecutor` (periodic callbacks), `RunExperiment` (A/B test implementations) |
| `bugsnag` | `go-utils/bugsnag` | Initialize Bugsnag error tracking (`Configure(apiKey, opts...)`) |
| `pprof` | `go-utils/pprof` | Add pprof debug endpoints (`/debug/pprof/*`) to an HTTP server |
| `regularexpression` | `go-utils/regularexpression` | Dual-engine regex (native Go + PCRE fallback) with timeout protection (100ms for PCRE) |
| `programmablecache` | `go-utils/programmablecache` | Programmable Cache API constants, request detection, header deserialization |
| `skewprotection` | `go-utils/skewprotection` | Deploy version pinning: extract/validate signed deploy ID tokens from cookies/headers/query params |
| `ntoml` | `go-utils/ntoml` | Parse `netlify.toml` configuration files (build config, redirects, plugins, contexts) |

**Key patterns**:
- Use `nutil.Duration` in config structs instead of `time.Duration` for YAML/JSON serialization
- Use `nutil.ScheduledExecutor` for periodic tasks instead of rolling your own goroutine + ticker
- Use `nutil.RunExperiment` when comparing a new implementation against an existing one — it runs both, returns the control result, and streams candidate results for comparison
- Use `regularexpression.RegularExpression` when you need PCRE compatibility with catastrophic backtracking protection

---

## General conventions

### Service structure
All Go services follow the structure established by `go-service-boilerplate`. Key patterns:
- **Entry point**: `main.go` → `cmd.RootCmd().Execute()` (Cobra)
- **Configuration**: YAML files (values + secrets) loaded via `github.com/netlify/go-config`
- **HTTP server**: `go-http/server` with `APIDefinition` interface
- **Logging**: logrus with structured fields
- **Metrics**: `go-observability/metriks`
- **Error tracking**: Bugsnag
- **Feature flags**: DevCycle via `github.com/netlify/go-flags/v2`

### Error handling
- Use `go-http/router.HTTPError` for API error responses
- Always attach the root cause with `.WithInternalError(err)` for logging
- Never expose internal error messages to clients — use `.WithInternalMessage()` for logs only
- Use `errors.Is()` and `errors.As()` (Go 1.13+ patterns) — the golangci-lint config enforces `errorlint`

### Testing
- Use `github.com/stretchr/testify` (assert/require) for assertions
- Use `github.com/netlify/go-test-utils` for common test utilities
- Colocate tests with source (`*_test.go` files next to implementation)
- Use `testutil/` packages for shared test helpers within a service
- Use table-driven tests for multiple scenarios
- Use `t.Run()` subtests for organized output
- Use `t.Cleanup()` instead of `defer` for test teardown
- Use `t.Helper()` in assertion helpers so failures point to the call site
- Use `t.Context()` instead of `context.Background()` when a context is needed in tests
- Prefer `require` over `assert` when a failure makes the rest of the test meaningless; use `assert` when it's useful to see multiple failures

### Modern Go
Target Go 1.24+. Prefer standard library features over third-party equivalents where they exist.

- Use `any` instead of `interface{}`
- Use the `slices` package (`slices.Contains`, `slices.Sort`, `slices.Compact`, etc.) instead of hand-rolled slice operations
- Use the `maps` package (`maps.Keys`, `maps.Values`, `maps.Clone`, etc.) instead of hand-rolled map operations
- Use `min`/`max` builtins instead of conditional expressions
- Use range-over-integers: `for i := range n` instead of `for i := 0; i < n; i++`
- Use `errors.Join` to combine multiple errors
- Use range-over-functions (Go 1.23+) for custom iterators instead of callback-style APIs
- Declare tool dependencies via `go tool` directives in `go.mod` (Go 1.24+) instead of `tools.go` workarounds
- Use `sync/atomic` types (`atomic.Bool`, `atomic.Int64`, etc.) instead of the `atomic` package functions

### Code style
- `context.Context` is the first parameter for any function that may be cancelled or have a deadline
- Use `defer` for cleanup (closing resources, releasing locks, etc.)
- Wrap errors with context: `fmt.Errorf("doing X: %w", err)` — never discard errors with `_`
- Return errors; don't panic except for truly unrecoverable situations
- Use generics when they genuinely simplify code
- Avoid defining interfaces speculatively — define them at the point of use
- Use named return values only when they meaningfully improve clarity
- Single-letter variable names only in tight scopes (loop indices); use descriptive names elsewhere
- Keep functions small and focused

### Comments
- Don't comment what the code does — write code that's readable instead
- Do comment *why* when a non-obvious decision was made
- Don't add package-level doc comments unless the package needs orientation
- Don't add docstrings to exported functions unless the behavior isn't clear from the signature

### Logging
- Use logrus with structured fields (`WithField`, `WithFields`)
- Always include `request_id` in request-scoped logs (handled by `go-observability/tracing`)
- Use `tracing.SetLogField()` to add context during request processing
- Use `tracing.SetFinalField()` for data only available at request completion

### Configuration
- Split into values (environment-varying) and secrets (sensitive)
- Use `github.com/netlify/go-config` for loading and merging YAML files
- Implement `Validate()` on config structs
- Support `config dump` subcommand for debugging
