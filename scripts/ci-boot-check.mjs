import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const port = Number(process.env.BOOT_CHECK_PORT || 16199)
const base = `http://127.0.0.1:${port}`

const chromeCandidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const chrome = chromeCandidates.find(candidate => existsSync(candidate))
if (!chrome) {
    console.error('boot-check: no Chrome/Chromium found; set CHROME_BIN')
    process.exit(1)
}
if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('boot-check: dist/index.html missing; run npm run build first')
    process.exit(1)
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'aiom-boot-'))
const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
})
let serverErr = ''
server.stderr.on('data', chunk => { serverErr += chunk })

const fail = (message) => {
    console.error(`boot-check: ${message}`)
    if (serverErr) console.error(serverErr.slice(-4000))
    cleanup()
    process.exit(1)
}

function cleanup() {
    server.kill()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* Windows may hold the sqlite file briefly */ }
}

async function waitForHealth() {
    for (let attempt = 0; attempt < 120; attempt++) {
        if (server.exitCode !== null) fail(`server exited with code ${server.exitCode}`)
        try {
            const res = await fetch(`${base}/api/health`)
            if (res.ok) return
        } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    fail('server never became healthy')
}

await waitForHealth()

const index = await fetch(`${base}/`)
if (!index.ok) fail(`GET / returned ${index.status}`)
const html = await index.text()
const entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
if (!entry) fail('index.html has no entry script')
const asset = await fetch(`${base}${entry}`, { headers: { 'Accept-Encoding': 'br, gzip' } })
if (!asset.ok) fail(`entry chunk ${entry} returned ${asset.status}`)

const profile = mkdtempSync(path.join(tmpdir(), 'aiom-boot-chrome-'))
const browser = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const stopBrowser = () => {
    browser.kill()
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* profile lock */ }
}
const devtoolsPort = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('browser did not expose DevTools')), 30_000)
    browser.stderr.on('data', chunk => {
        buffer += chunk
        const match = buffer.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//)
        if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
}).catch(error => { stopBrowser(); fail(error.message) })

const pages = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
const page = pages.find(target => target.type === 'page')
if (!page) { stopBrowser(); fail('no page target in headless browser') }

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 0
const pending = new Map()
const exceptions = []
socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text)
    }
}
const send = (method, params = {}) => new Promise(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.navigate', { url: `${base}/` })

const probe = `JSON.stringify({
    children: document.getElementById('root')?.children.length || 0,
    bootError: document.getElementById('aio-boot-retry') ? document.body.innerText.slice(0, 300) : null,
    text: (document.getElementById('root')?.innerText || '').trim().length
})`
let state = { children: 0, bootError: null, text: 0 }
for (let attempt = 0; attempt < 90; attempt++) {
    const result = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
    try { state = JSON.parse(result.result?.result?.value || '{}') } catch { /* page navigating */ }
    if (state.bootError || (state.children > 0 && state.text > 0)) break
    await new Promise(resolve => setTimeout(resolve, 500))
}
socket.close()
stopBrowser()

if (state.bootError) fail(`the built app showed its startup failure screen: ${state.bootError.replace(/\s+/g, ' ')}`)
if (!(state.children > 0 && state.text > 0)) fail(`the built app did not render into #root${exceptions.length ? `: ${exceptions[0]}` : ''}`)

console.log(`boot-check: ok (entry ${entry}, ${asset.headers.get('content-encoding') || 'identity'})`)
cleanup()
process.exit(0)
