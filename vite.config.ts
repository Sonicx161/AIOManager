import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from 'fumadocs-mdx/vite'
import * as MdxConfig from './source.config'
import path from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { visualizer } from 'rollup-plugin-visualizer'
import type { OutputChunk } from 'vite'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')
    const port = env.PORT || '16100'
    const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
    const buildCommit = process.env.GIT_COMMIT
        || (() => {
            try {
                return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
            } catch {
                return 'dev'
            }
        })()

    return {
        base: '/',
        // Without this, an unset NODE_ENV lets react-dom bundle its development build into production.
        define: {
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || mode),
            __BUILD_VERSION__: JSON.stringify(pkg.version),
            __BUILD_COMMIT__: JSON.stringify(buildCommit),
        },
        plugins: [
            ...(process.env.ANALYZE ? [visualizer({ json: true, filename: 'bundle-stats.json', gzipSize: true })] : []),
            {
                name: 'fix-fumadocs-glob',
                enforce: 'pre',
                transform(code, id) {
                    if (id.includes('.source/') && (id.endsWith('.ts') || id.endsWith('.js'))) {
                        let result = code;
                        
                        const baseMatch = result.match(/"base":\s*"(.*?)",/);
                        if (baseMatch) {
                            const base = baseMatch[1];
                            // Strip the base option
                            result = result.replace(/"base":\s*"(.*?)",\s*/g, '');
                            
                            // Smarter pattern replacement: match any quoted string inside import.meta.glob's array
                            // and prepend the base path if it starts with ./
                            result = result.replace(/import\.meta\.glob\(\s*\[([\s\S]*?)\],/g, (m, content) => {
                                const newContent = content.replace(/(['"])\.\/(.*?)\1/g, (m, quote, path) => {
                                    return `${quote}${base}/${path}${quote}`;
                                });
                                return `import.meta.glob([${newContent}],`;
                            });
                        }

                        if (result !== code) {
                            console.log(`[Vite Fix] Patched glob options in: ${id}`);
                            return {
                                code: result,
                                map: null,
                            };
                        }
                    }
                },
            },
            mdx(MdxConfig),
            react(),
            tailwindcss(),
            {
                // A static chunk cycle can evaluate a chunk before its imports exist and blank the app at boot.
                name: 'chunk-cycle-guard',
                apply: 'build',
                generateBundle(_options, bundle) {
                    const state = new Map<string, 'visiting' | 'done'>()
                    const visit = (fileName: string, trail: string[]) => {
                        const chunk = bundle[fileName]
                        if (chunk?.type !== 'chunk') return
                        if (state.get(fileName) === 'done') return
                        if (state.get(fileName) === 'visiting') {
                            const cycle = [...trail.slice(trail.indexOf(fileName)), fileName]
                            this.error(`Chunk import cycle: ${cycle.join(' -> ')}`)
                        }
                        state.set(fileName, 'visiting')
                        for (const dep of chunk.imports) visit(dep, [...trail, fileName])
                        state.set(fileName, 'done')
                    }
                    for (const fileName of Object.keys(bundle)) visit(fileName, [])
                },
            },
            {
                // Preload app code without evaluating it before storage migration finishes.
                name: 'boot-modulepreload',
                apply: 'build',
                generateBundle: {
                    order: 'post',
                    handler(_options, bundle) {
                        const htmlAsset = bundle['index.html']
                        if (!htmlAsset || htmlAsset.type !== 'asset' || typeof htmlAsset.source !== 'string') return
                        const appEntry = Object.values(bundle).find(
                            (c): c is OutputChunk => c.type === 'chunk' && c.name === 'app-entry'
                        )
                        if (!appEntry) return
                        const closure: string[] = []
                        const walk = (chunk: OutputChunk) => {
                            for (const dep of chunk.imports) {
                                const depChunk = bundle[dep]
                                if (depChunk?.type === 'chunk' && !closure.includes(depChunk.fileName)) {
                                    closure.push(depChunk.fileName)
                                    walk(depChunk)
                                }
                            }
                        }
                        const visit = (chunk: OutputChunk) => {
                            if (!closure.includes(chunk.fileName)) {
                                closure.push(chunk.fileName)
                                walk(chunk)
                            }
                        }
                        visit(appEntry)
                        // The HTML entry (main.tsx) unconditionally awaits every one of its
                        // dynamic imports before rendering (storage migration, then app-entry),
                        // so their fetch belongs in the preload set too: it removes a serial
                        // round trip on every cold boot without evaluating anything early.
                        for (const chunk of Object.values(bundle)) {
                            if (chunk?.type !== 'chunk' || !chunk.isEntry || chunk.name === 'app-entry') continue
                            for (const dyn of chunk.dynamicImports) {
                                const dynChunk = bundle[dyn]
                                if (dynChunk?.type === 'chunk') visit(dynChunk)
                            }
                        }
                        // The login screen is the most common cold destination, and its
                        // chunk (plus the radix/motion vendors it shares with the app
                        // shell) would otherwise only start fetching after app-entry
                        // evaluates - behind the webfonts on slow links. Ride along with
                        // the boot preload so the form lands with first paint.
                        const loginChunk = Object.values(bundle).find(
                            (c): c is OutputChunk =>
                                c.type === 'chunk' && !!c.facadeModuleId?.replace(/\\/g, '/').endsWith('src/pages/LoginPage.tsx')
                        )
                        const loginCss: string[] = []
                        if (loginChunk) {
                            visit(loginChunk)
                            loginCss.push(...(loginChunk.viteMetadata?.importedCss ?? []))
                        }
                        const tags = [...new Set(closure)].map(
                            (f) => `<link rel="modulepreload" crossorigin href="/${f}">`
                        )
                        // Match Vite's crossorigin mode so preloaded CSS reuses the same cache entry.
                        for (const css of [...(appEntry.viteMetadata?.importedCss ?? []), ...loginCss]) {
                            const tag = `<link rel="preload" href="/${css}" as="style" crossorigin>`
                            if (!tags.includes(tag)) tags.push(tag)
                        }
                        htmlAsset.source = htmlAsset.source.replace('</head>', `${tags.join('\n')}\n</head>`)
                    },
                },
            },
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        // Local mockups and validation pages are not application entry points.
        optimizeDeps: {
            entries: ['index.html'],
        },
        esbuild: {
            drop: ['console'],
        },
        build: {
            rollupOptions: {
                output: {
                    // Function form: same groupings as before, but package-scoped so
                    // rollup cannot stash shared modules (react/jsx-runtime,
                    // @radix-ui/react-slot) inside vendor-motion/vendor-radix, which
                    // dragged 90 KB gz of animation/radix into the boot preload.
                    manualChunks(id: string) {
                        const marker = 'node_modules'
                        const idx = id.lastIndexOf(marker)
                        if (idx === -1) return undefined
                        const rel = id.slice(idx + marker.length + 1).replace(/\\/g, '/')
                        const segs = rel.split('/')
                        const pkg = segs[0]?.startsWith('@') ? `${segs[0]}/${segs[1]}` : segs[0]
                        switch (pkg) {
                            case 'react':
                            case 'react-router-dom':
                            case 'clsx':
                            case 'tailwind-merge':
                            case 'scheduler':
                            case '@radix-ui/react-slot':
                                return 'vendor-react'
                            case 'react-dom':
                                // The server.edge builds belong to the lazy server-rendering
                                // chunk, never to the boot preload.
                                return /react-dom\/server|react-dom-server/.test(rel) ? undefined : 'vendor-react'
                            case 'framer-motion':
                                return 'vendor-motion'
                            case '@radix-ui/react-checkbox':
                            case '@radix-ui/react-select':
                            case '@radix-ui/react-tabs':
                            case '@radix-ui/react-tooltip':
                            case '@radix-ui/react-popover':
                            case '@radix-ui/react-alert-dialog':
                            case '@radix-ui/react-progress':
                            case '@radix-ui/react-scroll-area':
                                return 'vendor-radix'
                            case '@dnd-kit/core':
                            case '@dnd-kit/sortable':
                            case '@dnd-kit/utilities':
                            case '@dnd-kit/modifiers':
                                return 'vendor-dnd'
                            case 'date-fns':
                                return 'vendor-date'
                            case 'recharts':
                                return 'vendor-charts'
                            default:
                                return undefined
                        }
                    },
                }
            }
        },
        server: {
            host: true,
            proxy: {
                '/api': {
                    target: `http://127.0.0.1:${port}`,
                    // Preserve the browser Host for same-origin CSRF/origin checks on
                    // the local dashboard. The target is still loopback only.
                    changeOrigin: false,
                    secure: false,
                },
                '/addon': {
                    target: `http://127.0.0.1:${port}`,
                    changeOrigin: false,
                    secure: false,
                }
            }
        }
    }
})
