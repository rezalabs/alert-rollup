# Alert Rollup

[![CI](https://github.com/rezalabs/alert-rollup/actions/workflows/ci.yml/badge.svg)](https://github.com/rezalabs/alert-rollup/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rezalabs/alert-rollup/actions/workflows/security.yml/badge.svg)](https://github.com/rezalabs/alert-rollup/actions/workflows/security.yml)
[![npm version](https://img.shields.io/npm/v/alert-rollup.svg)](https://www.npmjs.com/package/alert-rollup)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](./package.json)

Alert Rollup is a Node.js library that prevents alert storms from flooding your notification channels without losing visibility. Monitoring systems fire the same alert hundreds of times during an incident. You do not want 500 Slack messages, but you also do not want to suppress everything and miss critical signals. Alert Rollup takes the opposite approach: the first occurrence of any unique alert fires immediately, duplicates accumulate silently with full counting, and a periodic digest reports the aggregate. Acknowledge to suppress temporarily while the count continues to increment. Auto-resolve after silence so a quiet alert is treated as a fresh incident on its next occurrence. In-memory storage for single-process deployments, Redis with atomic Lua scripts for distributed multi-instance setups. Same API, same guarantees.

## Features

- **Immediate first alert:** The first occurrence of any unique alert fires `onFirst` immediately for real-time incident awareness.
- **Silent accumulation:** Duplicates are counted and sampled without firing additional notifications until the digest interval or threshold is reached.
- **Scheduled digests:** Configurable interval fires `onDigest` with the aggregated count, first/last timestamps, and sample payloads.
- **Temporary acknowledgment:** Suppress digests for a configurable duration while the alert count continues to increment.
- **Auto-resolve detection:** When an alert is silent for longer than `autoResolveAfter`, the next occurrence triggers `onResolve` and starts a fresh incident.
- **LRU eviction under capacity:** When `maxFingerprints` is reached, the oldest inactive record is evicted to make room. Graceful `rejected` outcome when all records are acknowledged.
- **Lossless delivery:** Digest records are only deleted after confirmed `onDigest` success. Failed deliveries are retained and retried up to `maxDeliveryAttempts`.
- **Distributed mode:** Share alert state across multiple processes or machines using Redis with atomic Lua scripts for ingest, counting, and delivery claims.

## Quick Start

### Installation

```bash
npm install alert-rollup
```

### Basic Usage

```javascript
import { AlertRollup } from 'alert-rollup'

const engine = new AlertRollup({
    // Group alerts by service + error code
    fingerprint: (alert) => `${alert.service}:${alert.errorCode}`,

    // First alert fires immediately
    onFirst: async (alert, fingerprint) => {
        await sendToSlack(`INCIDENT: ${alert.service}: ${alert.message}`)
    },

    // Digest every 5 minutes or 50 alerts
    digestInterval: 5 * 60 * 1000,
    digestThreshold: 50,

    // Auto-resolve if no alert for 10 minutes
    autoResolveAfter: '10m',

    // Called with accumulated digest
    onDigest: async (digest) => {
        await sendToSlack(
            `DIGEST: ${digest.alertId}: ${digest.count}x since ${new Date(digest.firstAt).toISOString()}`
        )
    }
})

const result = await engine.ingest({
    service: 'auth-api',
    errorCode: 'DB_TIMEOUT',
    message: 'Database connection timeout',
    timestamp: Date.now()
})
console.log(result.outcome) // 'first'

// Acknowledge and suppress for 30 minutes
await engine.acknowledge('auth-api:DB_TIMEOUT', '30m')
```

For more complete scenarios, see the [`examples/`](./examples) directory.

## Configuration

Alert Rollup works out of the box with sensible defaults. If you need to override behavior, pass options to the constructor:

```javascript
const engine = new AlertRollup({
    digestInterval: 300000,       // 5 min between scheduled digests
    digestThreshold: 50,          // Fire inline digest at 50 accumulated alerts
    immediateLimit: 1,            // Fire onFirst for the first occurrence only
    maxSamples: 5,                // Store up to 5 sample payloads per digest
    acknowledgmentExpiry: '30m',  // Default ack duration
    autoResolveAfter: '10m',      // Auto-resolve after 10 min of silence
    maxFingerprints: 10000,       // Soft cap with LRU eviction
    maxDeliveryAttempts: 3,       // Retries before digest is marked failed
    recordTTL: '24h',             // Clean up records after 24h of inactivity
    onDigest: async (digest) => { /* ... */ }
})
```

Full list of options is documented in [`CONFIG.md`](./CONFIG.md). There are no undocumented switches.

## API Reference

Every public function is fully typed and has corresponding unit tests. TypeScript definitions are included in the package.

- **[`CONFIG.md`](./CONFIG.md)** for the complete options reference
- **[`examples/`](./examples)** for runnable, self-contained examples
- **TypeScript definitions** in [`index.d.ts`](./index.d.ts)

The unit tests (in [`__tests__/`](./__tests__)) serve as the definitive, always-correct specification for edge behaviour.

## Examples

Runnable, production-ready examples are maintained in the [`examples/`](./examples) directory:

- **[`slack-basic.js`](./examples/slack-basic.js)** — Single-process usage with Slack-style output. Demonstrates first-alert notification, silent accumulation, acknowledgment, and digest delivery.
- **[`redis-distributed.js`](./examples/redis-distributed.js)** — Distributed two-instance usage over Redis. Demonstrates shared alert state, cross-instance acknowledgment, and suppression.

For a step-by-step walkthrough, see [`EXAMPLES.md`](./EXAMPLES.md).

## Contributing

Pull requests are not accepted. This project is AI-assisted and single-maintainer: every line is curated through a consistent workflow that external PRs would disrupt.

What is accepted:

- **Bug reports** with reproduction steps.
- **Feature requests** that align with the project's core principles.
- **Documentation corrections** for errors or omissions.

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for details.

This project is maintained by [RezaLabs](https://rezalabs.com).

## Changelog

Notable changes between versions are documented in [`CHANGELOG.md`](./CHANGELOG.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## Development Process

This project is built with heavy assistance from large language models.

**Why?** The entire codebase, from architecture decisions down to individual line implementations, is produced through iterative prompting and review with AI. This is intentional. The goal is to test the limits of what AI can generate when held to strict quality standards.

**What this means for you:**
- Every commit and every release is reviewed and approved by a human. AI generates proposals; I accept, reject, or modify them.
- The project is a deliberate exercise in AI-assisted engineering. The output is curated, tested, and documented.
- If you find an issue, it is my failure as the maintainer to catch it, not an excuse that "the AI wrote it." I own all results.

This project is as much a product of AI capability as it is of human editorial judgment. You are welcome to judge both.

## Support

If this project saves you time or solves a problem you would otherwise pay to fix, consider supporting its continued development.

- [Buy Me a Coffee](https://buymeacoffee.com/rezalabs)
- [Ko-fi](https://ko-fi.com/rezalabs)

Sponsorship is never required, but always appreciated. It funds maintenance, tooling, and the compute needed to iterate with AI assistance at this scale.

## License

MIT License. See the full text in [`LICENSE`](./LICENSE).

Copyright (c) 2026 [RezaLabs](https://rezalabs.com)
