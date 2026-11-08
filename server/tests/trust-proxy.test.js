import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { fastifyTrustProxy } from '../admin/config.js'

const XFF = '6.6.6.6, 198.51.100.7, 203.0.113.9'

async function ipWith(env) {
    const saved = { TRUST_PROXY: process.env.TRUST_PROXY, TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS }
    Object.assign(process.env, { TRUST_PROXY: '', TRUST_PROXY_HOPS: '' }, env)
    try {
        const app = Fastify({ trustProxy: fastifyTrustProxy() })
        app.get('/', (request) => request.ip)
        const res = await app.inject({ url: '/', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': XFF } })
        return res.body
    } finally {
        for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
}

test('request.ip ignores forwarded headers by default', async () => {
    assert.equal(await ipWith({}), '172.18.0.5')
})

test('TRUST_PROXY_HOPS sets how many proxies request.ip trusts', async () => {
    assert.equal(await ipWith({ TRUST_PROXY_HOPS: '1' }), '203.0.113.9')
    assert.equal(await ipWith({ TRUST_PROXY_HOPS: '2' }), '198.51.100.7')
})

test('TRUST_PROXY=true still trusts every hop', async () => {
    assert.equal(await ipWith({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' }), '6.6.6.6')
})
