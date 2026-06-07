const { EventEmitter } = require('events')
const InMemoryAdapter = require('./storage/InMemoryAdapter')
const RedisAdapter = require('./storage/RedisAdapter')
const { generateFingerprint, parseDuration } = require('./fingerprint')

const DEFAULT_DIGEST_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_DIGEST_THRESHOLD = 50
const DEFAULT_IMMEDIATE_LIMIT = 1
const DEFAULT_MAX_SAMPLES = 5
const DEFAULT_ACKNOWLEDGMENT_EXPIRY_MS = 30 * 60 * 1000
const DEFAULT_MAX_FINGERPRINTS = 10000
const DEFAULT_RECORD_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_AUTO_RESOLVE_MS = 10 * 60 * 1000
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3
const MIN_DIGEST_INTERVAL_MS = 1000
const MAX_FINGERPRINT_LENGTH = 256

const OUTCOME_FIRST = 'first'
const OUTCOME_SAMPLE = 'sample'
const OUTCOME_DIGEST = 'digest'
const OUTCOME_SUPPRESSED = 'suppressed'
const OUTCOME_REJECTED = 'rejected'

const SIGNAL_BEFORE_EXIT = 'beforeExit'
const SIGNAL_SIGINT = 'SIGINT'
const SIGNAL_SIGTERM = 'SIGTERM'

/**
 * Validates that a value is of the expected type. Throws TypeError with a
 * descriptive message on mismatch.
 *
 * @param {*} value - The value to check.
 * @param {string} expected - Expected typeof result.
 * @param {string} name - Human-readable option name for the error message.
 * @throws {TypeError}
 */
function validateType (value, expected, name) {
    if (value == null) return
    const actual = typeof value
    if (actual !== expected) {
        throw new TypeError(`${name} must be a ${expected}, got ${actual}`)
    }
}

class AlertRollup extends EventEmitter {
    /**
     * Create an AlertRollup instance.
     *
     * The digest loop starts immediately. Register event listeners before the
     * first `ingest()` call to avoid missing early events.
     *
     * @param {object} options
     * @param {(digest: object) => Promise<void>|void} options.onDigest
     *   Required. Receives the accumulated digest when the interval fires or
     *   `digestThreshold` is reached. The record is only deleted from storage
     *   after this callback completes successfully.
     * @param {(alert: object, fingerprint: string) => Promise<void>|void} [options.onFirst]
     *   Called on the first occurrence (or first `immediateLimit` occurrences).
     * @param {(digest: object) => Promise<void>|void} [options.onResolve]
     *   Called when an alert auto-resolves after silence longer than `autoResolveAfter`.
     * @param {(alert: object) => string} [options.fingerprint]
     *   Grouping function. Default: SHA256 of sorted alert keys.
     * @param {string[]} [options.ignoreFields]
     *   Fields excluded from the default fingerprint hash.
     * @param {string|number} [options.digestInterval=300000]
     *   Milliseconds between automatic digest sends. Minimum: 1000.
     * @param {number} [options.digestThreshold=50]
     *   Fire `onDigest` inline when count reaches this value.
     * @param {number} [options.immediateLimit=1]
     *   Call `onFirst` for the first N occurrences.
     * @param {number} [options.maxSamples=5]
     *   Maximum number of raw alert objects retained per digest.
     * @param {number|string} [options.acknowledgmentExpiry=1800000]
     *   Default suppression duration for `acknowledge()`. Format: '30m', '2h', or ms.
     * @param {string|number} [options.autoResolveAfter=600000]
     *   Treat the alert as a new incident after this silence period. Format: '10m' or ms.
     * @param {number} [options.maxFingerprints=10000]
     *   Soft cap on unique fingerprints. When exceeded, the oldest inactive
     *   record is evicted to make room. Set to 0 to disable the limit entirely.
     * @param {number} [options.maxDeliveryAttempts=3]
     *   Maximum delivery attempts per digest before giving up. After exhaustion,
     *   the record is retained for inspection and a 'digestFailed' event is emitted.
     * @param {number} [options.recordTTL=86400000]
     *   Milliseconds before an inactive record is automatically removed.
     * @param {import('redis').RedisClientType} [options.redis]
     *   Redis client for distributed mode. Must be created with `{ scripts }` registered.
     * @throws {TypeError} If `onDigest` is not a function, or any option has the wrong type.
     */
    constructor (options = {}) {
        super()

        if (typeof options.onDigest !== 'function') {
            throw new TypeError('onDigest callback is required')
        }

        // ── Validate constructor option types ──
        validateType(options.onFirst, 'function', 'onFirst')
        validateType(options.onResolve, 'function', 'onResolve')
        validateType(options.fingerprint, 'function', 'fingerprint')
        if (options.ignoreFields != null && !Array.isArray(options.ignoreFields)) {
            throw new TypeError('ignoreFields must be an array')
        }
        if (options.redis != null && typeof options.redis !== 'object') {
            throw new TypeError('redis must be a RedisClientType instance')
        }

        this.onDigest = options.onDigest
        this.onFirst = options.onFirst ?? null
        this.onResolve = options.onResolve ?? null
        this.fingerprintFn = options.fingerprint ?? ((alert) => generateFingerprint(alert, options.ignoreFields ?? []))
        this.autoResolveAfterMs = options.autoResolveAfter != null ? parseDuration(options.autoResolveAfter) : DEFAULT_AUTO_RESOLVE_MS

        this.digestIntervalMs = Math.max(MIN_DIGEST_INTERVAL_MS, options.digestInterval ?? DEFAULT_DIGEST_INTERVAL_MS)
        this.digestThreshold = Math.max(1, options.digestThreshold ?? DEFAULT_DIGEST_THRESHOLD)
        this.immediateLimit = Math.max(0, options.immediateLimit ?? DEFAULT_IMMEDIATE_LIMIT)
        this.maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES)
        this.acknowledgmentExpiryMs = options.acknowledgmentExpiry ?? DEFAULT_ACKNOWLEDGMENT_EXPIRY_MS
        this.maxFingerprints = Math.max(0, options.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS)
        this.maxDeliveryAttempts = Math.max(1, options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS)
        this.recordTTLMs = options.recordTTL ?? DEFAULT_RECORD_TTL_MS

        this.storage = options.redis
            ? new RedisAdapter({ redisClient: options.redis })
            : new InMemoryAdapter()

        this.isRunning = false
        this.digestTimeoutId = null
        this.acknowledgments = new Map()
        this._ackTimers = new Set()

        this._startDigestLoop()
        this._setupExitHandlers()
    }

    _setupExitHandlers () {
        this._cleanup = () => {
            this.close()
        }
        process.once(SIGNAL_BEFORE_EXIT, this._cleanup)
        process.once(SIGNAL_SIGINT, this._cleanup)
        process.once(SIGNAL_SIGTERM, this._cleanup)
    }

    /**
     * Emits 'error' only when a listener is attached; otherwise logs to stderr.
     * Prevents Node.js from throwing ERR_UNHANDLED_ERROR and crashing the process
     * when no 'error' listener is registered (or after removeAllListeners is called).
     */
    _emitSafeError (error) {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error)
        } else {
            console.error('[alert-rollup] Unhandled digest loop error:', error)
        }
    }

    /**
     * Run the periodic digest loop.
     *
     * Each iteration claims due records atomically, delivers them, and only
     * deletes on success. Failed deliveries are retained and retried on the
     * next cycle. Uses `setTimeout` with `unref()` so the timer does not
     * keep the process alive.
     */
    _startDigestLoop () {
        if (this.isRunning) return
        this.isRunning = true

        const loop = async () => {
            if (!this.isRunning) return

            try {
                await this._processDueDigests()
            } catch (error) {
                this._emitSafeError(error)
            } finally {
                if (this.isRunning) {
                    this.digestTimeoutId = setTimeout(loop, this.digestIntervalMs)
                    this.digestTimeoutId.unref()
                }
            }
        }

        this.digestTimeoutId = setTimeout(loop, this.digestIntervalMs)
        this.digestTimeoutId.unref()
    }

    /**
     * Claim and deliver all records whose `lastAt` is at or before `now`.
     *
     * Each record is atomically claimed via `claimForDelivery` to prevent
     * duplicate delivery when multiple engine instances share Redis storage.
     * Acknowledged records (both local and stored) are skipped. Records that
     * have exhausted `maxDeliveryAttempts` are skipped and emit `digestFailed`.
     */
    async _processDueDigests () {
        const now = Date.now()
        const digests = await this.storage.getDueDigests(now)

        for (const digest of digests) {
            if (digest.count <= 0) continue

            const localAck = this.acknowledgments.get(digest.alertId)
            if (localAck != null && localAck > now) continue

            // Also check stored acknowledgedUntil to respect distributed acknowledgments
            if (digest.acknowledgedUntil != null && digest.acknowledgedUntil > now) continue

            // Check if max delivery attempts already exhausted
            if ((digest.deliveryAttempts || 0) >= this.maxDeliveryAttempts) {
                this.emit('digestFailed', { digest, reason: `Exceeded max delivery attempts (${this.maxDeliveryAttempts})` })
                continue
            }

            // Atomically claim this digest for delivery (prevents duplicate delivery
            // across distributed instances)
            const claimed = await this.storage.claimForDelivery(digest.alertId)
            if (!claimed) continue

            const delivered = await this._sendDigest(claimed)
            if (delivered) {
                await this.storage.delete(digest.alertId)
                await this.storage.releaseClaim(digest.alertId)
            } else {
                // Delivery failed. Update the attempt counter before releasing
                // the claim so another instance cannot modify the record between
                // our read and write (TOCTOU prevention).
                const attempts = (claimed.deliveryAttempts || 0) + 1
                try {
                    const existing = await this.storage.get(digest.alertId)
                    if (existing) {
                        const updated = { ...existing, deliveryAttempts: attempts }
                        await this.storage.set(digest.alertId, updated, Date.now() + this.recordTTLMs)
                    }
                } catch (_) {
                    // Best-effort update; record may have been deleted concurrently
                }
                await this.storage.releaseClaim(digest.alertId)
            }
        }
    }

    /**
     * Invoke the user-supplied `onDigest` callback. Returns `true` if the
     * callback completed without throwing, `false` otherwise. Callers use
     * this to decide whether to delete the record or preserve it for retry.
     *
     * @param {object} digest
     * @returns {Promise<boolean>}
     */
    async _sendDigest (digest) {
        try {
            await this.onDigest(digest)
            this.emit('digest', digest)
            return true
        } catch (error) {
            this.emit('digestError', { error, digest })
            return false
        }
    }

    /**
     * Check whether an existing record has been silent longer than
     * `autoResolveAfterMs`. If so, emit `resolve`, call `onResolve`,
     * delete the record, and return `null` so the caller treats the
     * new alert as a fresh incident.
     *
     * @param {string} fingerprint
     * @param {object|null} existing - The stored record, or null.
     * @param {number} now - Current timestamp.
     * @returns {Promise<object|null>} The existing record if not resolved, null otherwise.
     */
    async _handleAutoResolve (fingerprint, existing, now) {
        if (!existing) return null
        if (now - existing.lastAt <= this.autoResolveAfterMs) return existing

        if (this.onResolve) {
            try {
                await this.onResolve(existing)
            } catch (error) {
                this.emit('resolveError', { error, digest: existing })
            }
        }
        this.emit('resolve', existing)
        await this.storage.delete(fingerprint)
        return null
    }

    /**
     * Make room for a new fingerprint when at the `maxFingerprints` limit.
     *
     * Finds the record with the oldest `lastAt` timestamp that is not
     * currently acknowledged, delivers its digest, and deletes it. Acknowledged
     * records are never evicted. If every record is acknowledged, eviction is
     * impossible; the caller must reject the new fingerprint gracefully.
     *
     * @returns {Promise<boolean>} true if under the limit or eviction succeeded,
     *   false if at the limit with nothing evictable.
     */
    async _evictIfNeeded () {
        if (this.maxFingerprints <= 0) return true

        const count = await this.storage.count()
        if (count < this.maxFingerprints) return true

        const oldest = await this.storage.getOldest()
        if (!oldest) return false

        const now = Date.now()
        const localAck = this.acknowledgments.get(oldest.alertId)
        if (localAck != null && localAck > now) return false
        if (oldest.acknowledgedUntil != null && oldest.acknowledgedUntil > now) return false

        // Attempt delivery before eviction
        await this._sendDigest(oldest)
        await this.storage.delete(oldest.alertId)
        return true
    }

    /**
     * Fire the `onFirst` callback (unless suppressed) and emit the `first` event.
     *
     * @param {object} alert
     * @param {string} fingerprint
     * @param {object} options - Ingest options (may carry `skipFirst`).
     * @param {number|null} count - Current occurrence count, passed in the event payload.
     * @returns {Promise<{outcome: string, fingerprint: string}>}
     */
    async _fireFirst (alert, fingerprint, options, count = null) {
        if (!options.skipFirst && this.onFirst) {
            try {
                await this.onFirst(alert, fingerprint)
            } catch (error) {
                this.emit('firstError', { error, alert, fingerprint })
            }
        }
        const payload = { alert, fingerprint }
        if (count !== null) payload.count = count
        this.emit(OUTCOME_FIRST, payload)
        return { outcome: OUTCOME_FIRST, fingerprint }
    }

    /**
     * Deliver a digest and delete its record only on success.
     *
     * If `maxDeliveryAttempts` is already exhausted, emits `digestFailed`
     * and returns `false` without attempting delivery. On failure, increments
     * the `deliveryAttempts` counter and preserves the record for retry.
     *
     * @param {object} digest
     * @param {string} fingerprint
     * @returns {Promise<boolean>} true if delivered and deleted.
     */
    async _deliverAndDelete (digest, fingerprint) {
        if ((digest.deliveryAttempts || 0) >= this.maxDeliveryAttempts) {
            this.emit('digestFailed', { digest, reason: `Exceeded max delivery attempts (${this.maxDeliveryAttempts})` })
            return false
        }

        const delivered = await this._sendDigest(digest)
        if (delivered) {
            await this.storage.delete(fingerprint)
        } else {
            // Preserve the record for retry; increment attempts
            const attempts = (digest.deliveryAttempts || 0) + 1
            try {
                const existing = await this.storage.get(fingerprint)
                if (existing) {
                    const updated = { ...existing, deliveryAttempts: attempts }
                    await this.storage.set(fingerprint, updated, Date.now() + this.recordTTLMs)
                }
            } catch (_) {
                // Best-effort
            }
        }
        return delivered
    }

    /**
     * Ingest an alert into the engine.
     *
     * Validates the alert object, computes or accepts a fingerprint, checks for
     * auto-resolve, and routes the alert through the accumulation and threshold
     * logic. May call `onFirst`, `onDigest`, or `onResolve` as side-effects.
     *
     * @param {object} alert - Plain object describing the alert. Must not be an array or primitive.
     * @param {object} [options]
     * @param {string} [options.fingerprint] - Explicit fingerprint; skips the engine-level function.
     * @param {boolean} [options.skipFirst] - Suppress the `onFirst` callback on first occurrence.
     * @returns {Promise<{outcome: 'first'|'sample'|'suppressed'|'digest'|'rejected', fingerprint: string}>}
     * @throws {Error} If called after `close()`.
     * @throws {TypeError} If `alert` is not a plain object, or the fingerprint is invalid.
     * @throws {TypeError} If the engine-level `fingerprint` function throws.
     */
    async ingest (alert, options = {}) {
        if (!this.isRunning) {
            throw new Error('AlertRollup has been closed')
        }
        if (!alert || typeof alert !== 'object' || Array.isArray(alert)) {
            throw new TypeError('Alert must be a plain object')
        }

        let fingerprint
        if (options.fingerprint !== undefined) {
            fingerprint = options.fingerprint
        } else {
            try {
                fingerprint = this.fingerprintFn(alert)
            } catch (err) {
                throw new TypeError(`Fingerprint function threw: ${err.message}`)
            }
        }
        if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
            throw new TypeError('Fingerprint must be a non-empty string')
        }
        if (fingerprint.length > MAX_FINGERPRINT_LENGTH) {
            throw new TypeError(`Fingerprint must not exceed ${MAX_FINGERPRINT_LENGTH} characters`)
        }

        const now = Date.now()

        // Use atomic ingest for Redis, manual for InMemory
        if (typeof this.storage.ingest === 'function') {
            return this._ingestAtomic(alert, fingerprint, now, options)
        }
        return this._ingestManual(alert, fingerprint, now, options)
    }

    /**
     * Ingest path when the storage adapter provides an atomic `ingest` method
     * (Redis). The Lua script handles create-or-update atomically. The
     * `maxFingerprints` limit is enforced inside the script; if rejected,
     * we evict locally and retry.
     */
    async _ingestAtomic (alert, fingerprint, now, options) {
        let result
        try {
            result = await this.storage.ingest(
                fingerprint,
                alert,
                now,
                this.recordTTLMs,
                this.maxSamples,
                this.maxFingerprints,
                this.autoResolveAfterMs
            )
        } catch (err) {
            // The Lua script rejected the ingest due to maxFingerprints. Evict and retry.
            if (err.message.includes('Max fingerprints limit')) {
                const evicted = await this._evictIfNeeded()
                if (!evicted) {
                    return { outcome: OUTCOME_REJECTED, fingerprint }
                }
                try {
                    result = await this.storage.ingest(
                        fingerprint,
                        alert,
                        now,
                        this.recordTTLMs,
                        this.maxSamples,
                        this.maxFingerprints,
                        this.autoResolveAfterMs
                    )
                } catch (retryErr) {
                    // If the retry also fails (e.g. stale counter), reject gracefully
                    if (retryErr.message.includes('Max fingerprints limit')) {
                        return { outcome: OUTCOME_REJECTED, fingerprint }
                    }
                    throw retryErr
                }
            } else {
                throw err
            }
        }

        // Auto-resolve was handled atomically inside the Lua script. Fire the
        // resolve callback now that we have the old record data.
        if (result.isResolved && result.resolvedRecord) {
            if (this.onResolve) {
                try {
                    await this.onResolve(result.resolvedRecord)
                } catch (error) {
                    this.emit('resolveError', { error, digest: result.resolvedRecord })
                }
            }
            this.emit('resolve', result.resolvedRecord)
            return this._fireFirst(alert, fingerprint, options)
        }

        if (result.isNew) {
            return this._fireFirst(alert, fingerprint, options)
        }

        const localAck = this.acknowledgments.get(fingerprint)
        const storedAck = result.record.acknowledgedUntil
        const ackUntil = (localAck != null && localAck > now)
            ? localAck
            : (storedAck != null && storedAck > now) ? storedAck : null

        if (ackUntil) {
            return { outcome: OUTCOME_SUPPRESSED, fingerprint }
        }

        if (result.record.count <= this.immediateLimit) {
            return this._fireFirst(alert, fingerprint, options, result.record.count)
        }

        if (result.record.count >= this.digestThreshold) {
            await this._deliverAndDelete(result.record, fingerprint)
            return { outcome: OUTCOME_DIGEST, fingerprint }
        }

        return { outcome: OUTCOME_SAMPLE, fingerprint }
    }

    /**
     * Ingest path for non-atomic storage (InMemory).
     *
     * Performs a get-then-set sequence: check for an existing record, handle
     * auto-resolve, enforce the fingerprint limit via eviction, then create
     * or update the record in storage.
     */
    async _ingestManual (alert, fingerprint, now, options) {
        let existing = await this.storage.get(fingerprint)
        existing = await this._handleAutoResolve(fingerprint, existing, now)

        if (!existing) {
            const evicted = await this._evictIfNeeded()
            if (!evicted) {
                return { outcome: OUTCOME_REJECTED, fingerprint }
            }

            const record = {
                alertId: fingerprint,
                count: 1,
                firstAt: now,
                lastAt: now,
                samples: [alert],
                acknowledgedUntil: null,
                deliveryAttempts: 0
            }
            await this.storage.set(fingerprint, record, now + this.recordTTLMs)
            return this._fireFirst(alert, fingerprint, options)
        }

        const localAck = this.acknowledgments.get(fingerprint)
        const storedAck = existing.acknowledgedUntil
        const ackUntil = (localAck != null && localAck > now)
            ? localAck
            : (storedAck != null && storedAck > now) ? storedAck : null

        if (ackUntil) {
            const updatedSamples = existing.samples.length < this.maxSamples
                ? [...existing.samples, alert]
                : existing.samples
            const updated = {
                ...existing,
                count: existing.count + 1,
                lastAt: now,
                samples: updatedSamples,
                deliveryAttempts: existing.deliveryAttempts || 0
            }
            await this.storage.set(fingerprint, updated, now + this.recordTTLMs)
            return { outcome: OUTCOME_SUPPRESSED, fingerprint }
        }

        const updatedSamples = existing.samples.length < this.maxSamples
            ? [...existing.samples, alert]
            : existing.samples
        const updated = {
            ...existing,
            count: existing.count + 1,
            lastAt: now,
            samples: updatedSamples,
            deliveryAttempts: existing.deliveryAttempts || 0
        }
        await this.storage.set(fingerprint, updated, now + this.recordTTLMs)

        if (updated.count <= this.immediateLimit) {
            return this._fireFirst(alert, fingerprint, options, updated.count)
        }

        if (updated.count >= this.digestThreshold) {
            await this._deliverAndDelete(updated, fingerprint)
            return { outcome: OUTCOME_DIGEST, fingerprint }
        }

        return { outcome: OUTCOME_SAMPLE, fingerprint }
    }

    /**
     * Acknowledge (suppress) digest notifications for a fingerprint for a given duration.
     * Alerts ingested during the suppression window are still counted but not notified.
     * The acknowledgment is persisted to storage so distributed instances respect it.
     *
     * @param {string} fingerprint - Alert fingerprint to suppress.
     * @param {string|number} [duration] - Suppression duration. Format: '30m', '2h', '1d', or ms.
     *   Defaults to the `acknowledgmentExpiry` constructor option.
     * @returns {Promise<{fingerprint: string, acknowledgedUntil: number}>}
     * @throws {Error} If called after `close()`.
     * @throws {TypeError} If `fingerprint` is not a non-empty string.
     * @throws {TypeError} If `duration` is not a valid format.
     */
    async acknowledge (fingerprint, duration) {
        if (!this.isRunning) {
            throw new Error('AlertRollup has been closed')
        }
        if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
            throw new TypeError('Fingerprint must be a non-empty string')
        }

        const ms = parseDuration(duration ?? this.acknowledgmentExpiryMs)
        const until = Date.now() + ms

        this.acknowledgments.set(fingerprint, until)

        const existing = await this.storage.get(fingerprint)
        if (existing) {
            const updated = { ...existing, acknowledgedUntil: until }
            await this.storage.set(fingerprint, updated, until + this.recordTTLMs)
        }

        const ackTimer = setTimeout(() => {
            this.acknowledgments.delete(fingerprint)
            this._ackTimers.delete(ackTimer)
        }, ms)
        this._ackTimers.add(ackTimer)

        this.emit('acknowledge', { fingerprint, until })
        return { fingerprint, acknowledgedUntil: until }
    }

    /**
     * Immediately send pending digest(s) without waiting for the scheduled interval.
     * Acknowledged fingerprints are skipped.
     * Calls `onDigest` and emits `'digest'` for each record successfully sent.
     * Records whose delivery fails are retained in storage for retry.
     *
     * @param {string} [fingerprint] - Flush a specific fingerprint. Flushes all if omitted.
     * @returns {Promise<{flushed: number}>} Number of digests successfully sent.
     * @throws {Error} If called after `close()`.
     */
    async flush (fingerprint) {
        if (!this.isRunning) {
            throw new Error('AlertRollup has been closed')
        }
        const now = Date.now()
        if (fingerprint !== undefined) {
            const ackUntil = this.acknowledgments.get(fingerprint)
            if (ackUntil != null && ackUntil > now) {
                return { flushed: 0 }
            }
            const digest = await this.storage.get(fingerprint)
            if (digest && digest.count > 0) {
                if (digest.acknowledgedUntil != null && digest.acknowledgedUntil > now) {
                    return { flushed: 0 }
                }
                const delivered = await this._deliverAndDelete(digest, fingerprint)
                return { flushed: delivered ? 1 : 0 }
            }
            return { flushed: 0 }
        }

        const all = await this.storage.getAll()
        let flushed = 0
        for (const snapshot of all) {
            if (snapshot.count <= 0) continue

            const ackUntil = this.acknowledgments.get(snapshot.alertId)
            if (ackUntil != null && ackUntil > now) continue

            // Re-read the current record from storage to avoid delivering
            // stale data when the record was modified after getAll().
            const digest = await this.storage.get(snapshot.alertId)
            if (!digest || digest.count <= 0) continue
            if (digest.acknowledgedUntil != null && digest.acknowledgedUntil > now) continue

            const delivered = await this._deliverAndDelete(digest, digest.alertId)
            if (delivered) flushed++
        }
        return { flushed }
    }

    /**
     * Get the current accumulated digest record for a fingerprint.
     * Can be called after `close()`.
     *
     * @param {string} fingerprint
     * @returns {Promise<object|null>} The digest record, or `null` if not found.
     */
    async getDigest (fingerprint) {
        return this.storage.get(fingerprint)
    }

    /**
     * List all currently tracked fingerprints.
     * Can be called after `close()`.
     *
     * @returns {Promise<string[]>} Array of fingerprint strings.
     */
    async listFingerprints () {
        if (typeof this.storage.getKeys === 'function') {
            return this.storage.getKeys()
        }
        // Fallback for adapters that don't implement getKeys
        const all = await this.storage.getAll()
        return all.map(r => r.alertId)
    }

    /**
     * Get all current digest records.
     * Can be called after `close()`.
     *
     * @returns {Promise<object[]>} Array of digest records.
     */
    async getAllDigests () {
        return this.storage.getAll()
    }

    /**
     * Get a point-in-time snapshot of engine metrics.
     * Can be called after `close()`.
     *
     * @returns {Promise<{totalFingerprints: number, pendingDigests: number, acknowledgedCount: number, failedDeliveries: number}>}
     */
    async getMetrics () {
        const all = await this.storage.getAll()
        const now = Date.now()
        let pendingDigests = 0
        let acknowledgedCount = 0
        let failedDeliveries = 0

        for (const d of all) {
            if (d.count > 0) pendingDigests++
            const localAck = this.acknowledgments.get(d.alertId)
            const storedAck = d.acknowledgedUntil
            const isAcknowledged = (localAck != null && localAck > now) ||
                (storedAck != null && storedAck > now)
            if (isAcknowledged) acknowledgedCount++
            if ((d.deliveryAttempts || 0) >= this.maxDeliveryAttempts) {
                failedDeliveries++
            }
        }

        return {
            totalFingerprints: all.length,
            pendingDigests,
            acknowledgedCount,
            failedDeliveries
        }
    }

    /**
     * Gracefully shut down the engine.
     *
     * Stops the digest loop, clears all acknowledgment timers, stops storage TTL
     * timers, and removes process signal listeners. Emits `'close'` before removing
     * all listeners.
     *
     * Pending digests are NOT automatically flushed. Call `await engine.flush()`
     * before `close()` if delivery before shutdown is required.
     *
     * Digest records are preserved in storage after close. Use `getDigest()`,
     * `listFingerprints()`, and `getAllDigests()` to inspect state after shutdown.
     *
     * Idempotent: safe to call multiple times.
     */
    close () {
        if (!this.isRunning) return
        this.isRunning = false

        if (this.digestTimeoutId) {
            clearTimeout(this.digestTimeoutId)
            this.digestTimeoutId = null
        }

        for (const timer of this._ackTimers) {
            clearTimeout(timer)
        }
        this._ackTimers.clear()

        if (this.storage && typeof this.storage.close === 'function') {
            this.storage.close()
        }

        if (this._cleanup) {
            process.removeListener(SIGNAL_BEFORE_EXIT, this._cleanup)
            process.removeListener(SIGNAL_SIGINT, this._cleanup)
            process.removeListener(SIGNAL_SIGTERM, this._cleanup)
        }

        this.emit('close')
        this.removeAllListeners()
    }
}

module.exports = AlertRollup
