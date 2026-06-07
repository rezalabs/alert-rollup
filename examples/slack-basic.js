const { AlertRollup } = require('../index')

// Simulate a Slack webhook
async function sendToSlack (message) {
    console.log(`[SLACK] ${message}`)
}

const engine = new AlertRollup({
    // Group alerts by service + error code
    fingerprint: (alert) => `${alert.service}:${alert.errorCode}`,
    ignoreFields: ['timestamp', 'requestId', 'traceId'],

    // First alert fires immediately
    onFirst: async (alert, fingerprint) => {
        await sendToSlack(`🚨 *${alert.service}* - ${alert.errorCode}: ${alert.message}`)
    },

    // Then batch into digests every 30 seconds (5 min in production)
    digestInterval: 30000,
    digestThreshold: 5,

    onDigest: async (digest) => {
        const minutes = Math.round((digest.lastAt - digest.firstAt) / 60000 * 10) / 10
        await sendToSlack(
            `📊 *${digest.alertId}* fired ${digest.count}x in ${minutes}m\n` +
            `   First: ${new Date(digest.firstAt).toISOString()}\n` +
            `   Last: ${new Date(digest.lastAt).toISOString()}`
        )
    }
})

async function simulate () {
    console.log('--- Simulating alert storm ---\n')

    // Same error happening repeatedly
    for (let i = 0; i < 10; i++) {
        const result = await engine.ingest({
            service: 'auth-service',
            errorCode: 'DB_TIMEOUT',
            message: 'Database connection timeout',
            severity: 'critical',
            timestamp: Date.now(),
            requestId: `req-${Math.random().toString(36).slice(2)}`
        })
        console.log(`Alert ${i + 1}: ${result.outcome}`)
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log('\n--- Developer acknowledges the alert (30s suppression) ---')
    await engine.acknowledge('auth-service:DB_TIMEOUT', '30s')
    console.log('Acknowledged for 30 seconds')

    console.log('\n--- More alerts while acknowledged ---')
    for (let i = 0; i < 3; i++) {
        const result = await engine.ingest({
            service: 'auth-service',
            errorCode: 'DB_TIMEOUT',
            message: 'Database connection timeout',
            severity: 'critical',
            timestamp: Date.now()
        })
        console.log(`Alert ${i + 1}: ${result.outcome}`)
    }

    console.log('\n--- Waiting for digest interval (30s)... ---')
    await new Promise(resolve => setTimeout(resolve, 35000))

    console.log('\n--- Metrics ---')
    const metrics = await engine.getMetrics()
    console.log(metrics)

    engine.close()
}

simulate().catch(console.error)
