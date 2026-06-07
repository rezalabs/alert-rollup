import { EventEmitter } from 'events'
import { RedisClientType } from 'redis'

/**
 * Alert digest record containing accumulated alert data
 */
export interface Digest {
    alertId: string
    count: number
    firstAt: number
    lastAt: number
    samples: object[]
    acknowledgedUntil: number | null
    /** Number of failed delivery attempts for this digest */
    deliveryAttempts: number
}

/**
 * Result of ingesting an alert
 */
export interface IngestResult {
    outcome: 'first' | 'sample' | 'suppressed' | 'digest' | 'rejected'
    fingerprint: string
    /** Present on 'first' outcomes when immediateLimit > 1 and count > 1 */
    count?: number
}

/**
 * Engine configuration options
 */
export interface AlertRollupOptions {
    /** Required callback for digest events */
    onDigest: (digest: Digest) => Promise<void> | void

    /** Optional callback for first occurrence */
    onFirst?: (alert: object, fingerprint: string) => Promise<void> | void

    /** Optional callback when alert auto-resolves (silence > autoResolveAfter) */
    onResolve?: (digest: Digest) => Promise<void> | void

    /** Auto-resolve after silence period. Format: '10m', '1h', or ms. Default: '10m' */
    autoResolveAfter?: string | number

    /** Function to generate fingerprint from alert. Default: SHA256 of sorted keys */
    fingerprint?: (alert: object) => string

    /** Fields to exclude from default fingerprint */
    ignoreFields?: string[]

    /** Milliseconds between automatic digests. Default: 300000 (5 min) */
    digestInterval?: number

    /** Fire digest when count reaches this. Default: 50 */
    digestThreshold?: number

    /** Fire onFirst for this many initial alerts. Default: 1 */
    immediateLimit?: number

    /** Store N sample alerts in digest. Default: 5 */
    maxSamples?: number

    /** Default acknowledgment duration in ms or string. Default: 1800000 (30 min) */
    acknowledgmentExpiry?: number | string

    /** Soft cap on unique fingerprints. When exceeded, oldest inactive record is evicted. Set 0 to disable. Default: 10000 */
    maxFingerprints?: number

    /** Maximum delivery attempts per digest before giving up. Default: 3 */
    maxDeliveryAttempts?: number

    /** Auto-cleanup after inactivity (ms). Default: 86400000 (24h) */
    recordTTL?: number

    /** Redis client for distributed mode. Scripts must be registered */
    redis?: RedisClientType
}

/**
 * Acknowledgment result
 */
export interface AcknowledgeResult {
    fingerprint: string
    acknowledgedUntil: number
}

/**
 * Flush result
 */
export interface FlushResult {
    /** Number of digests successfully sent (not attempted) */
    flushed: number
}

/**
 * Engine metrics
 */
export interface Metrics {
    totalFingerprints: number
    pendingDigests: number
    acknowledgedCount: number
    /** Number of records that have exceeded maxDeliveryAttempts */
    failedDeliveries: number
}

/**
 * Ingest options
 */
export interface IngestOptions {
    /** Override fingerprint for this alert */
    fingerprint?: string

    /** Skip onFirst callback even for first occurrence */
    skipFirst?: boolean
}

/**
 * Event: first occurrence
 */
export interface FirstEvent {
    alert: object
    fingerprint: string
    /** Present when immediateLimit > 1 and this is not the very first occurrence */
    count?: number
}

/**
 * Event: acknowledgment
 */
export interface AcknowledgeEvent {
    fingerprint: string
    until: number
}

/**
 * Event: error in onFirst callback
 */
export interface FirstErrorEvent {
    error: Error
    alert: object
    fingerprint: string
}

/**
 * Event: error in onDigest callback
 */
export interface DigestErrorEvent {
    error: Error
    digest: Digest
}

/**
 * Event: alert resolved (silence > autoResolveAfter)
 * The resolved digest is passed directly (same shape as Digest)
 */
export type ResolveEvent = Digest

/**
 * Event: error in onResolve callback
 */
export interface ResolveErrorEvent {
    error: Error
    digest: Digest
}

/**
 * Event: digest delivery permanently failed after exceeding maxDeliveryAttempts
 */
export interface DigestFailedEvent {
    digest: Digest
    reason: string
}

/**
 * Main alert digest engine class
 *
 * @example
 * ```typescript
 * const engine = new AlertRollup({
 *   fingerprint: (alert) => `${alert.service}:${alert.errorCode}`,
 *   onFirst: async (alert, fp) => {
 *     await slack.send(`🚨 ${alert.message}`)
 *   },
 *   onDigest: async (digest) => {
 *     await slack.send(`${digest.alertId}: ${digest.count}x`)
 *   }
 * })
 * ```
 */
export class AlertRollup extends EventEmitter {
    constructor(options: AlertRollupOptions)

    /**
     * Ingest an alert. Returns 'rejected' outcome when the fingerprint limit
     * is reached and no record can be evicted (all are acknowledged).
     */
    ingest(alert: object, options?: IngestOptions): Promise<IngestResult>

    /**
     * Acknowledge/suppress an alert for a duration
     * Duration format: '30m', '2h', '1d', or milliseconds
     * Uses acknowledgmentExpiry option if no duration provided
     */
    acknowledge(fingerprint: string, duration?: string | number): Promise<AcknowledgeResult>

    /**
     * Force immediate digest. If no fingerprint, flushes all.
     * Returns count of successfully delivered digests (not attempted).
     * Failed deliveries are preserved in storage for retry.
     */
    flush(fingerprint?: string): Promise<FlushResult>

    /**
     * Get current digest for a fingerprint.
     * Can be called after close() — storage data is preserved.
     */
    getDigest(fingerprint: string): Promise<Digest | null>

    /**
     * List all currently tracked fingerprints.
     * Can be called after close().
     */
    listFingerprints(): Promise<string[]>

    /**
     * Get all current digest records.
     * Can be called after close().
     */
    getAllDigests(): Promise<Digest[]>

    /**
     * Get engine metrics.
     * Can be called after close().
     */
    getMetrics(): Promise<Metrics>

    /**
     * Graceful shutdown. Stops the digest loop and clears timers.
     * Storage data is preserved for post-close inspection.
     * Pending digests are NOT automatically flushed.
     */
    close(): void

    // Event declarations
    on(event: 'first', listener: (event: FirstEvent) => void): this
    on(event: 'digest', listener: (digest: Digest) => void): this
    on(event: 'acknowledge', listener: (event: AcknowledgeEvent) => void): this
    on(event: 'resolve', listener: (event: ResolveEvent) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'firstError', listener: (event: FirstErrorEvent) => void): this
    on(event: 'digestError', listener: (event: DigestErrorEvent) => void): this
    on(event: 'resolveError', listener: (event: ResolveErrorEvent) => void): this
    on(event: 'digestFailed', listener: (event: DigestFailedEvent) => void): this
    on(event: 'close', listener: () => void): this

    once(event: 'first', listener: (event: FirstEvent) => void): this
    once(event: 'digest', listener: (digest: Digest) => void): this
    once(event: 'acknowledge', listener: (event: AcknowledgeEvent) => void): this
    once(event: 'error', listener: (error: Error) => void): this
    once(event: 'firstError', listener: (event: FirstErrorEvent) => void): this
    once(event: 'digestError', listener: (event: DigestErrorEvent) => void): this
    once(event: 'resolve', listener: (event: ResolveEvent) => void): this
    once(event: 'resolveError', listener: (event: ResolveErrorEvent) => void): this
    once(event: 'digestFailed', listener: (event: DigestFailedEvent) => void): this
    once(event: 'close', listener: () => void): this

    emit(event: 'first', data: FirstEvent): boolean
    emit(event: 'digest', data: Digest): boolean
    emit(event: 'acknowledge', data: AcknowledgeEvent): boolean
    emit(event: 'error', error: Error): boolean
    emit(event: 'firstError', data: FirstErrorEvent): boolean
    emit(event: 'digestError', data: DigestErrorEvent): boolean
    emit(event: 'resolve', data: ResolveEvent): boolean
    emit(event: 'resolveError', data: ResolveErrorEvent): boolean
    emit(event: 'digestFailed', data: DigestFailedEvent): boolean
    emit(event: 'close'): boolean
}

/**
 * Generate SHA256 fingerprint from alert object
 */
export function generateFingerprint(alert: object, ignoreFields?: string[]): string

/**
 * Parse duration string to milliseconds
 * @param duration - Format: '30m', '2h', '1d', or milliseconds number
 */
export function parseDuration(duration: string | number): number

/**
 * Redis Lua scripts for atomic operations.
 * Register with the Redis client at creation time:
 * `const redis = createClient({ scripts })`
 */
export const scripts: {
    ingest: {
        NUMBER_OF_KEYS: number
        SCRIPT: string
        transformArguments(keys: string[], args: string[]): (string | number)[]
    }
    claimDigest: {
        NUMBER_OF_KEYS: number
        SCRIPT: string
        transformArguments(keys: string[], args: string[]): (string | number)[]
    }
    releaseClaim: {
        NUMBER_OF_KEYS: number
        SCRIPT: string
        transformArguments(keys: string[], args: string[]): (string | number)[]
    }
}

/**
 * In-memory storage adapter.
 * Data is preserved after close(); only TTL timers are cleared.
 */
export class InMemoryAdapter {
    constructor()
    get(fingerprint: string): Promise<object | null>
    set(fingerprint: string, record: object, expiresAt: number): Promise<void>
    delete(fingerprint: string): Promise<void>
    count(): Promise<number>
    getDueDigests(timestamp: number): Promise<object[]>
    getAll(): Promise<object[]>
    getKeys(): Promise<string[]>
    getOldest(): Promise<object | null>
    claimForDelivery(fingerprint: string): Promise<object | null>
    releaseClaim(fingerprint: string): Promise<void>
    /** Stops TTL timers. Digest data is preserved for inspection. */
    close(): void
}

/**
 * Redis storage adapter.
 * Uses atomic Lua scripts for hot paths. Non-blocking SCAN for iteration.
 * Fingerprint counting uses an O(1) counter key instead of KEYS.
 */
export class RedisAdapter {
    constructor(options: { redisClient: RedisClientType })
    ingest(fingerprint: string, alert: object, now: number, ttlMs: number, maxSamples: number, maxFingerprints: number, autoResolveAfterMs?: number): Promise<{ isNew: boolean, isResolved: boolean, record: object, resolvedRecord?: object }>
    get(fingerprint: string): Promise<object | null>
    set(fingerprint: string, record: object, expiresAt: number): Promise<void>
    delete(fingerprint: string): Promise<void>
    count(): Promise<number>
    getDueDigests(timestamp: number): Promise<object[]>
    getAll(): Promise<object[]>
    getKeys(): Promise<string[]>
    getOldest(): Promise<object | null>
    /** Atomically claim a digest for delivery. Returns null if already claimed by another instance. */
    claimForDelivery(fingerprint: string): Promise<object | null>
    /** Release a delivery claim. */
    releaseClaim(fingerprint: string): Promise<void>
    /** No-op — Redis client lifecycle is managed externally. */
    close(): void
}
