# Feature Flags

Last updated: 2026-03

Netlify uses **DevCycle** as the feature flag provider. Go services integrate via `github.com/netlify/go-flags/v2/featureflag`.

## API

Three evaluation functions:

```go
featureflag.Enabled(key, userID string, attrs map[string]any) bool
featureflag.Int(key string, defaultVal int, userID string, attrs map[string]any) int
featureflag.Variation(key, defaultVal, userID string, attrs map[string]any) string
```

Use `Enabled` for on/off flags, `Int` for numeric configuration, `Variation` for string values or multi-variant flags.

## Package structure

Each service should have a `flags/` package that:

1. **Defines flag name constants** — never inline flag name strings at call sites
2. **Provides wrapper functions** that pre-populate targeting attributes from whatever context struct is in scope

```
flags/
├── flags.go       # Flag name constants + wrapper functions
```

Flag name constants:

```go
const (
    SomeFeature        = "service-name-some-feature"
    SomeIntConfig      = "service-name-some-int-config"
    SomeVariantFeature = "service-name-some-variant-feature"
)
```

Prefix flag names with the service name to avoid collisions in DevCycle.

Wrapper functions eliminate the boilerplate of building attrs at every call site. The wrapper should accept whatever primary domain object is available (a request, a site, an account, etc.) and handle the attribute construction internally:

```go
func FlagEnabled(key string, siteID string, account *SomeAccount) bool {
    return featureflag.Enabled(key, siteID, flagAttrs(account))
}

func flagAttrs(account *SomeAccount) map[string]any {
    if account == nil {
        return nil
    }
    return map[string]any{
        "groups":     accountTierLabel(account.Tier),
        "account_id": account.ID,
    }
}
```

If your service has a domain struct that's present at most flag evaluation sites, attach the wrapper and attr-builder as methods on that struct instead.

## User ID

The user ID is the primary targeting key DevCycle uses to evaluate a flag. Use the most specific, stable identifier for the entity being targeted:

| Targeting scope | User ID to use |
|---|---|
| Site-level | Site ID (MongoDB ObjectID hex) |
| Account-level | Account ID (MongoDB ObjectID hex) |
| Infrastructure / node-level | Node/host name, or `""` |

Prefer site ID over domain/hostname when both are available. Domain names can change; site IDs are stable.

Use `""` only for flags that target infrastructure rather than customer entities (e.g., enabling a feature across all nodes in a region, or adjusting a cluster-wide limit).

## Attributes

Attributes enable fine-grained targeting rules in DevCycle beyond the user ID alone. Always include these when available:

```go
map[string]any{
    "groups":     "<account_tier_label>",  // see below
    "account_id": "<account_id>",
    "site_id":    "<site_id>",
}
```

**Account tier**: DevCycle uses the `"groups"` key for group-based targeting. Normalize the account tier string to `"account_type_<tier_lowercase>"` (e.g., `"Starter"` → `"account_type_starter"`). The `go-flags/v2` library or your service's `flags/` package should provide this normalization — don't do it inline at call sites.

> **Common mistake**: using `"account_tier"` as the attribute key. DevCycle group rules require the key to be `"groups"`. Using the wrong key means account tier targeting rules silently never fire.

Pass `nil` attrs when you have no targeting context (infrastructure flags, or when no account/site is in scope).

## Testing

The `featureflag` package provides test helpers that register cleanup automatically via `t`:

```go
// Enable one or more boolean flags (returns true for all users)
featureflag.MockBooleanFlags(t, flags.SomeFeature, flags.AnotherFeature)

// Set specific values (bool, int, or string)
featureflag.MockFlags(t, map[string]any{
    flags.SomeIntConfig:      42,
    flags.SomeVariantFeature: "variant-b",
    flags.SomeBoolFeature:    true,
})
```

For tests that need to assert what a flag was called with (user ID, attrs), wrap the global client:

```go
og := featureflag.GetGlobalClient()
t.Cleanup(func() { featureflag.SetGlobalClient(og) })

featureflag.SetGlobalClient(callbackClient{
    Client: og,
    enabledFn: func(key, userID string, attrs map[string]any) bool {
        if key == flags.SomeFeature {
            assert.Equal(t, expectedSiteID, userID)
            return true
        }
        return og.Enabled(key, userID, attrs)
    },
})
```

Implement `featureflag.Client` to intercept only the methods you need; delegate the rest to the original client.
