const crypto = require('crypto')

/**
 * Generates a stable SHA256 fingerprint from an alert object.
 *
 * Keys are sorted before hashing so insertion order does not affect the
 * result. Fields listed in `ignoreFields` are excluded from the hash,
 * allowing timestamps and request IDs to vary without creating new
 * fingerprints.
 *
 * @param {object} alert - The alert object to fingerprint.
 * @param {string[]} [ignoreFields=[]] - Field names to exclude from the hash.
 * @returns {string} A 64-character lowercase hex string.
 */
function generateFingerprint (alert, ignoreFields = []) {
    const filtered = {}
    for (const key of Object.keys(alert).sort()) {
        if (!ignoreFields.includes(key)) {
            filtered[key] = alert[key]
        }
    }
    const str = JSON.stringify(filtered)
    return crypto.createHash('sha256').update(str).digest('hex')
}

/**
 * Parses a duration value to milliseconds.
 *
 * Accepts a number (passthrough, treated as milliseconds) or a string in
 * the format `{value}{unit}` where unit is `ms`, `s`, `m`, `h`, or `d`.
 *
 * @param {string|number} duration - Duration string or milliseconds number.
 * @returns {number} Milliseconds.
 * @throws {TypeError} If the duration is not a number or a valid string.
 */
function parseDuration (duration) {
    if (typeof duration === 'number') return duration
    if (typeof duration !== 'string') throw new TypeError('Duration must be a number (ms) or string like "30m"')

    const match = duration.match(/^(\d+)(ms|s|m|h|d)$/)
    if (!match) throw new TypeError('Duration format: "30m", "2h", "1d", or milliseconds number')

    const [, num, unit] = match
    const n = parseInt(num, 10)
    switch (unit) {
        case 'ms': return n
        case 's': return n * 1000
        case 'm': return n * 60 * 1000
        case 'h': return n * 60 * 60 * 1000
        case 'd': return n * 24 * 60 * 60 * 1000
        default: throw new TypeError(`Unrecognised duration unit: ${unit}`)
    }
}

module.exports = { generateFingerprint, parseDuration }
