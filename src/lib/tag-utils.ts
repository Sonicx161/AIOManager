export const TAG_PALETTE = [
    { bg: 'rgba(99,102,241,0.2)', text: '#a5b4fc', border: 'rgba(99,102,241,0.3)' },
    { bg: 'rgba(8,145,178,0.2)', text: '#67e8f9', border: 'rgba(8,145,178,0.3)' },
    { bg: 'rgba(5,150,105,0.2)', text: '#6ee7b7', border: 'rgba(5,150,105,0.3)' },
    { bg: 'rgba(217,119,6,0.2)', text: '#fcd34d', border: 'rgba(217,119,6,0.3)' },
    { bg: 'rgba(220,38,38,0.2)', text: '#fca5a5', border: 'rgba(220,38,38,0.3)' },
    { bg: 'rgba(124,58,237,0.2)', text: '#c4b5fd', border: 'rgba(124,58,237,0.3)' },
    { bg: 'rgba(219,39,119,0.2)', text: '#f9a8d4', border: 'rgba(219,39,119,0.3)' },
    { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.1)' },
]

export function getTagColor(tag: string) {
    let hash = 0
    for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash)
    return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length]
}
