import { useState } from 'react'
import { useVaultStore } from '@/store/vaultStore'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Key,
    Plus,
    Trash2,
    Lock,
    Unlock,
    AlertCircle,
    ExternalLink,
    ShieldCheck,
    MoreVertical,
    Edit2,
    Clock,
    Copy,
    ChevronUp,
    ChevronDown
} from 'lucide-react'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { VaultProvider, VaultKey } from '@/types/vault'
import { toast } from '@/hooks/use-toast'
import { getTimeAgo } from '@/lib/utils'

import { PROVIDERS } from '@/lib/constants'

export function VaultSettings() {
    const { keys, addKey, removeKey, updateKey, moveKey, loading } = useVaultStore()
    const encryptionKey = useAuthStore((s) => s.encryptionKey)

    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingKey, setEditingKey] = useState<VaultKey | null>(null)
    const [deleteConfirmation, setDeleteConfirmation] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: '', name: '' })

    const [name, setName] = useState('')
    const [provider, setProvider] = useState<VaultProvider>('torbox')
    const [value, setValue] = useState('')

    const handleOpenAdd = () => {
        setEditingKey(null)
        setName('')
        setProvider('torbox')
        setValue('')
        setIsDialogOpen(true)
    }

    const handleOpenEdit = (key: VaultKey) => {
        setEditingKey(key)
        setName(key.name)
        setProvider(key.provider)
        setValue(key.value)
        setIsDialogOpen(true)
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        try {
            if (editingKey) {
                await updateKey(editingKey.id, { name, provider, value })
                toast({ title: 'Key Updated', description: `${name} has been updated in your vault.` })
            } else {
                await addKey({ name, provider, value })
                toast({ title: 'Key Added', description: `${name} has been added to your secure vault.` })
            }
            setIsDialogOpen(false)
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Vault Error',
                description: 'Failed to save key. Ensure your vault is unlocked.'
            })
        }
    }

    const handleDelete = async (id: string, name: string) => {
        setDeleteConfirmation({ open: true, id, name })
    }

    const confirmDelete = async () => {
        const { id, name } = deleteConfirmation
        await removeKey(id)
        toast({ title: 'Key Removed', description: `${name} has been deleted from your vault.` })
        setDeleteConfirmation({ open: false, id: '', name: '' })
    }

    if (!encryptionKey) {
        return (
            <section className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <Lock className="h-5 w-5 text-primary" />
                        Zero-Knowledge Key Vault
                    </h2>
                    <p className="text-sm text-muted-foreground">Encrypted locally on this device.</p>
                </div>
                <div className="p-8 rounded-xl border border-dashed border-primary/30 bg-primary/5 flex flex-col items-center justify-center text-center space-y-4">
                    <div className="p-4 rounded-full bg-primary/10">
                        <Lock className="h-8 w-8 text-primary" />
                    </div>
                    <div className="space-y-1">
                        <h3 className="font-semibold">Vault is Locked</h3>
                        <p className="text-sm text-muted-foreground max-w-sm">
                            Your keys are encrypted locally. Please unlock the app with your master password to access the vault.
                        </p>
                    </div>
                </div>
            </section>
        )
    }

    return (
        <section className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <Unlock className="h-5 w-5 text-green-500" />
                        Zero-Knowledge Key Vault
                    </h2>
                    <p className="text-sm text-muted-foreground">Encrypted locally on this device.</p>
                </div>
                <Button size="sm" onClick={handleOpenAdd} className="bg-primary/10 text-primary hover:bg-primary/20 border-none shadow-none">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Key
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {keys.length === 0 ? (
                    <div className="col-span-full p-12 rounded-xl border border-dashed bg-muted/30 flex flex-col items-center justify-center text-center space-y-3">
                        <Key className="h-8 w-8 text-muted-foreground opacity-50" />
                        <p className="text-sm text-muted-foreground italic">No keys stored in your vault yet.</p>
                    </div>
                ) : (
                    keys.map((key, index) => (
                        <div key={key.id} className="p-4 rounded-xl border bg-card hover:border-primary/50 transition-all group relative">
                            <div className="flex flex-col gap-1.5 relative z-10 w-full mb-1">
                                <div className="flex items-center justify-between w-full h-8">
                                    <div className="flex items-center gap-3 min-w-0 h-full">
                                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary shrink-0 flex items-center justify-center">
                                            <ShieldCheck className="h-5 w-5" />
                                        </div>
                                        <h3 className="font-bold text-sm tracking-tight truncate leading-none">{key.name}</h3>
                                    </div>

                                    <div className="flex items-center gap-1 shrink-0 h-full">
                                        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity h-full">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                disabled={index === 0}
                                                onClick={() => moveKey(key.id, 'up')}
                                                title="Move Up"
                                            >
                                                <ChevronUp className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                disabled={index === keys.length - 1}
                                                onClick={() => moveKey(key.id, 'down')}
                                                title="Move Down"
                                            >
                                                <ChevronDown className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
                                                    <MoreVertical className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground opacity-70">
                                                    MANAGE KEY
                                                </div>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem onClick={() => handleOpenEdit(key)}>
                                                    <Edit2 className="h-4 w-4 mr-2" />
                                                    Edit
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                                                    onClick={() => handleDelete(key.id, key.name)}
                                                >
                                                    <Trash2 className="h-4 w-4 mr-2" />
                                                    Delete
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 pl-[44px]">
                                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                        {key.provider}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <Clock className="h-2.5 w-2.5" />
                                        {getTimeAgo(new Date(key.updatedAt))}
                                    </span>
                                </div>
                            </div>

                            <div className="mt-4 flex items-center gap-2">
                                <div className="flex-1 bg-muted/50 rounded-lg px-3 py-1.5 flex items-center justify-between border border-white/5">
                                    <span className="font-mono text-xs text-muted-foreground truncate max-w-[150px]">
                                        ••••••••••••••••
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-muted-foreground hover:text-primary"
                                        onClick={() => {
                                            navigator.clipboard.writeText(key.value)
                                            toast({ title: 'Copied', description: 'Key copied to clipboard' })
                                        }}
                                    >
                                        <Copy className="h-3 w-3" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{editingKey ? 'Edit Key' : 'Add New Key'}</DialogTitle>
                        <DialogDescription>
                            Your key will be encrypted using AES-256-GCM before being saved.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleSubmit} className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label htmlFor="v-provider">Provider</Label>
                            <Select value={provider} onValueChange={(v: VaultProvider) => setProvider(v)}>
                                <SelectTrigger id="v-provider">
                                    <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    {PROVIDERS.map((p) => (
                                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="v-name">Display Name</Label>
                            <Input
                                id="v-name"
                                placeholder={`e.g. My ${PROVIDERS.find(p => p.value === provider)?.label || 'Main'} Account`}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                className="bg-background/50"
                            />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label htmlFor="v-value">API Key / Token</Label>
                                {PROVIDERS.find(p => p.value === provider)?.url && (
                                    <a
                                        href={PROVIDERS.find(p => p.value === provider)?.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[10px] text-primary hover:underline flex items-center gap-1"
                                    >
                                        Get Token <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                )}
                            </div>
                            <Input
                                id="v-value"
                                type="password"
                                placeholder="Paste your key here"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                required
                                className="bg-background/50 font-mono text-sm"
                            />
                        </div>
                        <div className="bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg flex gap-3 text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                            <p className="text-[10px] leading-relaxed">
                                Once saved, this key is only viewable after unlocking with your Master Password.
                                It is never sent to our servers in plain text.
                            </p>
                        </div>
                        <DialogFooter>
                            <Button type="submit" disabled={loading}>
                                {editingKey ? 'Update' : 'Save'} Securely
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            <ConfirmationDialog
                open={deleteConfirmation.open}
                onOpenChange={(open) => setDeleteConfirmation(prev => ({ ...prev, open }))}
                title="Remove Key"
                description={`Are you sure you want to remove "${deleteConfirmation.name}" from your vault? This cannot be undone.`}
                confirmText="Remove"
                isDestructive={true}
                isLoading={loading}
                onConfirm={confirmDelete}
            />
        </section>
    )
}
