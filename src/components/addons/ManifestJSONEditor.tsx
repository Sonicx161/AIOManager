import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { ChevronDown, Code2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AddonManifest } from '@/types/addon'
import { toast } from '@/hooks/use-toast'

interface ManifestJSONEditorProps {
    manifest: AddonManifest
    onSave: (manifest: AddonManifest) => Promise<void>
    /** Embedded presentation: always-expanded editor under a static
     * "Manifest JSON" heading, for surfaces that already provide the
     * disclosure around it (e.g. a tab). Default keeps the collapsible
     * "Advanced" card unchanged. */
    embedded?: boolean
}

export function ManifestJSONEditor({ manifest, onSave, embedded = false }: ManifestJSONEditorProps) {
    const [expanded, setExpanded] = useState(false)
    const [jsonText, setJsonText] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [dirty, setDirty] = useState(false)

    const originalJsonRef = useRef('')

    const lastManifestRef = useRef('')

    useEffect(() => {
        try {
            const serialized = JSON.stringify(manifest, null, 2)
            if (serialized !== lastManifestRef.current) {
                lastManifestRef.current = serialized
                originalJsonRef.current = serialized
            }
        } catch {
            originalJsonRef.current = '{}'
        }
    }, [manifest])

    const editorOpen = embedded || expanded

    useEffect(() => {
        if (editorOpen && !dirty) {
            setJsonText(originalJsonRef.current)
            setError(null)
        }
    }, [editorOpen, dirty, manifest])

    const handleChange = (value: string) => {
        setJsonText(value)
        setDirty(value !== originalJsonRef.current)
        setError(null)
    }

    const handleSave = async () => {
        let parsed: unknown
        try {
            parsed = JSON.parse(jsonText)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Invalid JSON')
            return
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            setError('Manifest must be a JSON object')
            return
        }

        const obj = parsed as Record<string, unknown>
        if (!obj.id || typeof obj.id !== 'string') {
            setError('Manifest must have a string "id" field')
            return
        }
        if (!obj.version || typeof obj.version !== 'string') {
            setError('Manifest must have a string "version" field')
            return
        }

        setSaving(true)
        try {
            await onSave(parsed as AddonManifest)
            setDirty(false)
            toast({ title: 'Manifest Updated', description: 'Advanced manifest changes saved.' })
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save manifest')
        } finally {
            setSaving(false)
        }
    }

    const handleReset = () => {
        setJsonText(originalJsonRef.current)
        setDirty(false)
        setError(null)
    }

    return (
        <div data-theme-part="panel" className="rounded-xl border border-border/40 bg-muted/20 overflow-hidden">
            {embedded ? (
                <div className="flex items-center gap-2 px-4 py-3">
                    <Code2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">Manifest JSON</span>
                    {dirty && (
                        <span className="h-2 w-2 rounded-full bg-primary" />
                    )}
                </div>
            ) : (
                <button
                    type="button"
                    data-theme-part="button"
                    onClick={() => setExpanded(!expanded)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/40"
                >
                    <div className="flex items-center gap-2">
                        <Code2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">Advanced</span>
                        {dirty && (
                            <span className="h-2 w-2 rounded-full bg-primary" />
                        )}
                    </div>
                    <ChevronDown className={cn(
                        'h-4 w-4 text-muted-foreground transition-transform',
                        expanded && 'rotate-180'
                    )} />
                </button>
            )}

            {editorOpen && (
                <div className="border-t border-border/40 p-4 space-y-3">
                    <textarea
                        data-theme-part="textarea"
                        value={jsonText}
                        onChange={(e) => handleChange(e.target.value)}
                        onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                e.preventDefault()
                                if (dirty && !saving) handleSave()
                            }
                        }}
                        spellCheck={false}
                        className="w-full h-80 rounded-lg border border-border/50 bg-background p-3 font-mono text-xs leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/30"
                        placeholder="{}"
                    />

                    {error && (
                        <div data-theme-tone="status" data-theme-part="panel" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                            <p className="text-xs text-destructive font-medium">{error}</p>
                        </div>
                    )}

                    <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                            Edit the raw manifest JSON. Apply saves it right away.
                        </p>
                        <div className="flex items-center gap-2">
                            <Tooltip content="Revert to original" side="top">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleReset}
                                    disabled={!dirty || saving}
                                    className="gap-1.5 text-xs"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    Reset
                                </Button>
                            </Tooltip>
                            <Button
                                type="button"
                                size="sm"
                                onClick={handleSave}
                                disabled={!dirty || saving}
                                className="gap-1.5 text-xs"
                            >
                                {saving ? 'Applying...' : 'Apply'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
