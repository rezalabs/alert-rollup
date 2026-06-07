const AlertRollup = require('./src/AlertRollup')
const InMemoryAdapter = require('./src/storage/InMemoryAdapter')
const RedisAdapter = require('./src/storage/RedisAdapter')
const scripts = require('./src/storage/redis-scripts')
const { generateFingerprint, parseDuration } = require('./src/fingerprint')

module.exports = AlertRollup
module.exports.AlertRollup = AlertRollup
module.exports.InMemoryAdapter = InMemoryAdapter
module.exports.RedisAdapter = RedisAdapter
module.exports.scripts = scripts
module.exports.generateFingerprint = generateFingerprint
module.exports.parseDuration = parseDuration
