const { createClient } = require('redis')
const { AlertRollup, scripts } = require('../index')

async function run () {
    // Setup Redis with required scripts
    const redis = createClient({
        url: 'redis://localhost:6379',
        scripts
    })
    await redis.connect()
    await redis.flushDb()

    // Two engine instances sharing Redis
    const engine1 = new AlertRollup({
        redis,
        fingerprint: (alert) => `${alert.service}:${alert.errorCode}`,
        digestInterval: 10000,
        onDigest: async (digest) => {
            console.log(`[ENGINE-1 DIGEST] ${digest.alertId}: ${digest.count}x`)
        }
    })

    const engine2 = new AlertRollup({
        redis,
        fingerprint: (alert) => `${alert.service}:${alert.errorCode}`,
        digestInterval: 10000,
        onDigest: async (digest) => {
            // Won't fire if engine1 already processed
            console.log(`[ENGINE-2 DIGEST] ${digest.alertId}: ${digest.count}x`)
        }
    })

    console.log('--- Sending alerts through both engines ---\n')

    await engine1.ingest({
        service: 'api-gateway',
        errorCode: 'RATE_LIMIT',
        message: 'Rate limit exceeded'
    })
    console.log('Engine 1: sent first alert')

    await engine2.ingest({
        service: 'api-gateway',
        errorCode: 'RATE_LIMIT',
        message: 'Rate limit exceeded'
    })
    console.log('Engine 2: sent duplicate (accumulates)')

    await engine1.ingest({
        service: 'api-gateway',
        errorCode: 'RATE_LIMIT',
        message: 'Rate limit exceeded'
    })
    console.log('Engine 1: sent another duplicate')

    console.log('\n--- Current digest state ---')
    const digest = await engine1.getDigest('api-gateway:RATE_LIMIT')
    console.log(`Count: ${digest?.count || 0}`)

    console.log('\n--- Acknowledging from engine 2 ---')
    await engine2.acknowledge('api-gateway:RATE_LIMIT', '1h')
    console.log('Acknowledged for 1 hour')

    console.log('\n--- Waiting for digest interval... ---')
    await new Promise(resolve => setTimeout(resolve, 12000))

    // Acknowledged alerts are suppressed
    console.log('\n--- Flushing manually to verify suppression ---')
    const flushed = await engine1.flush()
    console.log(`Flushed: ${flushed.flushed} (should be 0, alert is acknowledged)`)

    engine1.close()
    engine2.close()
    await redis.quit()
}

run().catch(console.error)
