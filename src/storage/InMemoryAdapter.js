/**
 * In-memory storage adapter. Records are stored in a `Map` with per-record
 * `setTimeout` timers for TTL expiry. Single-process only; no concurrency
 * guarantees.
 *
 * All methods are async for interface parity with `RedisAdapter`, even though
 * the underlying operations are synchronous.
 */
class InMemoryAdapter {
    constructor () {
        this.digests = new Map()
        this.timers = new Map()
    }

    async get (fingerprint) {
        return this.digests.get(fingerprint) ?? null
    }

    /**
     * Clear the expiration timer for this fingerprint (if any) and set a new
     * one. The timer fires at `expiresAt` and removes the record from the Map.
     * Timers are `unref()`'d so they do not keep the process alive.
     */
    async set (fingerprint, record, expiresAt) {
        this.digests.set(fingerprint, record)

        if (this.timers.has(fingerprint)) {
            clearTimeout(this.timers.get(fingerprint))
            this.timers.delete(fingerprint)
        }

        const ttl = expiresAt - Date.now()
        if (ttl > 0) {
            const timer = setTimeout(() => {
                this.digests.delete(fingerprint)
                this.timers.delete(fingerprint)
            }, ttl)
            timer.unref()
            this.timers.set(fingerprint, timer)
        }
    }

    async delete (fingerprint) {
        this.digests.delete(fingerprint)
        if (this.timers.has(fingerprint)) {
            clearTimeout(this.timers.get(fingerprint))
            this.timers.delete(fingerprint)
        }
    }

    async count () {
        return this.digests.size
    }

    /**
     * Return records whose `lastAt` is on or before `timestamp`. Since records
     * are always in the past, this is equivalent to returning all records in
     * practice. The filter exists as a guard against future-dated data and
     * for interface parity with `RedisAdapter`.
     */
    async getDueDigests (timestamp) {
        const due = []
        for (const [, record] of this.digests) {
            if (record.lastAt <= timestamp) {
                due.push(record)
            }
        }
        return due
    }

    async getAll () {
        return Array.from(this.digests.values())
    }

    async getKeys () {
        return Array.from(this.digests.keys())
    }

    /**
     * Return the record with the lowest `lastAt` timestamp, or null if empty.
     * Used by the eviction policy in `_evictIfNeeded`.
     */
    async getOldest () {
        let oldest = null
        for (const [, record] of this.digests) {
            if (!oldest || record.lastAt < oldest.lastAt) {
                oldest = record
            }
        }
        return oldest
    }

    /**
     * Return the record for delivery. In single-process mode, claims are
     * advisory; there is no concurrent access, so this is a plain lookup.
     */
    async claimForDelivery (fingerprint) {
        return this.digests.get(fingerprint) ?? null
    }

    async releaseClaim (fingerprint) {
        // No-op for in-memory: claims are advisory, no persistent lock needed
    }

    /**
     * Stops all TTL timers. Digest records are preserved for post-close
     * inspection via `getDigest()`, `listFingerprints()`, and `getAllDigests()`.
     */
    close () {
        for (const timer of this.timers.values()) {
            clearTimeout(timer)
        }
        this.timers.clear()
    }
}

module.exports = InMemoryAdapter
