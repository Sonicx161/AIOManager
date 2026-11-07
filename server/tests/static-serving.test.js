process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-long!!'

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import fastifyStatic from '@fastify/static'

import { setupTestEnv, cleanupTestEnv } from './helpers.js'

let app
let tmpRoot

before(async () => {
    app = await setupTestEnv()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aioman-static-'))
    fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<!DOCTYPE html><html><head><title>AIOManager</title></head><body><div id="root"></div></body></html>')
    fs.writeFileSync(path.join(tmpRoot, 'app.js'), 'console.log("ok")')

    await app.register(fastifyStatic, {
        root: tmpRoot,
        prefix: '/',
        setHeaders: (reply, filePath) => {
            if (filePath.endsWith('.html')) reply.header('Cache-Control', 'no-cache')
        },
    })

    app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api')) {
            reply.status(404)
            return { error: `API route ${request.method}:${request.url} not found` }
        }
        reply.header('Cache-Control', 'no-cache')
        return reply.sendFile('index.html')
    })

    await app.ready()
})

after(() => {
    cleanupTestEnv()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('GET / serves the SPA index as HTML (static serving does not throw)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200, `body: ${res.body.slice(0, 200)}`)
    assert.ok(res.headers['content-type'].includes('text/html'), `content-type: ${res.headers['content-type']}`)
    assert.ok(res.body.includes('<div id="root">'))
})

test('html responses carry no-cache or equivalent revalidation directives', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    const cc = res.headers['cache-control'] || ''
    assert.ok(
        cc.includes('no-cache') || cc.includes('no-store') || cc.includes('max-age=0'),
        `expected revalidation directive on html, got: ${cc || 'none'}`
    )
})

test('unknown SPA routes fall back to index.html while /api 404s stay JSON', async () => {
    const spa = await app.inject({ method: 'GET', url: '/accounts' })
    assert.equal(spa.statusCode, 200)
    assert.ok(spa.headers['content-type'].includes('text/html'))

    const api = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' })
    assert.equal(api.statusCode, 404)
    assert.equal(api.json().error, 'API route GET:/api/definitely-not-a-route not found')
})

test('non-HTML static assets serve without the no-cache header', async () => {
    const res = await app.inject({ method: 'GET', url: '/app.js' })
    assert.equal(res.statusCode, 200)
    assert.notEqual(res.headers['cache-control'], 'no-cache')
})

test('main.js static setHeaders matches the installed @fastify/static callback contract', async () => {
    // @fastify/static 9 passed Node's ServerResponse (setHeader); 10 passes the
    // Fastify reply (header). Calling the wrong API throws on every static
    // response over a real socket while /api/health stays green, so the SPA
    // hangs behind a passing health check. inject cannot reproduce the socket
    // path, so this pins the registration source to the installed major.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../node_modules/@fastify/static/package.json'), 'utf8'))
    const major = Number(pkg.version.split('.')[0])
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../main.js'), 'utf8')
    const m = source.match(/setHeaders:\s*\((\w+),\s*\w+\)\s*=>\s*\{[\s\S]*?\n\s*\}/)
    assert.ok(m, 'static setHeaders registration not found in server/main.js')
    const [body, param] = m
    if (major >= 10) {
        assert.ok(body.includes(`${param}.header(`), `@fastify/static ${pkg.version} passes a Fastify reply: setHeaders must call ${param}.header()`)
        assert.ok(!body.includes('.setHeader('), `@fastify/static ${pkg.version} passes a Fastify reply: setHeader() does not exist on it`)
    } else {
        assert.ok(body.includes(`${param}.setHeader(`), `@fastify/static ${pkg.version} passes a raw ServerResponse: setHeaders must call ${param}.setHeader()`)
    }
})
