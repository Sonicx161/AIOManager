import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusChip } from '@/components/ui/status-chip'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { testHydraEndpoint } from '@/api/hydra-providers'
import { friendlyError } from './friendly-error'
import type { HydraDriverConfig, HydraStatus } from '@/types/provider'
import {
    Check,
    Globe,
    Loader2,
    AlertCircle,
    Shield,
    Plug,
} from 'lucide-react'
import { useState, useCallback, useRef } from 'react'
import { cn, maskUrlLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'

type WizardStep = 'details' | 'test' | 'confirm'

interface ProviderSetupDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onComplete: (config: HydraDriverConfig, credential: string) => void | Promise<void>
    onBackToPicker?: () => void
}

const AUTH_TYPES = [
    { value: 'api-key', label: 'API Key' },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'basic', label: 'Basic Auth' },
    { value: 'none', label: 'No Auth' },
] as const

const STEP_INDICATORS = [
    { step: 'details' as const, label: 'Details' },
    { step: 'test' as const, label: 'Test' },
    { step: 'confirm' as const, label: 'Confirm' },
]

export function ProviderSetupDialog({ open, onOpenChange, onComplete, onBackToPicker }: ProviderSetupDialogProps) {
    const [step, setStep] = useState<WizardStep>('details')
    const [name, setName] = useState('')
    const [baseUrl, setBaseUrl] = useState('')
    const [authType, setAuthType] = useState<HydraDriverConfig['authType']>('api-key')
    const [authValue, setAuthValue] = useState('')

    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<HydraStatus | null>(null)
    const [testError, setTestError] = useState<string | null>(null)

    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestGeneration = useRef(0)
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelUrls = useUIStore(s => s.privacyLevelUrls)
    const urlPrivacyLevel = isPrivacyModeEnabled ? privacyLevelUrls : 0

    const reset = useCallback(() => {
        requestGeneration.current += 1
        setStep('details')
        setName('')
        setBaseUrl('')
        setAuthType('api-key')
        setAuthValue('')
        setTestResult(null)
        setTestError(null)
        setTesting(false)
        setSubmitting(false)
        setError(null)
    }, [])

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) reset()
        onOpenChange(nextOpen)
    }

    // A result from a previous URL or credential must not survive an edit.
    const clearStaleTest = () => {
        setTestResult(null)
        setTestError(null)
    }

    const baseUrlValid = /^https?:\/\/.+/.test(baseUrl.trim())
    const nameValid = name.trim().length > 0
    const authNeeded = authType !== 'none'
    const authValid = !authNeeded || authValue.trim().length > 0
    const detailsValid = nameValid && baseUrlValid && authValid

    const handleTest = async () => {
        const generation = requestGeneration.current
        setTesting(true)
        setTestError(null)
        setTestResult(null)
        try {
            const result = await testHydraEndpoint(
                baseUrl.trim().replace(/\/+$/, ''),
                authType,
                authType === 'api-key' ? 'x-api-key' : authType === 'bearer' ? 'Authorization' : 'Authorization',
                authValue.trim(),
            )
            if (generation === requestGeneration.current) setTestResult(result)
        } catch (err) {
            if (generation === requestGeneration.current) setTestError(friendlyError(err, 'Connection test failed', 'The test could not run because AIOManager could not reach its own server. Check that the server is running, then test again.'))
        } finally {
            if (generation === requestGeneration.current) setTesting(false)
        }
    }

    const handleFinish = async () => {
        if (submitting) return
        const generation = requestGeneration.current
        setSubmitting(true)
        setError(null)
        const config: HydraDriverConfig = {
            name: name.trim(),
            baseUrl: baseUrl.trim().replace(/\/+$/, ''),
            authType,
            authHeader: authType === 'api-key' ? 'x-api-key' : authType === 'bearer' ? 'Authorization' : authType === 'basic' ? 'Authorization' : undefined,
        }
        try {
            await onComplete(config, authValue.trim())
            if (generation === requestGeneration.current) handleClose(false)
        } catch (e) {
            if (generation === requestGeneration.current) {
                setError(e instanceof Error ? e.message : 'Failed to add connection')
            }
        } finally {
            if (generation === requestGeneration.current) setSubmitting(false)
        }
    }

    const stepIndex = STEP_INDICATORS.findIndex(s => s.step === step)

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Add Hydra Connection</DialogTitle>
                    <DialogDescription>
                        Push addons to a Hydra-compatible server.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-center gap-2 mt-2">
                    {STEP_INDICATORS.map((s, i) => {
                        const active = s.step === step
                        const done = i < stepIndex
                        return (
                            <div key={s.step} className="flex items-center gap-2 flex-1">
                                <div
                                    className={cn(
                                        'flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold shrink-0 transition-colors',
                                        active ? 'bg-primary text-primary-foreground' :
                                        done ? 'bg-success/20 text-success' :
                                        'bg-muted text-muted-foreground'
                                    )}
                                >
                                    {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                                </div>
                                <span className={cn(
                                    'text-xs font-medium truncate',
                                    active ? 'text-foreground' : 'text-muted-foreground'
                                )}>
                                    {s.label}
                                </span>
                                {i < STEP_INDICATORS.length - 1 && (
                                    <div className={cn(
                                        'flex-1 h-px',
                                        done ? 'bg-success/40' : 'bg-border'
                                    )} />
                                )}
                            </div>
                        )
                    })}
                </div>

                <div className="min-h-[200px]">
                    {step === 'details' && (
                        <div className="space-y-4 mt-2">
                            <div className="space-y-2">
                                <Label htmlFor="hydra-name">Connection Name</Label>
                                <Input
                                    id="hydra-name"
                                    placeholder="e.g. My Media Server"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    autoFocus
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="hydra-url">Base URL</Label>
                                <Input
                                    id="hydra-url"
                                    placeholder="https://example.com"
                                    value={baseUrl}
                                    onChange={e => { setBaseUrl(e.target.value); clearStaleTest() }}
                                />
                                {baseUrl && !baseUrlValid && (
                                    <p className="text-xs text-destructive">Must start with http:// or https://</p>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label>Authentication</Label>
                                <Select value={authType} onValueChange={(v) => { setAuthType(v as HydraDriverConfig['authType']); clearStaleTest() }}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {AUTH_TYPES.map(t => (
                                            <SelectItem key={t.value} value={t.value}>
                                                {t.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {authNeeded && (
                                <div className="space-y-2">
                                    <Label htmlFor="hydra-auth-value">
                                        {authType === 'api-key' ? 'API Key' : authType === 'bearer' ? 'Bearer Token' : 'Credentials'}
                                    </Label>
                                    <Input
                                        id="hydra-auth-value"
                                        type="password"
                                        placeholder={authType === 'api-key' ? 'Enter API key' : authType === 'bearer' ? 'Enter bearer token' : 'user:password'}
                                        value={authValue}
                                        onChange={e => { setAuthValue(e.target.value); clearStaleTest() }}
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'test' && (
                        <div className="space-y-4 mt-2">
                            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card p-4 space-y-2">
                                <div className="flex items-center gap-2 text-sm">
                                    <Globe className="h-4 w-4 text-muted-foreground" />
                                    <span className="font-medium truncate">{name}</span>
                                </div>
                                <p className="text-xs text-muted-foreground truncate">{maskUrlLevel(baseUrl, urlPrivacyLevel)}</p>
                                <div className="flex items-center gap-2">
                                    <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-xs text-muted-foreground capitalize">{authType === 'api-key' ? 'API Key' : authType === 'bearer' ? 'Bearer' : authType === 'basic' ? 'Basic Auth' : 'No Auth'}</span>
                                </div>
                            </div>

                            {!testing && !testResult && !testError && (
                                <p className="text-sm text-muted-foreground text-center py-6">
                                    Click Test to verify the connection.
                                </p>
                            )}

                            {testing && (
                                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Testing connection...
                                </div>
                            )}

                            {testResult && (
                                <div data-theme-tone="status" data-theme-part="panel" className="rounded-2xl border border-success/30 bg-success/5 p-4 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <Check className="h-4 w-4 text-success" />
                                        <span className="text-sm font-semibold text-success">Connected</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        <div>
                                            <span className="text-muted-foreground">Name</span>
                                            <p className="font-medium">{testResult.name}</p>
                                        </div>
                                        <div>
                                            <span className="text-muted-foreground">Version</span>
                                            <p className="font-medium">{testResult.version}</p>
                                        </div>
                                    </div>
                                    {testResult.capabilities.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-1">
                                            {testResult.capabilities.map(cap => (
                                                <StatusChip key={cap} size="sm" className="text-xs h-5 px-2 bg-success/10 text-success border border-success/20">
                                                    {cap}
                                                </StatusChip>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {testError && (
                                <div data-theme-tone="status" data-theme-part="panel" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <AlertCircle className="h-4 w-4 text-destructive" />
                                        <span className="text-sm font-semibold text-destructive">Connection Failed</span>
                                    </div>
                                    <p className="text-xs text-destructive/80">{testError}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'confirm' && (
                        <div className="space-y-4 mt-2">
                            <p className="text-sm text-muted-foreground">Review your provider configuration before adding.</p>

                            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card p-4 space-y-3">
                                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                                    <span className="text-muted-foreground">Name</span>
                                    <span className="font-medium truncate">{name}</span>
                                    <span className="text-muted-foreground">URL</span>
                                    <span className="font-medium truncate">{maskUrlLevel(baseUrl, urlPrivacyLevel)}</span>
                                    <span className="text-muted-foreground">Auth</span>
                                    <span className="font-medium capitalize">{authType === 'api-key' ? 'API Key' : authType === 'bearer' ? 'Bearer Token' : authType === 'basic' ? 'Basic Auth' : 'None'}</span>
                                    {testResult && (
                                        <>
                                            <span className="text-muted-foreground">Version</span>
                                            <span className="font-medium">{testResult.version}</span>
                                        </>
                                    )}
                                </div>

                                {testResult && testResult.capabilities.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/40">
                                        {testResult.capabilities.map(cap => (
                                            <StatusChip key={cap} size="sm" className="text-xs h-5 px-2 bg-muted/50">
                                                {cap}
                                            </StatusChip>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-warning/10 border border-warning/20 px-3 py-2 text-xs text-warning flex items-start gap-2">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                <span>The credential is held on this device and stored encrypted on your sync server.</span>
                            </div>

                            {error && (
                                <div role="alert" data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/5 border border-destructive/20 px-3 py-2 text-xs text-destructive flex items-center gap-2">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                    {error}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    {onBackToPicker && !testing && !submitting && <Button variant="outline" onClick={() => { reset(); onBackToPicker() }}>Back to connection picker</Button>}
                    {step !== 'details' && (
                        <Button
                            variant="subtle"
                            onClick={() => {
                                if (step === 'confirm') setStep('test')
                                else if (step === 'test') setStep('details')
                            }}
                            disabled={testing || submitting}
                        >
                            Back
                        </Button>
                    )}

                    <div className="flex-1" />

                    {step === 'details' && (
                        <>
                            <Button variant="subtle" onClick={() => handleClose(false)}>Cancel</Button>
                            <Button
                                onClick={() => setStep('test')}
                                disabled={!detailsValid}
                            >
                                Next
                            </Button>
                        </>
                    )}

                    {step === 'test' && (
                        <>
                            <Button variant="subtle" onClick={() => handleClose(false)}>Cancel</Button>
                            <Button
                                variant="subtle"
                                onClick={handleTest}
                                disabled={testing || !detailsValid}
                            >
                                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                                {testing ? 'Testing...' : 'Test'}
                            </Button>
                            <Button
                                onClick={() => setStep('confirm')}
                                disabled={!testResult}
                            >
                                Next
                            </Button>
                        </>
                    )}

                    {step === 'confirm' && (
                        <Button
                            onClick={handleFinish}
                            disabled={submitting}
                        >
                            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            {submitting ? 'Adding...' : 'Add Connection'}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
