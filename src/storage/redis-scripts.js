const { defineScript } = require('redis')

/**
 * Atomic ingest: creates or updates a digest record.
 *
 * Uses a dedicated counter key (`alert-rollup:fp-count`) for O(1) fingerprint
 * counting instead of the blocking `KEYS` command. The counter is incremented
 * on record creation and decremented on explicit deletion. TTL-based expiry
 * may cause the counter to drift slightly above the true count over time, which
 * is conservative for the maxFingerprints limit.
 *
 * Auto-resolve is handled atomically inside the script: if the existing record
 * has been silent longer than `autoResolveAfterMs`, the old record is returned
 * with a 'resolved' status and the script recreates it as a new incident.
 * This prevents the TOCTOU race where another instance updates the record
 * between a separate read and the atomic ingest.
 *
 * Returns: ['new'|'existing'|'rejected'|'resolved', ...]
 *   'resolved': ['resolved', oldRecordJson, newRecordJson]
 */
const ingestScript = defineScript({
    NUMBER_OF_KEYS: 2,
    SCRIPT: `
        local recordKey = KEYS[1]
        local countKey = KEYS[2]
        local fingerprint = ARGV[1]
        local alertJson = ARGV[2]
        local now = tonumber(ARGV[3])
        local ttlMs = tonumber(ARGV[4])
        local maxSamples = tonumber(ARGV[5])
        local maxFingerprints = tonumber(ARGV[6])
        local autoResolveAfterMs = tonumber(ARGV[7])

        local existing = redis.call('GET', recordKey)

        if existing == false then
            if maxFingerprints > 0 then
                local current = tonumber(redis.call('GET', countKey) or '0')
                if current >= maxFingerprints then
                    return {'rejected', tostring(maxFingerprints)}
                end
            end

            redis.call('INCR', countKey)

            local record = cjson.encode({
                alertId = fingerprint,
                count = 1,
                firstAt = now,
                lastAt = now,
                samples = {cjson.decode(alertJson)},
                acknowledgedUntil = cjson.null,
                deliveryAttempts = 0
            })
            redis.call('SET', recordKey, record, 'PX', ttlMs)
            return {'new', record}
        end

        local data = cjson.decode(existing)

        -- Auto-resolve: if the record has been silent longer than the
        -- threshold, resolve it and recreate as a new incident. This is
        -- atomic with the ingest, avoiding the TOCTOU race with a
        -- separate get-then-delete sequence.
        if autoResolveAfterMs > 0 and (now - data.lastAt) > autoResolveAfterMs then
            local newRecord = cjson.encode({
                alertId = fingerprint,
                count = 1,
                firstAt = now,
                lastAt = now,
                samples = {cjson.decode(alertJson)},
                acknowledgedUntil = cjson.null,
                deliveryAttempts = 0
            })
            redis.call('SET', recordKey, newRecord, 'PX', ttlMs)
            -- Return old record for onResolve callback, and new record
            -- for the ingest result. Counter unchanged (record count same).
            return {'resolved', existing, newRecord}
        end

        data.count = data.count + 1
        data.lastAt = now
        data.deliveryAttempts = data.deliveryAttempts or 0

        if #data.samples < maxSamples then
            table.insert(data.samples, cjson.decode(alertJson))
        end

        local updated = cjson.encode(data)
        redis.call('SET', recordKey, updated, 'PX', ttlMs)
        return {'existing', updated}
    `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

/**
 * Atomically claims a digest record for delivery.
 * Sets a short-lived lock key to prevent duplicate delivery across instances.
 *
 * Returns: jsonString of the record if claimed, nil if already locked or absent.
 */
const claimDigestScript = defineScript({
    NUMBER_OF_KEYS: 2,
    SCRIPT: `
        local recordKey = KEYS[1]
        local lockKey = KEYS[2]
        local lockTtlMs = tonumber(ARGV[1])

        local existing = redis.call('GET', lockKey)
        if existing ~= false then
            return nil
        end

        local data = redis.call('GET', recordKey)
        if data == false then
            return nil
        end

        redis.call('SET', lockKey, '1', 'PX', lockTtlMs)
        return data
    `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

/**
 * Releases a delivery claim lock so another instance can retry.
 */
const releaseClaimScript = defineScript({
    NUMBER_OF_KEYS: 1,
    SCRIPT: `
        redis.call('DEL', KEYS[1])
        return 1
    `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

module.exports = {
    ingest: ingestScript,
    claimDigest: claimDigestScript,
    releaseClaim: releaseClaimScript
}
