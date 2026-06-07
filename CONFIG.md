# Configuration

Alert Rollup works out of the box with sensible defaults. The constructor accepts an options object. Every option has a documented default value and type.

## Constructor Options

All options are passed to `new AlertRollup(options)`.

### Required

| Option | Type | Description |
|--------|------|-------------|
| `onDigest` | `(digest: Digest) => Promise<void>` | Called when the digest interval fires or the digest threshold is reached. Receives the accumulated `Digest` object containing `alertId`, `count`, `firstAt`, `lastAt`, `samples`, and `acknowledgedUntil`. |

### Optional

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fingerprint` | `(alert: object) => string` | SHA256 hash of sorted alert keys | Function that returns a string identifier used to group duplicate alerts. Alerts with the same fingerprint are accumulated into the same digest record. |
| `ignoreFields` | `string[]` | `[]` | Array of field names to exclude from the default SHA256 fingerprint computation. Only used when the default `fingerprint` function is active. |
| `onFirst` | `(alert: object, fingerprint: string) => Promise<void>` | `undefined` | Called on the first occurrence of a new alert (and subsequent occurrences up to `immediateLimit`). Use for real-time notification of new incidents. |
| `onResolve` | `(digest: Digest) => Promise<void>` | `undefined` | Called when an alert auto-resolves after being silent longer than `autoResolveAfter`. Receives the resolved digest record. |
| `digestInterval` | `number` | `300000` (5 minutes) | Milliseconds between automatic digest checks. Minimum: `1000` (1 second). |
| `digestThreshold` | `number` | `50` | When the count for a single fingerprint reaches this value, the digest is emitted immediately (inline) rather than waiting for the next interval cycle. |
| `immediateLimit` | `number` | `1` | Number of initial occurrences that trigger `onFirst`. Set higher than 1 to get notified for the first N occurrences. |
| `maxSamples` | `number` | `5` | Maximum number of raw alert payloads stored in the digest record's `samples` array. |
| `acknowledgmentExpiry` | `number \| string` | `1800000` (30 minutes) | Default duration for `acknowledge()` when no explicit duration is provided. Accepts milliseconds or a duration string (see Duration Format below). |
| `autoResolveAfter` | `number \| string` | `600000` (10 minutes) | If no new alert arrives for this fingerprint within this period, the incident is considered resolved. The next occurrence triggers `onResolve` and starts a fresh incident. Accepts milliseconds or a duration string. |
| `maxFingerprints` | `number` | `10000` | Soft cap on the number of unique fingerprints stored. When exceeded, the oldest inactive (non-acknowledged) record is evicted. Set to `0` to disable the limit entirely. If all records are acknowledged, new fingerprints are gracefully rejected with an outcome of `'rejected'`. |
| `maxDeliveryAttempts` | `number` | `3` | Maximum number of delivery attempts per digest record. After exhausting all attempts, the record is preserved for inspection, the `'digestFailed'` event is emitted, and no further automatic delivery is attempted. Minimum: `1`. |
| `recordTTL` | `number \| string` | `86400000` (24 hours) | How long a digest record is kept after its last activity. Records are automatically cleaned up after this period. Accepts milliseconds or a duration string. |
| `redis` | `RedisClientType` | `undefined` | A Redis client instance with Lua scripts registered. When provided, the engine uses `RedisAdapter` for distributed state instead of the default `InMemoryAdapter`. |

## Duration Format

Options that accept `number | string` support both milliseconds and human-readable duration strings:

| Format | Example | Result |
|--------|---------|--------|
| `'500ms'` | 500 milliseconds | `500` |
| `'30s'` | 30 seconds | `30000` |
| `'5m'` | 5 minutes | `300000` |
| `'2h'` | 2 hours | `7200000` |
| `'1d'` | 1 day | `86400000` |
| Plain number | `30000` | Treated as milliseconds |

The duration parser is exported as `parseDuration()`.

## Redis Client Setup

When using Redis mode, the Redis client must have the engine's Lua scripts registered:

```javascript
const { createClient } = require('redis')
const { scripts } = require('alert-rollup')

const redis = createClient({
    url: 'redis://localhost:6379',
    scripts  // Required for AlertRollup
})
```

Without the `scripts` registration, `ingest()` operations will fail at runtime.

## Events

The engine extends `EventEmitter` and emits the following events:

| Event | Payload | Description |
|-------|---------|-------------|
| `'first'` | `{ alert, fingerprint, count? }` | Emitted when `onFirst` fires. |
| `'digest'` | `Digest` | Emitted when `onDigest` fires. |
| `'acknowledge'` | `{ fingerprint, until }` | Emitted when an alert is acknowledged. |
| `'resolve'` | `Digest` | Emitted when an alert auto-resolves. |
| `'error'` | `Error` | Emitted for internal errors. If no listener, falls back to `console.error`. |
| `'firstError'` | `{ error, alert, fingerprint }` | Emitted when `onFirst` throws. |
| `'digestError'` | `{ error, digest }` | Emitted when `onDigest` throws. |
| `'resolveError'` | `{ error, digest }` | Emitted when `onResolve` throws. |
| `'digestFailed'` | `{ digest, reason }` | Emitted when a digest has exhausted all delivery attempts. The record is preserved for manual inspection via `getDigest()`. |
| `'close'` | none | Emitted when the engine is closed. |

## Public Methods

Beyond `ingest()`, `acknowledge()`, `flush()`, `getDigest()`, `getMetrics()`, and `close()`:

| Method | Returns | Description |
|--------|---------|-------------|
| `listFingerprints()` | `Promise<string[]>` | Returns all currently tracked fingerprint strings. Callable after `close()`. |
| `getAllDigests()` | `Promise<Digest[]>` | Returns all current digest records. Callable after `close()`. |

## Delivery Guarantees

- **Digest records are never deleted on delivery failure.** If `onDigest` throws, the record remains in storage and is retried on the next digest interval.
- **Distributed delivery is race-safe.** In Redis mode, digests are atomically claimed before delivery to prevent duplicate sends across instances.
- **After `maxDeliveryAttempts` failures**, the record is preserved and the `'digestFailed'` event is emitted. Use `getDigest()` to inspect and handle failed records.
- **Storage data is preserved after `close()`.** TTL timers are stopped but digest records remain accessible for inspection.
