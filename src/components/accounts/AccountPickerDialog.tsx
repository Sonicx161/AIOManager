import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAccountStore } from '@/store/accountStore'
import { User, Search, X } from 'lucide-react'
import { useState, useMemo } from 'react'
import { Input } from '@/components/ui/input'

interface AccountPickerDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description: string
    onConfirm: (accountIds: string[]) => Promise<void>
}

export function AccountPickerDialog({
    open,
    onOpenChange,
    title,
    description,
    onConfirm,
}: AccountPickerDialogProps) {
    const accounts = useAccountStore((state) => state.accounts)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [searchQuery, setSearchQuery] = useState('')
    const [loading, setLoading] = useState(false)

    const filteredAccounts = useMemo(() => {
        if (!searchQuery.trim()) return accounts
        return accounts.filter(acc =>
            acc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (acc.email && acc.email.toLowerCase().includes(searchQuery.toLowerCase()))
        )
    }, [accounts, searchQuery])

    const toggleAccount = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleSelectAll = () => {
        if (selectedIds.size === filteredAccounts.length) {
            setSelectedIds(new Set())
        } else {
            setSelectedIds(new Set(filteredAccounts.map(a => a.id)))
        }
    }

    const handleConfirm = async () => {
        setLoading(true)
        try {
            await onConfirm(Array.from(selectedIds))
            onOpenChange(false)
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search accounts..."
                            className="pl-10"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7"
                                onClick={() => setSearchQuery('')}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center justify-between px-2">
                        <Label className="text-xs font-medium text-muted-foreground">
                            {selectedIds.size} accounts selected
                        </Label>
                        <Button variant="link" size="sm" onClick={handleSelectAll} className="h-auto p-0 text-xs">
                            {selectedIds.size === filteredAccounts.length ? 'Deselect All' : 'Select All'}
                        </Button>
                    </div>

                    <ScrollArea className="h-64 rounded-md border p-2">
                        <div className="space-y-1">
                            {filteredAccounts.map((account) => (
                                <label
                                    key={account.id}
                                    className="flex items-center gap-3 p-2 hover:bg-muted/50 rounded-md cursor-pointer transition-colors"
                                >
                                    <Checkbox
                                        checked={selectedIds.has(account.id)}
                                        onCheckedChange={() => toggleAccount(account.id)}
                                    />
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                            <User className="h-4 w-4 text-primary" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                {account.emoji && <span className="text-base shrink-0">{account.emoji}</span>}
                                                <p className="text-sm font-medium truncate">{account.name}</p>
                                            </div>
                                            <p className="text-xs text-muted-foreground truncate">{account.email}</p>
                                        </div>
                                    </div>
                                </label>
                            ))}
                            {filteredAccounts.length === 0 && (
                                <div className="text-center py-8">
                                    <p className="text-sm text-muted-foreground">No accounts found</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={selectedIds.size === 0 || loading}>
                        Confirm Deployment
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
