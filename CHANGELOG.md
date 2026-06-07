# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-06-01

### Added

- `AlertRollup` class — alert deduplication and digest engine with immediate-first, silent-accumulation, and scheduled-digest delivery model.
- `ingest(alert, options?)` — ingest alerts with automatic fingerprinting. Returns `first`, `sample`, `suppressed`, `digest`, or `rejected` outcome.
- `acknowledge(fingerprint, duration?)` — suppress digests for a configurable duration. Persisted to storage for distributed consistency.
- `flush(fingerprint?)` — force immediate digest delivery. Returns count of successfully sent digests.
- `getDigest(fingerprint)` — inspect accumulated digest state for a fingerprint.
- `listFingerprints()` — list all tracked fingerprint strings.
- `getAllDigests()` — get all current digest records.
- `getMetrics()` — engine metrics snapshot (total fingerprints, pending digests, acknowledged count, failed deliveries).
- `close()` — graceful shutdown. Stops timers, preserves storage data for post-close inspection.
- `onFirst` callback — fired for the first N occurrences of a new alert (configurable via `immediateLimit`).
- `onResolve` callback — fired when an alert auto-resolves after silence exceeds `autoResolveAfter`.
- `autoResolveAfter` option — treat silent alerts as new incidents after a configurable silence period.
- `maxFingerprints` option — soft cap with LRU eviction. Oldest inactive records are evicted to make room. Graceful `rejected` outcome when all records are acknowledged.
- `maxDeliveryAttempts` option — retry limit for failed deliveries. Records preserved after exhaustion with `digestFailed` event.
- `recordTTL` option — automatic cleanup of inactive records.
- Runtime type validation on all constructor options.
- `InMemoryAdapter` — single-process storage with `Map`-backed records and per-record TTL timers.
- `RedisAdapter` — distributed storage with atomic Lua scripts, O(1) fingerprint counting via counter key, and non-blocking `SCAN` iteration.
- Atomic `claimDigest` / `releaseClaim` Lua scripts — prevents duplicate digest delivery across distributed instances.
- `generateFingerprint(alert, ignoreFields?)` — SHA256-based fingerprint generation with stable key ordering.
- `parseDuration(duration)` — human-readable duration parser (`30m`, `2h`, `1d`, or milliseconds).
- 94 unit tests covering all public API methods, edge cases, error paths, and events.
- TypeScript definitions (`index.d.ts`) with full type coverage.
- `examples/slack-basic.js` — single-process usage with Slack-style output.
- `examples/redis-distributed.js` — distributed two-instance usage over Redis.
- Documentation: `README.md`, `CONFIG.md`, `EXAMPLES.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

[Unreleased]: https://github.com/rezalabs/alert-rollup/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/rezalabs/alert-rollup/releases/tag/v1.0.0
