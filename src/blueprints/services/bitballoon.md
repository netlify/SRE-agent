# Bitballoon

Last updated: 2026-03

## Overview

Bitballoon is the original Netlify backend service — a Ruby on Rails API-only monolith that serves as the core platform for managing sites, deployments, accounts, billing, DNS, and integrations. It handles any origin request that netlify-server doesn't handle itself, and exposes the primary Netlify API.

- **Language**: Ruby on Rails 7.0 (API-only, no view rendering)
- **Tier**: Origin service (single region, horizontally scaled)
- **Position in request chain**: Last (receives requests proxied from netlify-server)
- **Repository**: `bitballoon`

## Responsibilities

### API platform
- 80+ public API controllers under `/api/v1/` covering sites, accounts, deploys, domains, DNS, forms, environment variables, edge functions, permissions, billing, and more
- OAuth2 provider via Doorkeeper for third-party integrations
- SAML SSO support via ruby-saml and WorkOS
- Admin API under `/api/hero/` namespace
- Internal service-to-service API under `/api/internal_services/`

### Domain model
- **207 Mongoid models** covering the full Netlify platform domain
- Key models: `Account` (team), `User`, `Organization`, `Site`, `Deploy`, `Build`, `Repo`, `DnsZone`, `Domain`, `SniCertificate`
- State machines (AASM) for deploy lifecycle, build process, certificate ordering
- Authorization engine: `AuthorizedActor` + `AuthorizedResource` with role-based access control

### Background processing
- **Sidekiq Enterprise** with 49 specialized queues (build, deploy, billing, domain, DNS, certificate, notification, cleanup, etc.)
- Heavy async processing for builds, deploys, billing, domain management, certificate handling
- Periodic/scheduled jobs for maintenance tasks

### Integrations
- Git providers: GitHub, GitLab, Bitbucket, Azure DevOps (API clients, webhooks, deploy hooks)
- Billing: Stripe (current), Orb (new usage-based billing), Zuora (legacy)
- AWS: S3, Lambda, DynamoDB, SNS
- DNS management and Let's Encrypt certificate automation
- Kubernetes: Build pod and dev server pod management

## Data layer

- **MongoDB** via **Mongoid ODM** (not ActiveRecord). All data is in MongoDB — there are no SQL migrations.
- Schema changes are made by modifying field definitions in model files directly
- **Memcached** (Dalli gem) for caching with 1-day default expiration, SSL/TLS, ElastiCache auto-discovery support
- **Redis** for Sidekiq job queue and caching/sessions

## Authorization patterns

Every API action checks permissions via a consistent pattern:
```ruby
before_action :load_account, :authorize_account_access!
authorize_action! :create, :site, only: [:create]
authorize_action! :read, :site, only: [:index]
```
- OAuth scopes: `site:read`, `site:create`, `account:read`, `database:access`, etc.
- Role-based capabilities checked via `allowed?(action, resource_slug)`
- Service-to-service permission checks via `/api/v1/permissions` endpoint

## Upstream / Downstream

- **Receives from**: netlify-server (proxied requests)
- **Forwards to**: N/A (end of the request chain)

## Key directories

- `app/models/` — 207 Mongoid document models
- `app/controllers/api/v1/` — 80+ public API controllers
- `app/workers/` — Sidekiq background job classes (organized by domain: site, build, deploy, billing, etc.)
- `app/services/` — Service layer for business logic
- `app/serializers/` — ActiveModel::Serializers for JSON responses
- `lib/netlify/` — 30+ utility modules (auth, payments, metrics, mailer, spam detection, secrets detection)
- `lib/github/`, `lib/dns/`, `lib/aws/`, `lib/kubernetes/`, `lib/orb/` — Integration clients
- `doc/` — Internal documentation (architecture, authorization, deployment, DNS, certificates, audit logs)

## Configuration

- `config/app.yml` — Environment-specific settings loaded via `AppConfig.load_env(Rails.env)`
- `config/mongoid.yml` — MongoDB connection configuration
- `config/sidekiq.yml` — 49 job queues with priorities
- `config/initializers/` — 20+ initializer files (Datadog, DevCycle, Doorkeeper, etc.)
- Encrypted secrets via sops: `_infra/config/{env}/secrets.enc.yaml`

## Build and test

- **Server**: `make serve` (port 9292)
- **Tests**: `make test` (Minitest in Docker), specific file: `make test/unit/models/site_test.rb`
- **Console**: `make console` (Rails console)
- **Sidekiq**: `make sidekiq`
- **Lint**: `make danger-local` (Rubocop)
- **Docker compose**: API, MongoDB, Memcached, Redis, S3 (local)

### Testing details
- **Framework**: Minitest (not RSpec)
- **Factories**: FactoryBot with 22+ factory files
- **Mocking**: Mocha for stubbing/mocking
- **HTTP**: WebMock for HTTP stubbing, VCR for recording HTTP interactions
- **Time**: Timecop for time-dependent tests
- Test helpers in `test/helpers/` (accounts, sites, functional)

## Dependencies

Key gems: Rails 7.0.8, Mongoid 7.5.2, Sidekiq Enterprise, Doorkeeper 5.7 (OAuth2), ruby-saml 1.18, Stripe 18, aws-sdk (S3, Lambda, DynamoDB, SNS), octokit 4.25 (GitHub), google-cloud-storage, aasm 5.5 (state machines), lograge (structured logging), rack-attack (rate limiting), anycable-rails (WebSocket)

## Key considerations

- Bitballoon and netlify-server **both access MongoDB** and can read/write overlapping data. Be aware of data consistency concerns.
- The migration pattern is: functionality gradually moves FROM Bitballoon TO netlify-server. Check with the team before making large changes to handlers that may be mid-migration.
- This is a Rails monolith with years of history. Patterns may vary across different parts of the codebase.
- Despite being the oldest service, Bitballoon is actively maintained and handles critical functionality. It is not deprecated.
- Uses Mongoid ODM, NOT ActiveRecord. Do not assume SQL/migration patterns apply.
- The existing `AGENTS.md` (symlinked as `CLAUDE.md`) in the repo has comprehensive guidance on authorization patterns, testing conventions, and coding standards — always consult it when working in this codebase.
- **HIPAA compliant** — be cautious with logging PHI, never commit secrets, never access production/staging environments directly.
