const { AlertRollup, generateFingerprint, parseDuration } = require('../index')

describe('AlertRollup', () => {
    let engine

    afterEach(() => {
        if (engine) {
            engine.close()
            engine = null
        }
    })

    // ─── constructor ────────────────────────────────────────────────────────────

    describe('constructor', () => {
        it('should throw if onDigest is not provided', () => {
            expect(() => new AlertRollup({})).toThrow('onDigest callback is required')
        })

        it('should throw if onDigest is not a function', () => {
            expect(() => new AlertRollup({ onDigest: 'not-a-fn' })).toThrow('onDigest callback is required')
            expect(() => new AlertRollup({ onDigest: 42 })).toThrow('onDigest callback is required')
        })

        // was toBeInstanceOf only; tautological since it always passes when the constructor succeeds
        it('should initialise engine properties from provided options', () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 10000,
                digestThreshold: 25,
                immediateLimit: 2,
                maxSamples: 3,
                maxFingerprints: 500
            })
            expect(engine.digestIntervalMs).toBe(10000)
            expect(engine.digestThreshold).toBe(25)
            expect(engine.immediateLimit).toBe(2)
            expect(engine.maxSamples).toBe(3)
            expect(engine.maxFingerprints).toBe(500)
            expect(engine.isRunning).toBe(true)
        })

        // boundary test for digestInterval minimum
        it('should clamp digestInterval to minimum 1000ms when given a lower value', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 0 })
            expect(engine.digestIntervalMs).toBe(1000)
        })
    })

    // ─── ingest ─────────────────────────────────────────────────────────────────

    describe('ingest', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        it('should return first outcome on new alert', async () => {
            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('first')
            expect(result.fingerprint).toBe('test:ERR')
        })

        it('should return sample outcome on duplicate within immediateLimit', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('sample')
            expect(result.fingerprint).toBe('test:ERR')
        })

        // was toHaveBeenCalledTimes(1) only; did not verify arguments
        it('should call onFirst with the alert object and fingerprint on first occurrence', async () => {
            const onFirst = jest.fn()
            engine.close()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onFirst,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            const alert = { service: 'test', errorCode: 'ERR' }
            await engine.ingest(alert)
            expect(onFirst).toHaveBeenCalledTimes(1)
            expect(onFirst).toHaveBeenCalledWith(alert, 'test:ERR')
        })

        it('should throw if alert is not a plain object', async () => {
            await expect(engine.ingest(null)).rejects.toThrow('Alert must be a plain object')
            await expect(engine.ingest('string')).rejects.toThrow('Alert must be a plain object')
            await expect(engine.ingest([1, 2, 3])).rejects.toThrow('Alert must be a plain object')
        })

        it('should throw if fingerprint is empty string', async () => {
            await expect(engine.ingest({}, { fingerprint: '' })).rejects.toThrow('Fingerprint must be a non-empty string')
        })

        // explicit non-string fingerprint via options
        it('should throw if explicit options.fingerprint is not a string', async () => {
            await expect(engine.ingest({}, { fingerprint: 123 })).rejects.toThrow('Fingerprint must be a non-empty string')
            await expect(engine.ingest({}, { fingerprint: null })).rejects.toThrow('Fingerprint must be a non-empty string')
        })

        // boundary test: fingerprint length limit
        it('should throw if fingerprint exceeds 256 characters', async () => {
            const longFp = 'a'.repeat(257)
            await expect(engine.ingest({}, { fingerprint: longFp }))
                .rejects.toThrow('Fingerprint must not exceed 256 characters')
        })

        // boundary test: fingerprint at exact limit is accepted
        it('should accept a fingerprint of exactly 256 characters', async () => {
            const maxFp = 'a'.repeat(256)
            const result = await engine.ingest({ service: 'test' }, { fingerprint: maxFp })
            expect(result.outcome).toBe('first')
            expect(result.fingerprint).toBe(maxFp)
        })
    })

    // ─── skipFirst option ────────────────────────────────────────────────────────

    // skipFirst was completely untested
    describe('skipFirst option', () => {
        it('should not invoke onFirst when skipFirst is true', async () => {
            const onFirst = jest.fn()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onFirst,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            await engine.ingest({ service: 'svc', errorCode: 'E1' }, { skipFirst: true })
            expect(onFirst).not.toHaveBeenCalled()
        })

        it('should still return first outcome when skipFirst is true', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            const result = await engine.ingest({ service: 'svc', errorCode: 'E1' }, { skipFirst: true })
            expect(result.outcome).toBe('first')
        })
    })

    // ─── acknowledge ─────────────────────────────────────────────────────────────

    describe('acknowledge', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        it('should suppress ingests when fingerprint is acknowledged', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.acknowledge('test:ERR', '1h')
            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('suppressed')
        })

        // Regression: _ingestManual must respect stored acknowledgedUntil even
        // when the local in-memory Map entry is missing (e.g. after timer expiry
        // fires slightly early).
        it('should suppress ingests based on stored acknowledgedUntil without local map entry', async () => {
            const alert1 = { service: 'test', errorCode: 'ERR', msg: 'first' }
            const alert2 = { service: 'test', errorCode: 'ERR', msg: 'second' }

            await engine.ingest(alert1)
            await engine.acknowledge('test:ERR', '1h')

            // Simulate the local ack Map entry being cleared (as if the timer
            // fired early), while the stored acknowledgedUntil is still valid.
            engine.acknowledgments.delete('test:ERR')

            const result = await engine.ingest(alert2)
            expect(result.outcome).toBe('suppressed')
        })

        // Regression: suppressed ingests must still accumulate alert samples
        // up to maxSamples, consistent with the atomic Redis path.
        it('should accumulate samples for suppressed ingests', async () => {
            const alert1 = { service: 'test', errorCode: 'ERR', seq: 1 }
            const alert2 = { service: 'test', errorCode: 'ERR', seq: 2 }
            const alert3 = { service: 'test', errorCode: 'ERR', seq: 3 }

            await engine.ingest(alert1)
            await engine.acknowledge('test:ERR', '1h')
            await engine.ingest(alert2)
            await engine.ingest(alert3)

            const digest = await engine.getDigest('test:ERR')
            expect(digest.samples).toHaveLength(3)
            expect(digest.samples[0]).toEqual(expect.objectContaining({ seq: 1 }))
            expect(digest.samples[1]).toEqual(expect.objectContaining({ seq: 2 }))
            expect(digest.samples[2]).toEqual(expect.objectContaining({ seq: 3 }))
        })

        // was toBeGreaterThan(Date.now()); passes for any arbitrarily large future timestamp
        it('should set acknowledgedUntil to now plus the specified duration', async () => {
            const before = Date.now()
            const result = await engine.acknowledge('test-fp', '30m')
            const after = Date.now()
            const thirtyMinutesMs = 30 * 60 * 1000
            expect(result.fingerprint).toBe('test-fp')
            expect(result.acknowledgedUntil).toBeGreaterThanOrEqual(before + thirtyMinutesMs)
            expect(result.acknowledgedUntil).toBeLessThanOrEqual(after + thirtyMinutesMs)
        })

        // was .toThrow() with no message; any error would pass
        it('should throw with descriptive message on invalid duration format', async () => {
            await expect(engine.acknowledge('fp', 'invalid'))
                .rejects.toThrow('Duration format: "30m", "2h", "1d", or milliseconds number')
        })

        // error path: empty-string fingerprint
        it('should throw if fingerprint is an empty string', async () => {
            await expect(engine.acknowledge('', '30m'))
                .rejects.toThrow('Fingerprint must be a non-empty string')
        })

        // error path: non-string fingerprint
        it('should throw if fingerprint is not a string', async () => {
            await expect(engine.acknowledge(null, '30m')).rejects.toThrow('Fingerprint must be a non-empty string')
            await expect(engine.acknowledge(42, '30m')).rejects.toThrow('Fingerprint must be a non-empty string')
        })

        // numeric duration in milliseconds
        it('should accept a numeric duration in milliseconds', async () => {
            const before = Date.now()
            const result = await engine.acknowledge('fp', 5000)
            expect(result.acknowledgedUntil).toBeGreaterThanOrEqual(before + 5000)
        })
    })

    // ─── flush ──────────────────────────────────────────────────────────────────

    describe('flush', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        // was onDigest.toHaveBeenCalled(); did not verify what digest was passed
        it('should call onDigest with the correct digest when flushing a specific fingerprint', async () => {
            const onDigest = jest.fn()
            engine.close()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            const alert = { service: 'test', errorCode: 'ERR' }
            await engine.ingest(alert)
            const result = await engine.flush('test:ERR')
            expect(result.flushed).toBe(1)
            expect(onDigest).toHaveBeenCalledTimes(1)
            expect(onDigest).toHaveBeenCalledWith(expect.objectContaining({
                alertId: 'test:ERR',
                count: 1,
                samples: [alert]
            }))
        })

        it('should flush all digests when no fingerprint is given', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.ingest({ service: 'test2', errorCode: 'ERR2' })
            const result = await engine.flush()
            expect(result.flushed).toBe(2)
        })

        // non-existent fingerprint returns flushed: 0
        it('should return flushed 0 when the fingerprint has no digest record', async () => {
            const result = await engine.flush('nonexistent:FP')
            expect(result.flushed).toBe(0)
        })

        // Regression: falsy values (empty string, 0) are explicit fingerprints,
        // not omitted arguments. They must not fall through to flush-all.
        it('should treat empty string as an explicit fingerprint, not flush-all', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            // empty string is not undefined, so it should be treated as a
            // specific fingerprint lookup (no record exists for '')
            const result = await engine.flush('')
            expect(result.flushed).toBe(0)

            // flush-all (no argument) should still work and find the record
            const resultAll = await engine.flush()
            expect(resultAll.flushed).toBe(1)
        })

        it('should not flush an acknowledged fingerprint', async () => {
            const onDigest = jest.fn()
            engine.close()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.acknowledge('test:ERR', '1h')
            const result = await engine.flush('test:ERR')
            expect(result.flushed).toBe(0)
            expect(onDigest).not.toHaveBeenCalled()
        })

        // add objectContaining to verify onDigest received the correct digest
        it('should skip acknowledged fingerprints when flushing all', async () => {
            const onDigest = jest.fn()
            engine.close()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc1', errorCode: 'ERR' })
            await engine.ingest({ service: 'svc2', errorCode: 'ERR' })
            await engine.acknowledge('svc1:ERR', '1h')
            const result = await engine.flush()
            expect(result.flushed).toBe(1)
            expect(onDigest).toHaveBeenCalledTimes(1)
            expect(onDigest).toHaveBeenCalledWith(expect.objectContaining({ alertId: 'svc2:ERR' }))
        })

        // cross-instance acknowledgment via stored acknowledgedUntil field
        it('should respect stored acknowledgedUntil even without local in-memory ack', async () => {
            const onDigest = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })

            // Simulate a different instance having acknowledged: write acknowledgedUntil
            // directly to storage without setting the in-memory Map
            const existing = await engine.getDigest('test:ERR')
            await engine.storage.set('test:ERR', { ...existing, acknowledgedUntil: Date.now() + 3600000 }, Date.now() + 86400000)

            // Flush should skip this record because acknowledgedUntil is in the future
            const result = await engine.flush()
            expect(result.flushed).toBe(0)
            expect(onDigest).not.toHaveBeenCalled()
        })
    })

    // ─── getDigest ───────────────────────────────────────────────────────────────

    describe('getDigest', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        // was not.toBeNull(); now asserts full record shape
        it('should return the full digest record with correct shape after ingest', async () => {
            const alert = { service: 'test', errorCode: 'ERR' }
            const before = Date.now()
            await engine.ingest(alert)
            const after = Date.now()
            const digest = await engine.getDigest('test:ERR')
            expect(digest).toEqual(expect.objectContaining({
                alertId: 'test:ERR',
                count: 1,
                samples: [alert],
                acknowledgedUntil: null
            }))
            expect(digest.firstAt).toBeGreaterThanOrEqual(before)
            expect(digest.firstAt).toBeLessThanOrEqual(after)
            expect(digest.lastAt).toBe(digest.firstAt)
        })

        it('should return null for unknown fingerprint', async () => {
            const digest = await engine.getDigest('unknown:FP')
            expect(digest).toBeNull()
        })

        // verifies accumulation across multiple ingests
        it('should reflect updated count after multiple ingests', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const digest = await engine.getDigest('test:ERR')
            expect(digest.count).toBe(3)
        })
    })

    // ─── getMetrics ──────────────────────────────────────────────────────────────

    describe('getMetrics', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        // zero-state baseline
        it('should return all-zero metrics on an empty engine', async () => {
            const metrics = await engine.getMetrics()
            expect(metrics).toEqual({ totalFingerprints: 0, pendingDigests: 0, acknowledgedCount: 0, failedDeliveries: 0 })
        })

        // was missing acknowledgedCount assertion
        it('should return correct counts after ingest', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const metrics = await engine.getMetrics()
            expect(metrics.totalFingerprints).toBe(1)
            expect(metrics.pendingDigests).toBe(1)
            expect(metrics.acknowledgedCount).toBe(0)
        })

        // acknowledgedCount behavioral coverage
        it('should reflect acknowledgedCount when a fingerprint is actively acknowledged', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.acknowledge('test:ERR', '1h')
            const metrics = await engine.getMetrics()
            expect(metrics.acknowledgedCount).toBe(1)
        })

        // Regression: getMetrics must count fingerprints whose stored
        // acknowledgedUntil is in the future even without a local Map entry.
        it('should count stored acknowledgedUntil in acknowledgedCount without local map entry', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.acknowledge('test:ERR', '1h')

            // Clear the local Map to simulate a distributed scenario where
            // another instance performed the acknowledgment.
            engine.acknowledgments.delete('test:ERR')

            const metrics = await engine.getMetrics()
            expect(metrics.acknowledgedCount).toBe(1)
        })
    })

    // ─── custom fingerprint ──────────────────────────────────────────────────────

    describe('custom fingerprint', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                fingerprint: (alert) => alert.customId,
                digestInterval: 60000
            })
        })

        it('should use custom fingerprint function to group alerts', async () => {
            await engine.ingest({ customId: 'my-id', data: 'a' })
            await engine.ingest({ customId: 'my-id', data: 'b' })
            const digest = await engine.getDigest('my-id')
            expect(digest.count).toBe(2)
        })
    })

    // ─── auto resolve ─────────────────────────────────────────────────────────────

    describe('auto resolve', () => {
        // was await new Promise(r => setTimeout(r, 150)); flaky on slow CI
        // Now uses fake timers to control time deterministically
        it('should treat second occurrence as new first after silence exceeds autoResolveAfter', async () => {
            jest.useFakeTimers()
            const onResolve = jest.fn()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onResolve,
                autoResolveAfter: 5000,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            let result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('first')

            jest.advanceTimersByTime(6000)

            result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('first')
            expect(onResolve).toHaveBeenCalledTimes(1)
            expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ alertId: 'test:ERR' }))

            engine.close()
            jest.useRealTimers()
            engine = null
        })

        it('should continue as sample if within autoResolveAfter', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                autoResolveAfter: '10m',
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('sample')
        })
    })

    // ─── immediateLimit ──────────────────────────────────────────────────────────

    describe('immediateLimit', () => {
        it('should fire onFirst for first N alerts based on immediateLimit', async () => {
            const onFirst = jest.fn()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onFirst,
                immediateLimit: 4,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            for (let i = 0; i < 4; i++) {
                const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
                expect(result.outcome).toBe('first')
            }
            expect(onFirst).toHaveBeenCalledTimes(4)

            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('sample')
            expect(onFirst).toHaveBeenCalledTimes(4)
        })

        it('should default to 1 so only the first alert fires immediately', async () => {
            const onFirst = jest.fn()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onFirst,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            const result1 = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result1.outcome).toBe('first')

            const result2 = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result2.outcome).toBe('sample')

            expect(onFirst).toHaveBeenCalledTimes(1)
        })
    })

    // ─── digestThreshold ─────────────────────────────────────────────────────────

    // digestThreshold behavior was completely untested
    describe('digestThreshold', () => {
        it('should return digest outcome when count reaches digestThreshold', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestThreshold: 3,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            const result = await engine.ingest({ service: 'svc', errorCode: 'E1' })
            expect(result.outcome).toBe('digest')
            expect(result.fingerprint).toBe('svc:E1')
        })

        it('should call onDigest with the accumulated digest when threshold is reached', async () => {
            const onDigest = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestThreshold: 3,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.ingest({ service: 'svc', errorCode: 'E1' })

            expect(onDigest).toHaveBeenCalledTimes(1)
            expect(onDigest).toHaveBeenCalledWith(expect.objectContaining({
                alertId: 'svc:E1',
                count: 3
            }))
        })

        it('should delete the record after a threshold-triggered digest send', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestThreshold: 2,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            const digest = await engine.getDigest('svc:E1')
            expect(digest).toBeNull()
        })
    })

    // ─── maxSamples ──────────────────────────────────────────────────────────────

    // maxSamples behavior was completely untested
    describe('maxSamples', () => {
        it('should retain at most maxSamples raw alert objects per digest', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxSamples: 2,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            for (let i = 0; i < 5; i++) {
                await engine.ingest({ service: 'svc', errorCode: 'E1', seq: i })
            }

            const digest = await engine.getDigest('svc:E1')
            expect(digest.samples).toHaveLength(2)
            expect(digest.samples[0]).toEqual(expect.objectContaining({ seq: 0 }))
            expect(digest.samples[1]).toEqual(expect.objectContaining({ seq: 1 }))
        })
    })

    // ─── maxFingerprints ─────────────────────────────────────────────────────────

    // eviction replaces the old hard-throw behaviour
    describe('maxFingerprints', () => {
        it('should evict oldest non-acknowledged record when limit is reached', async () => {
            const onDigest = jest.fn()
            engine = new AlertRollup({
                onDigest,
                maxFingerprints: 2,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            await engine.ingest({ service: 'svc2', errorCode: 'E2' })

            // svc3 triggers eviction of svc1, which is the oldest record
            const result = await engine.ingest({ service: 'svc3', errorCode: 'E3' })
            expect(result.outcome).toBe('first')
            expect(result.fingerprint).toBe('svc3:E3')

            // svc1 should be evicted and its accumulated digest delivered
            expect(onDigest).toHaveBeenCalledTimes(1)
            expect(onDigest).toHaveBeenCalledWith(expect.objectContaining({ alertId: 'svc1:E1' }))

            // svc1 is gone; svc2 and svc3 remain
            expect(await engine.getDigest('svc1:E1')).toBeNull()
            expect(await engine.getDigest('svc2:E2')).not.toBeNull()
            expect(await engine.getDigest('svc3:E3')).not.toBeNull()
        })

        it('should return rejected outcome when all records are acknowledged and limit is reached', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxFingerprints: 1,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            await engine.acknowledge('svc1:E1', '1h')

            // svc2 can't be added because the only existing record is acknowledged
            const result = await engine.ingest({ service: 'svc2', errorCode: 'E2' })
            expect(result.outcome).toBe('rejected')
            expect(result.fingerprint).toBe('svc2:E2')

            // svc1 should still exist (was not evicted)
            expect(await engine.getDigest('svc1:E1')).not.toBeNull()
        })

        it('should allow ingesting an existing fingerprint when at limit', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxFingerprints: 1,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            const result = await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            expect(result.outcome).toBe('sample')
        })

        // maxFingerprints: 0 disables the limit
        it('should allow unlimited fingerprints when maxFingerprints is 0', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxFingerprints: 0,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            for (let i = 0; i < 5; i++) {
                await expect(
                    engine.ingest({ service: `svc${i}`, errorCode: 'E1' })
                ).resolves.toEqual(expect.objectContaining({ outcome: 'first' }))
            }
        })
    })

    // ─── close ──────────────────────────────────────────────────────────────────

    describe('close', () => {
        it('should throw on ingest after close', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.close()
            await expect(
                engine.ingest({ service: 'test', errorCode: 'ERR' })
            ).rejects.toThrow('AlertRollup has been closed')
            engine = null
        })

        it('should throw on acknowledge after close', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.close()
            await expect(
                engine.acknowledge('test:ERR', '30m')
            ).rejects.toThrow('AlertRollup has been closed')
            engine = null
        })

        it('should throw on flush after close', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.close()
            await expect(engine.flush()).rejects.toThrow('AlertRollup has been closed')
            await expect(engine.flush('fp')).rejects.toThrow('AlertRollup has been closed')
            engine = null
        })

        it('should be idempotent', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            engine.close()
            expect(() => engine.close()).not.toThrow()
            engine = null
        })

        // verify 'close' event fires before listeners are removed
        it('should emit close event before removing listeners', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            let closeFired = false
            engine.on('close', () => { closeFired = true })
            engine.close()
            expect(closeFired).toBe(true)
            engine = null
        })

        // getDigest must not throw after close (storage is cleared, returns null)
        it('should allow getDigest to be called after close without throwing', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            const alert = { service: 'test', errorCode: 'ERR' }
            await engine.ingest(alert)
            engine.close()
            // close() preserves storage data for post-shutdown inspection
            const digest = await engine.getDigest('test:ERR')
            expect(digest).not.toBeNull()
            expect(digest.alertId).toBe('test:ERR')
            engine = null
        })

        // getMetrics must not throw after close (returns all-zero snapshot)
        it('should allow getMetrics to be called after close without throwing', async () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            engine.close()
            const metrics = await engine.getMetrics()
            expect(metrics).toEqual({ totalFingerprints: 0, pendingDigests: 0, acknowledgedCount: 0, failedDeliveries: 0 })
            engine = null
        })
    })

    // ─── events ──────────────────────────────────────────────────────────────────

    // emitted events were completely untested (except 'error' via private method)
    describe('events', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        it('should emit first event with alert and fingerprint payload', async () => {
            const listener = jest.fn()
            engine.on('first', listener)
            const alert = { service: 'test', errorCode: 'ERR' }
            await engine.ingest(alert)
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener).toHaveBeenCalledWith(expect.objectContaining({
                alert,
                fingerprint: 'test:ERR'
            }))
        })

        it('should emit acknowledge event with fingerprint and until payload', async () => {
            const listener = jest.fn()
            engine.on('acknowledge', listener)
            const before = Date.now()
            await engine.acknowledge('test:ERR', '1h')
            expect(listener).toHaveBeenCalledTimes(1)
            const { fingerprint, until } = listener.mock.calls[0][0]
            expect(fingerprint).toBe('test:ERR')
            expect(until).toBeGreaterThanOrEqual(before + 60 * 60 * 1000)
        })

        it('should emit digestError event when the onDigest callback throws', async () => {
            const deliveryError = new Error('delivery failed')
            engine.close()
            engine = new AlertRollup({
                onDigest: jest.fn().mockRejectedValue(deliveryError),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            const listener = jest.fn()
            engine.on('digestError', listener)
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.flush('test:ERR')
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener.mock.calls[0][0].error).toBe(deliveryError)
        })

        it('should emit firstError event when the onFirst callback throws', async () => {
            const handlerError = new Error('first handler failed')
            engine.close()
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onFirst: jest.fn().mockRejectedValue(handlerError),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            const listener = jest.fn()
            engine.on('firstError', listener)
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener.mock.calls[0][0].error).toBe(handlerError)
        })

        it('should emit resolveError event when the onResolve callback throws', async () => {
            engine.close()
            jest.useFakeTimers()
            const resolveError = new Error('resolve handler failed')
            engine = new AlertRollup({
                onDigest: jest.fn(),
                onResolve: jest.fn().mockRejectedValue(resolveError),
                autoResolveAfter: 5000,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            const listener = jest.fn()
            engine.on('resolveError', listener)
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            jest.advanceTimersByTime(6000)
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener.mock.calls[0][0].error).toBe(resolveError)
            engine.close()
            jest.useRealTimers()
            engine = null
        })
    })

    // ─── error handling ──────────────────────────────────────────────────────────

    describe('error handling', () => {
        // frames as observable EventEmitter behavior, not just private method test
        it('should not throw when _emitSafeError is called with no error listener registered', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            expect(() => engine._emitSafeError(new Error('internal error'))).not.toThrow()
        })

        it('should emit the error to a registered error listener rather than throwing', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            const handler = jest.fn()
            engine.on('error', handler)
            engine._emitSafeError(new Error('test error'))
            expect(handler).toHaveBeenCalledTimes(1)
            expect(handler.mock.calls[0][0]).toBeInstanceOf(Error)
            expect(handler.mock.calls[0][0].message).toBe('test error')
        })

        it('should throw TypeError with context message when fingerprint function throws', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                fingerprint: () => { throw new Error('bad fp') },
                digestInterval: 60000
            })
            await expect(engine.ingest({ service: 'test' })).rejects.toThrow('Fingerprint function threw: bad fp')
        })

        // verify TypeError wrapping when inner error is also a TypeError
        it('should wrap TypeError from fingerprint function with context', async () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                fingerprint: () => { throw new TypeError('type issue') },
                digestInterval: 60000
            })
            await expect(engine.ingest({ service: 'test' }))
                .rejects.toThrow('Fingerprint function threw: type issue')
        })
    })

    // ─── config validation ──────────────────────────────────────────────────────

    describe('config validation', () => {
        it('should throw TypeError when onFirst is not a function', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                onFirst: 'not-a-fn'
            })).toThrow('onFirst must be a function')
        })

        it('should throw TypeError when onResolve is not a function', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                onResolve: 123
            })).toThrow('onResolve must be a function')
        })

        it('should throw TypeError when fingerprint is not a function', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                fingerprint: 'not-a-fn'
            })).toThrow('fingerprint must be a function')
        })

        it('should throw TypeError when ignoreFields is not an array', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                ignoreFields: 'not-an-array'
            })).toThrow('ignoreFields must be an array')
        })

        it('should throw TypeError when redis is not an object', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                redis: 'not-a-client'
            })).toThrow('redis must be a RedisClientType instance')
        })

        it('should accept valid options without throwing', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                onFirst: jest.fn(),
                onResolve: jest.fn(),
                fingerprint: (a) => a.id,
                ignoreFields: ['timestamp'],
                digestInterval: 60000
            })).not.toThrow()
        })

        // validateType treats null as "not provided" (early return), so
        // explicitly passing null for optional callbacks is allowed.
        it('should accept null for optional function options', () => {
            expect(() => new AlertRollup({
                onDigest: jest.fn(),
                onFirst: null,
                onResolve: null,
                fingerprint: null
            })).not.toThrow()
        })
    })

    // ─── listFingerprints / getAllDigests ────────────────────────────────────────

    describe('listFingerprints and getAllDigests', () => {
        beforeEach(() => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
        })

        it('should return empty arrays on an empty engine', async () => {
            const fps = await engine.listFingerprints()
            const all = await engine.getAllDigests()
            expect(fps).toEqual([])
            expect(all).toEqual([])
        })

        it('should list all active fingerprints after multiple ingests', async () => {
            await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            await engine.ingest({ service: 'svc2', errorCode: 'E2' })
            await engine.ingest({ service: 'svc3', errorCode: 'E3' })

            const fps = await engine.listFingerprints()
            expect(fps).toHaveLength(3)
            expect(fps).toContain('svc1:E1')
            expect(fps).toContain('svc2:E2')
            expect(fps).toContain('svc3:E3')
        })

        it('should return all digest records via getAllDigests', async () => {
            await engine.ingest({ service: 'svc1', errorCode: 'E1' })
            await engine.ingest({ service: 'svc2', errorCode: 'E2' })

            const all = await engine.getAllDigests()
            expect(all).toHaveLength(2)
            const ids = all.map(r => r.alertId).sort()
            expect(ids).toEqual(['svc1:E1', 'svc2:E2'])
        })

        it('should be callable after close with preserved data', async () => {
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            engine.close()

            const fps = await engine.listFingerprints()
            expect(fps).toEqual(['test:ERR'])

            const all = await engine.getAllDigests()
            expect(all).toHaveLength(1)
            expect(all[0].alertId).toBe('test:ERR')

            engine = null
        })
    })

    // ─── delivery retry and maxDeliveryAttempts ──────────────────────────────────

    describe('delivery retry and maxDeliveryAttempts', () => {
        it('should preserve record in storage when onDigest throws during flush', async () => {
            const deliveryError = new Error('delivery failed')
            const onDigest = jest.fn().mockRejectedValue(deliveryError)
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const result = await engine.flush('test:ERR')
            expect(result.flushed).toBe(0)

            // Record should still exist
            const digest = await engine.getDigest('test:ERR')
            expect(digest).not.toBeNull()
            expect(digest.count).toBe(1)
        })

        it('should increment deliveryAttempts on each failed delivery', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })

            // Flush 3 times, each should fail and increment attempts
            for (let i = 0; i < 3; i++) {
                await engine.flush('test:ERR')
                const digest = await engine.getDigest('test:ERR')
                expect(digest.deliveryAttempts).toBe(i + 1)
            }
        })

        it('should emit digestFailed when maxDeliveryAttempts is exceeded', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            const failedListener = jest.fn()
            engine = new AlertRollup({
                onDigest,
                maxDeliveryAttempts: 2,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.on('digestFailed', failedListener)

            await engine.ingest({ service: 'test', errorCode: 'ERR' })

            // Flush twice; both fail, the second reaches max attempts
            await engine.flush('test:ERR')
            await engine.flush('test:ERR')

            // Third flush: maxDeliveryAttempts exceeded, should emit digestFailed without calling onDigest again
            const onDigestCallsBefore = onDigest.mock.calls.length
            await engine.flush('test:ERR')
            expect(failedListener).toHaveBeenCalledTimes(1)
            expect(failedListener.mock.calls[0][0].digest.alertId).toBe('test:ERR')
            expect(failedListener.mock.calls[0][0].reason).toContain('max delivery attempts')
            // onDigest should NOT have been called a third time
            expect(onDigest).toHaveBeenCalledTimes(onDigestCallsBefore)

            // Record should still be preserved for inspection
            const digest = await engine.getDigest('test:ERR')
            expect(digest).not.toBeNull()
        })

        it('should report failedDeliveries in metrics', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            engine = new AlertRollup({
                onDigest,
                maxDeliveryAttempts: 2,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.flush('test:ERR')
            await engine.flush('test:ERR')

            const metrics = await engine.getMetrics()
            expect(metrics.failedDeliveries).toBe(1)
        })

        it('should not delete record on threshold-triggered digest delivery failure', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            engine = new AlertRollup({
                onDigest,
                digestThreshold: 3,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(result.outcome).toBe('digest')

            // Record should still exist because delivery failed
            const digest = await engine.getDigest('test:ERR')
            expect(digest).not.toBeNull()
            expect(digest.deliveryAttempts).toBe(1)
        })

        // When maxDeliveryAttempts is exhausted during a threshold-triggered
        // delivery, _deliverAndDelete emits digestFailed without calling onDigest.
        it('should emit digestFailed on threshold path when attempts exhausted', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            const failedListener = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestThreshold: 2,
                maxDeliveryAttempts: 1,
                digestInterval: 60000,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.on('digestFailed', failedListener)

            // First ingest: count=1
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            // Second ingest: threshold fires, delivery fails, attempts becomes 1
            // which equals maxDeliveryAttempts, but the check happens before
            // the increment, so delivery is still attempted.
            await engine.ingest({ service: 'test', errorCode: 'ERR' })
            expect(onDigest).toHaveBeenCalledTimes(1)

            // Third ingest: count=3, threshold fires again. Now
            // deliveryAttempts(1) >= maxDeliveryAttempts(1), so _deliverAndDelete
            // emits digestFailed without calling onDigest.
            await engine.ingest({ service: 'test', errorCode: 'ERR' })

            expect(failedListener).toHaveBeenCalledTimes(1)
            expect(failedListener.mock.calls[0][0].reason).toContain('max delivery attempts')
            // onDigest should still be at 1 (third ingest didn't call it)
            expect(onDigest).toHaveBeenCalledTimes(1)

            // Record preserved for inspection
            const digest = await engine.getDigest('test:ERR')
            expect(digest).not.toBeNull()
        })
    })

    // ─── maxDeliveryAttempts configuration ───────────────────────────────────────

    describe('maxDeliveryAttempts configuration', () => {
        it('should default to 3', () => {
            engine = new AlertRollup({ onDigest: jest.fn(), digestInterval: 60000 })
            expect(engine.maxDeliveryAttempts).toBe(3)
        })

        it('should accept a custom value', () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxDeliveryAttempts: 5,
                digestInterval: 60000
            })
            expect(engine.maxDeliveryAttempts).toBe(5)
        })

        it('should clamp to minimum 1', () => {
            engine = new AlertRollup({
                onDigest: jest.fn(),
                maxDeliveryAttempts: 0,
                digestInterval: 60000
            })
            expect(engine.maxDeliveryAttempts).toBe(1)
        })
    })

    // ─── digest loop (timer-driven delivery) ──────────────────────────────────

    // _processDueDigests is the core of the digest loop. These tests call it
    // directly to cover the claim/deliver/retry logic without depending on
    // setTimeout + fake timer interaction (unref() can behave oddly).
    describe('digest loop (_processDueDigests)', () => {
        it('should deliver pending digests and delete on success', async () => {
            const onDigest = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                immediateLimit: 1,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.ingest({ service: 'svc', errorCode: 'E1' })

            // Digest loop has not fired yet; directly invoke _processDueDigests
            await engine._processDueDigests()

            expect(onDigest).toHaveBeenCalledTimes(1)
            expect(onDigest).toHaveBeenCalledWith(expect.objectContaining({
                alertId: 'svc:E1',
                count: 2
            }))

            // Record should be deleted after successful delivery
            const digest = await engine.getDigest('svc:E1')
            expect(digest).toBeNull()
        })

        it('should skip acknowledged records', async () => {
            const onDigest = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                immediateLimit: 1,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine.acknowledge('svc:E1', '1h')
            await engine._processDueDigests()

            expect(onDigest).not.toHaveBeenCalled()
        })

        it('should preserve record when onDigest throws', async () => {
            const deliveryError = new Error('fail')
            const onDigest = jest.fn().mockRejectedValue(deliveryError)
            const digestErrorListener = jest.fn()
            engine = new AlertRollup({
                onDigest,
                digestInterval: 60000,
                immediateLimit: 1,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.on('digestError', digestErrorListener)

            await engine.ingest({ service: 'svc', errorCode: 'E1' })
            await engine._processDueDigests()

            expect(digestErrorListener).toHaveBeenCalledTimes(1)
            expect(digestErrorListener.mock.calls[0][0].error).toBe(deliveryError)

            // Record should be preserved and deliveryAttempts incremented
            const digest = await engine.getDigest('svc:E1')
            expect(digest).not.toBeNull()
            expect(digest.deliveryAttempts).toBe(1)
        })

        it('should emit digestFailed when maxDeliveryAttempts exhausted in loop', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            const failedListener = jest.fn()
            engine = new AlertRollup({
                onDigest,
                maxDeliveryAttempts: 2,
                digestInterval: 60000,
                immediateLimit: 1,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.on('digestFailed', failedListener)

            await engine.ingest({ service: 'svc', errorCode: 'E1' })

            // Two cycles, both fail (attempts reach 2)
            await engine._processDueDigests()
            await engine._processDueDigests()

            // Third cycle: attempts exhausted, should emit digestFailed
            await engine._processDueDigests()

            expect(failedListener).toHaveBeenCalledTimes(1)
            expect(failedListener.mock.calls[0][0].reason).toContain('max delivery attempts')
        })

        it('should emit digestFailed for exhausted records in a single cycle', async () => {
            const onDigest = jest.fn().mockRejectedValue(new Error('fail'))
            const failedListener = jest.fn()
            engine = new AlertRollup({
                onDigest,
                maxDeliveryAttempts: 1,
                digestInterval: 60000,
                immediateLimit: 1,
                fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
            })
            engine.on('digestFailed', failedListener)

            await engine.ingest({ service: 'svc', errorCode: 'E1' })

            // First cycle: delivery fails, attempts becomes 1
            await engine._processDueDigests()

            // Second cycle: attempts (1) >= maxDeliveryAttempts (1), digestFailed
            await engine._processDueDigests()

            expect(failedListener).toHaveBeenCalledTimes(1)
            expect(failedListener.mock.calls[0][0].digest.alertId).toBe('svc:E1')
        })
    })
})

// ─── generateFingerprint ─────────────────────────────────────────────────────

// generateFingerprint is exported but had zero tests
describe('generateFingerprint', () => {
    it('should produce the same hash regardless of key insertion order', () => {
        const a = generateFingerprint({ z: 1, a: 2, m: 3 })
        const b = generateFingerprint({ a: 2, m: 3, z: 1 })
        expect(a).toBe(b)
    })

    it('should produce different hashes for alerts with different field values', () => {
        const a = generateFingerprint({ service: 'svc-a', code: 500 })
        const b = generateFingerprint({ service: 'svc-b', code: 500 })
        expect(a).not.toBe(b)
    })

    it('should produce different hashes for alerts with different field names', () => {
        const a = generateFingerprint({ foo: 1 })
        const b = generateFingerprint({ bar: 1 })
        expect(a).not.toBe(b)
    })

    it('should exclude ignoreFields from the hash', () => {
        const base = generateFingerprint({ service: 'svc', timestamp: 1000 }, ['timestamp'])
        const different = generateFingerprint({ service: 'svc', timestamp: 9999 }, ['timestamp'])
        expect(base).toBe(different)
    })

    it('should include fields in the hash when they are not in ignoreFields', () => {
        const a = generateFingerprint({ service: 'svc', timestamp: 1000 })
        const b = generateFingerprint({ service: 'svc', timestamp: 9999 })
        expect(a).not.toBe(b)
    })

    it('should return a 64-character lowercase hex string', () => {
        const fp = generateFingerprint({ key: 'value' })
        expect(fp).toMatch(/^[0-9a-f]{64}$/)
    })

    it('should handle an empty alert object without throwing', () => {
        expect(() => generateFingerprint({})).not.toThrow()
        expect(generateFingerprint({})).toMatch(/^[0-9a-f]{64}$/)
    })
})

// ─── parseDuration ──────────────────────────────────────────────────────────

// parseDuration is exported but had zero tests
describe('parseDuration', () => {
    it('should return the number directly when given a numeric millisecond value', () => {
        expect(parseDuration(5000)).toBe(5000)
        expect(parseDuration(0)).toBe(0)
    })

    it('should convert ms suffix to milliseconds', () => {
        expect(parseDuration('500ms')).toBe(500)
        expect(parseDuration('1ms')).toBe(1)
    })

    it('should convert s suffix to milliseconds', () => {
        expect(parseDuration('30s')).toBe(30000)
        expect(parseDuration('1s')).toBe(1000)
    })

    it('should convert m suffix to milliseconds', () => {
        expect(parseDuration('5m')).toBe(300000)
        expect(parseDuration('30m')).toBe(1800000)
    })

    it('should convert h suffix to milliseconds', () => {
        expect(parseDuration('2h')).toBe(7200000)
        expect(parseDuration('1h')).toBe(3600000)
    })

    it('should convert d suffix to milliseconds', () => {
        expect(parseDuration('1d')).toBe(86400000)
        expect(parseDuration('7d')).toBe(604800000)
    })

    it('should throw TypeError with descriptive message for invalid format', () => {
        expect(() => parseDuration('invalid')).toThrow(TypeError)
        expect(() => parseDuration('invalid')).toThrow('Duration format')
    })

    it('should throw TypeError for unrecognised unit suffix', () => {
        expect(() => parseDuration('5w')).toThrow(TypeError)
        expect(() => parseDuration('10y')).toThrow(TypeError)
    })

    it('should throw TypeError for non-string non-number input', () => {
        expect(() => parseDuration(null)).toThrow(TypeError)
        expect(() => parseDuration({})).toThrow(TypeError)
        expect(() => parseDuration([])).toThrow(TypeError)
    })
})

// ─── InMemoryAdapter unit tests ─────────────────────────────────────────────

const { InMemoryAdapter } = require('../index')

describe('InMemoryAdapter', () => {
    let adapter

    beforeEach(() => {
        adapter = new InMemoryAdapter()
    })

    afterEach(() => {
        if (adapter && typeof adapter.close === 'function') {
            adapter.close()
        }
    })

    it('should return null for unknown fingerprint', async () => {
        const result = await adapter.get('nonexistent')
        expect(result).toBeNull()
    })

    it('should set and retrieve a record', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('test', record, Date.now() + 60000)
        const result = await adapter.get('test')
        expect(result).toEqual(record)
    })

    it('should clear the previous timer when set() is called again on same key', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('test', record, Date.now() + 60000)
        await adapter.set('test', { ...record, count: 2 }, Date.now() + 120000)
        // The second set should have cleared the first timer without error
        const result = await adapter.get('test')
        expect(result.count).toBe(2)
    })

    it('should delete a record and clear its timer', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('test', record, Date.now() + 60000)
        await adapter.delete('test')
        const result = await adapter.get('test')
        expect(result).toBeNull()
    })

    it('should return the correct count', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('a', record, Date.now() + 60000)
        await adapter.set('b', record, Date.now() + 60000)
        expect(await adapter.count()).toBe(2)
    })

    it('should return due digests filtered by timestamp', async () => {
        const record = { alertId: 'old', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        const futureExpiry = Date.now() + 60000
        await adapter.set('old', record, futureExpiry)
        await adapter.set('new', { ...record, alertId: 'new', lastAt: Date.now() + 99999999 }, futureExpiry)
        const due = await adapter.getDueDigests(Date.now())
        expect(due).toHaveLength(1)
        expect(due[0].alertId).toBe('old')
    })

    it('should return all records', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('a', record, Date.now() + 60000)
        await adapter.set('b', record, Date.now() + 60000)
        const all = await adapter.getAll()
        expect(all).toHaveLength(2)
    })

    it('should return all keys', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('a', record, Date.now() + 60000)
        await adapter.set('b', record, Date.now() + 60000)
        const keys = await adapter.getKeys()
        expect(keys).toHaveLength(2)
        expect(keys).toContain('a')
        expect(keys).toContain('b')
    })

    it('should return the oldest record by lastAt', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('middle', { ...record, alertId: 'middle', lastAt: 5000 }, Date.now() + 60000)
        await adapter.set('oldest', { ...record, alertId: 'oldest', lastAt: 1000 }, Date.now() + 60000)
        await adapter.set('newest', { ...record, alertId: 'newest', lastAt: 9000 }, Date.now() + 60000)
        const oldest = await adapter.getOldest()
        expect(oldest.alertId).toBe('oldest')
    })

    it('should return null from getOldest when empty', async () => {
        const oldest = await adapter.getOldest()
        expect(oldest).toBeNull()
    })

    it('should return record from claimForDelivery', async () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        await adapter.set('test', record, Date.now() + 60000)
        const claimed = await adapter.claimForDelivery('test')
        expect(claimed).toEqual(record)
    })

    it('should return null from claimForDelivery for unknown fingerprint', async () => {
        const claimed = await adapter.claimForDelivery('nonexistent')
        expect(claimed).toBeNull()
    })

    it('should not throw from releaseClaim (no-op)', async () => {
        await expect(adapter.releaseClaim('test')).resolves.toBeUndefined()
    })

    it('should clear all timers on close without throwing', () => {
        const record = { alertId: 'test', count: 1, firstAt: 1000, lastAt: 1000, samples: [], acknowledgedUntil: null }
        adapter.set('test', record, Date.now() + 60000)
        expect(() => adapter.close()).not.toThrow()
        // Data should be preserved after close
        expect(adapter.digests.has('test')).toBe(true)
    })
})

// ─── Redis adapter integration ──────────────────────────────────────────────

const { createClient } = require('redis')
const { scripts } = require('../index')

const maybeDescribe = process.env.CI || process.env.SKIP_REDIS
    ? describe.skip
    : describe

maybeDescribe('AlertRollup with Redis', () => {
    let redis
    let engine

    beforeAll(async () => {
        redis = createClient({ scripts })
        await redis.connect()
    })

    afterAll(async () => {
        if (engine) engine.close()
        if (redis && redis.isOpen) await redis.quit()
    })

    beforeEach(async () => {
        await redis.flushDb()
    })

    afterEach(() => {
        if (engine) {
            engine.close()
            engine = null
        }
    })

    it('should ingest and return first outcome via Redis', async () => {
        engine = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
        expect(result.outcome).toBe('first')
        expect(result.fingerprint).toBe('test:ERR')
    })

    it('should accumulate duplicates via Redis', async () => {
        engine = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        await engine.ingest({ service: 'test', errorCode: 'ERR' })
        const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
        expect(result.outcome).toBe('sample')

        const digest = await engine.getDigest('test:ERR')
        expect(digest.count).toBe(2)
    })

    it('should acknowledge and suppress via Redis', async () => {
        const onDigest = jest.fn()
        engine = new AlertRollup({
            redis,
            onDigest,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        await engine.ingest({ service: 'test', errorCode: 'ERR' })
        await engine.acknowledge('test:ERR', '1h')

        const result = await engine.ingest({ service: 'test', errorCode: 'ERR' })
        expect(result.outcome).toBe('suppressed')
    })

    it('should flush via Redis', async () => {
        const onDigest = jest.fn()
        engine = new AlertRollup({
            redis,
            onDigest,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        await engine.ingest({ service: 'test', errorCode: 'ERR' })
        const result = await engine.flush('test:ERR')
        expect(result.flushed).toBe(1)
        expect(onDigest).toHaveBeenCalledTimes(1)
    })

    it('should share state between two engine instances via Redis', async () => {
        const onDigest = jest.fn()
        const engine1 = new AlertRollup({
            redis,
            onDigest,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        const engine2 = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })

        await engine1.ingest({ service: 'test', errorCode: 'ERR' })
        await engine2.ingest({ service: 'test', errorCode: 'ERR' })

        const digest = await engine1.getDigest('test:ERR')
        expect(digest.count).toBe(2)

        engine2.close()
    })

    it('should respect cross-instance acknowledgment via Redis', async () => {
        const onDigest = jest.fn()
        const engine1 = new AlertRollup({
            redis,
            onDigest,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        const engine2 = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })

        await engine1.ingest({ service: 'test', errorCode: 'ERR' })
        await engine2.acknowledge('test:ERR', '1h')

        // engine1's flush should see the ack via Redis storage
        const result = await engine1.flush()
        expect(result.flushed).toBe(0)

        engine2.close()
    })

    it('should enforce maxFingerprints with eviction via Redis', async () => {
        const onDigest = jest.fn()
        engine = new AlertRollup({
            redis,
            onDigest,
            maxFingerprints: 2,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })

        await engine.ingest({ service: 'svc1', errorCode: 'E1' })
        await engine.ingest({ service: 'svc2', errorCode: 'E2' })

        const result = await engine.ingest({ service: 'svc3', errorCode: 'E3' })
        expect(result.outcome).toBe('first')
        expect(onDigest).toHaveBeenCalledTimes(1)
        // Either svc1 or svc2 is evicted (oldest by lastAt, order
        // depends on which record was inserted first in this ms).
        const evictedId = onDigest.mock.calls[0][0].alertId
        expect(['svc1:E1', 'svc2:E2']).toContain(evictedId)
    })

    it('should list fingerprints via Redis', async () => {
        engine = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })
        await engine.ingest({ service: 'svc1', errorCode: 'E1' })
        await engine.ingest({ service: 'svc2', errorCode: 'E2' })

        const fps = await engine.listFingerprints()
        expect(fps).toHaveLength(2)
        expect(fps).toContain('svc1:E1')
        expect(fps).toContain('svc2:E2')
    })

    it('should handle RedisAdapter rejection limit then retry after eviction', async () => {
        engine = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            maxFingerprints: 2,
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })

        await engine.ingest({ service: 'svc1', errorCode: 'E1' })
        await engine.ingest({ service: 'svc2', errorCode: 'E2' })
        await engine.acknowledge('svc1:E1', '1h')
        await engine.acknowledge('svc2:E2', '1h')

        const result = await engine.ingest({ service: 'svc3', errorCode: 'E3' })
        expect(result.outcome).toBe('rejected')
    })

    it('should auto-resolve atomically and call onResolve via Redis', async () => {
        const onResolve = jest.fn()
        const onFirst = jest.fn()
        engine = new AlertRollup({
            redis,
            onDigest: jest.fn(),
            onResolve,
            onFirst,
            autoResolveAfter: 1000, // resolve after 1s of silence
            digestInterval: 60000,
            fingerprint: (alert) => `${alert.service}:${alert.errorCode}`
        })

        const firstResult = await engine.ingest({ service: 'test', errorCode: 'ERR' })
        expect(firstResult.outcome).toBe('first')
        expect(onFirst).toHaveBeenCalledTimes(1)

        // Manually set the stored record's lastAt to be in the past so the
        // Lua script's auto-resolve check (now - lastAt > autoResolveAfterMs)
        // triggers on the next ingest.
        const existing = await engine.getDigest('test:ERR')
        await engine.storage.set('test:ERR', {
            ...existing,
            lastAt: Date.now() - 5000
        }, Date.now() + 60000)

        // The next ingest should auto-resolve (stale lastAt) and create a new record.
        const secondResult = await engine.ingest({ service: 'test', errorCode: 'ERR' })
        expect(secondResult.outcome).toBe('first')

        // onResolve should be called with the old record
        expect(onResolve).toHaveBeenCalledTimes(1)
        expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({
            alertId: 'test:ERR',
            count: 1
        }))

        // onFirst is called again for the new incident
        expect(onFirst).toHaveBeenCalledTimes(2)
    })
})
