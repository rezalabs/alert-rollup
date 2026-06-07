const KEY_PREFIX = 'alert-rollup:'
const COUNT_KEY = `${KEY_PREFIX}fp-count`
const LOCK_PREFIX = `${KEY_PREFIX}lock:`
const DEFAULT_LOCK_TTL_MS = 30000

/**
 * Redis-backed storage adapter for distributed multi-instance deployments.
 *
 * Requires the Lua scripts to be registered with the Redis client at creation:
 * ```js
 * const { scripts } = require('alert-rollup')
 * const redis = createClient({ scripts })
 * ```
 *
 * Hot-path writes use atomic Lua scripts to prevent race conditions across
 * instances. Fingerprint counting uses a dedicated counter key for O(1)
 * cardinality checks instead of the blocking `KEYS` command. `SCAN` is used
 * for non-blocking key iteration in read paths. The Redis client lifecycle is
 * managed by the caller; `close()` is a no-op.
 */
class RedisAdapter {
    constructor (options) {
        if (!options || !options.redisClient) {
            throw new Error('redisClient is required')
        }
        this.redis = options.redisClient
        this._validateScripts()
    }

    _validateScripts () {
        const required = ['ingest', 'claimDigest', 'releaseClaim']
        for (const name of required) {
            if (typeof this.redis[name] !== 'function') {
                throw new Error(
                    `Redis client missing required script "${name}". ` +
                    'Pass scripts to createClient: const { scripts } = require("alert-rollup"); createClient({ scripts })'
                )
            }
        }
    }

    _key (fingerprint) {
        return `${KEY_PREFIX}${fingerprint}`
    }

    _lockKey (fingerprint) {
        return `${LOCK_PREFIX}${fingerprint}`
    }

    _countKey () {
        return COUNT_KEY
    }

    async _scanAllKeys () {
        const keys = []
        for await (const key of this.redis.scanIterator({ match: `${KEY_PREFIX}*`, count: 100 })) {
            // Exclude the counter key and lock keys from record scans
            if (key === COUNT_KEY || key.startsWith(LOCK_PREFIX)) continue
            keys.push(key)
        }
        return keys
    }

    /**
     * Scan all record keys (excluding the counter and lock keys), then fetch
     * each value in a single pipeline. Corrupt JSON entries are logged and
     * skipped rather than aborting the entire batch.
     */
    async _fetchAllRecords () {
        const keys = await this._scanAllKeys()
        if (keys.length === 0) return []

        const pipeline = this.redis.multi()
        for (const key of keys) {
            pipeline.get(key)
        }
        const results = await pipeline.exec()
        const records = []
        for (const data of results) {
            if (data == null) continue
            try {
                records.push(JSON.parse(data))
            } catch (err) {
                console.error('[RedisAdapter] Skipping record with corrupt JSON data:', err.message)
            }
        }
        return records
    }

    /**
     * Atomically create or update a digest record using a Lua script.
     * When creating a new record, the script enforces the maxFingerprints
     * limit atomically using an O(1) counter key to prevent TOCTOU races
     * across distributed instances.
     *
     * Auto-resolve is handled inside the script: when the existing record
     * has been silent longer than `autoResolveAfterMs`, the old record is
     * returned with `isResolved: true` and a new record is created atomically.
     *
     * @param {string} fingerprint
     * @param {object} alert - Raw alert object to add to `samples`.
     * @param {number} now - Current timestamp (ms).
     * @param {number} ttlMs - Record TTL in milliseconds.
     * @param {number} maxSamples - Maximum number of samples to retain.
     * @param {number} maxFingerprints - Soft cap on unique fingerprints (0 = unlimited).
     *   Enforced atomically in the Lua script via the counter key.
     * @param {number} autoResolveAfterMs - Auto-resolve threshold in ms (0 = disabled).
     * @returns {Promise<{isNew: boolean, isResolved: boolean, record: object, resolvedRecord?: object}>}
     * @throws {Error} If the maxFingerprints limit is reached.
     * @throws {Error} If the Lua response cannot be parsed.
     */
    async ingest (fingerprint, alert, now, ttlMs, maxSamples, maxFingerprints, autoResolveAfterMs) {
        const result = await this.redis.ingest(
            [this._key(fingerprint), this._countKey()],
            [fingerprint, JSON.stringify(alert), now.toString(), ttlMs.toString(), maxSamples.toString(), maxFingerprints.toString(), (autoResolveAfterMs || 0).toString()]
        )
        if (result[0] === 'rejected') {
            throw new Error(`Max fingerprints limit (${result[1]}) reached`)
        }

        if (result[0] === 'resolved') {
            let oldRecord
            let newRecord
            try {
                oldRecord = JSON.parse(result[1])
                newRecord = JSON.parse(result[2])
            } catch (err) {
                throw new Error(`Failed to parse ingest response for fingerprint "${fingerprint}": ${err.message}`)
            }
            return {
                isNew: true,
                isResolved: true,
                record: newRecord,
                resolvedRecord: oldRecord
            }
        }

        let record
        try {
            record = JSON.parse(result[1])
        } catch (err) {
            throw new Error(`Failed to parse ingest response for fingerprint "${fingerprint}": ${err.message}`)
        }
        return {
            isNew: result[0] === 'new',
            isResolved: false,
            record
        }
    }

    async get (fingerprint) {
        const data = await this.redis.get(this._key(fingerprint))
        return data != null ? JSON.parse(data) : null
    }

    async set (fingerprint, record, expiresAt) {
        const ttl = Math.max(1, expiresAt - Date.now())
        await this.redis.set(this._key(fingerprint), JSON.stringify(record), { PX: ttl })
    }

    /**
     * Delete a record and decrement the fingerprint counter so it stays in
     * sync with the actual key count. The counter may drift slightly above
     * the true count due to TTL-based expiry, which is conservative for the
     * `maxFingerprints` limit.
     */
    async delete (fingerprint) {
        const deleted = await this.redis.del(this._key(fingerprint))
        // Only decrement the counter if a key was actually removed; otherwise
        // the counter drifts below zero and allows exceeding maxFingerprints.
        if (deleted > 0) {
            await this.redis.decr(this._countKey())
        }
    }

    async count () {
        const keys = await this._scanAllKeys()
        return keys.length
    }

    async getDueDigests (timestamp) {
        const records = await this._fetchAllRecords()
        return records.filter(record => record.lastAt <= timestamp)
    }

    async getAll () {
        return this._fetchAllRecords()
    }

    async getKeys () {
        const keys = await this._scanAllKeys()
        return keys.map(key => key.slice(KEY_PREFIX.length))
    }

    /**
     * Return the record with the lowest `lastAt` timestamp across all keys,
     * or null if no records exist. Used by the eviction policy.
     */
    async getOldest () {
        const records = await this._fetchAllRecords()
        if (records.length === 0) return null
        let oldest = records[0]
        for (const record of records) {
            if (record.lastAt < oldest.lastAt) {
                oldest = record
            }
        }
        return oldest
    }

    /**
     * Atomically claim a digest record for delivery.
     * Uses a short-lived lock key to prevent duplicate delivery across instances.
     *
     * @param {string} fingerprint
     * @returns {Promise<object|null>} The record if claimed, null if already locked or absent.
     */
    async claimForDelivery (fingerprint) {
        const data = await this.redis.claimDigest(
            [this._key(fingerprint), this._lockKey(fingerprint)],
            [DEFAULT_LOCK_TTL_MS.toString()]
        )
        if (data == null) return null
        try {
            return JSON.parse(data)
        } catch (err) {
            console.error('[RedisAdapter] Failed to parse claimed record:', err.message)
            await this.releaseClaim(fingerprint)
            return null
        }
    }

    /**
     * Release a delivery claim lock so another instance can retry delivery.
     *
     * @param {string} fingerprint
     */
    async releaseClaim (fingerprint) {
        await this.redis.releaseClaim([this._lockKey(fingerprint)], [])
    }

    close () {
        // Redis client lifecycle managed externally
    }
}

module.exports = RedisAdapter
