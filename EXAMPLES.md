# Examples

Runnable, self-contained examples are maintained in the [`examples/`](./examples) directory.

## Example Index

| Example | File | Description |
|---------|------|-------------|
| Slack-style Basic | [`slack-basic.js`](./examples/slack-basic.js) | Single-process usage simulating Slack notifications. Demonstrates first-alert notification, silent accumulation of duplicates, digest delivery, and temporary acknowledgment. |
| Redis Distributed | [`redis-distributed.js`](./examples/redis-distributed.js) | Distributed two-instance deployment sharing alert state over Redis. Demonstrates cross-instance ingest, acknowledgment, and digest suppression with atomic Lua scripts. |

## Running Examples

```bash
# Slack-style basic example
npm run start:example

# Redis distributed example (requires a running Redis server)
npm run start:redis-example
```

## Writing Your Own Examples

Each example is a standalone Node.js script that can be run directly:

```bash
node examples/slack-basic.js
```

When contributing new examples (via issue report), follow these conventions:

- Import from `'alert-rollup'` using `require()` for CommonJS compatibility.
- Keep the example self-contained: no external services beyond Redis.
- Add a `console.log` preamble explaining what the example demonstrates.
- Call `engine.close()` at the end of the example lifecycle.
