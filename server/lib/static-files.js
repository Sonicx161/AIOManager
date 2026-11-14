import path from 'node:path'

export function resolveLogoSource(distPath, staticEnabled, exists, p = path) {
    const distLogo = p.join(distPath, 'logo.png')
    if (staticEnabled && exists(distLogo)) return { kind: 'dist', file: distLogo }
    const publicLogo = p.join(p.dirname(distPath), 'public', 'logo.png')
    if (exists(publicLogo)) return { kind: 'public', file: publicLogo }
    return { kind: 'none', file: null }
}

export function isLongLivedRootAsset(root, filePath, p = path) {
    const parts = p.relative(root, filePath).split(p.sep)
    if (parts[0] === '..' || p.isAbsolute(parts[0])) return false
    return parts[0] === 'fonts' || (parts.length === 1 && /\.(png|svg|ico)$/.test(parts[0]))
}
