const NON_TEXT_INPUT_TYPES = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']

export function textEntryFocused(): boolean {
    const el = document.activeElement as HTMLElement | null
    if (!el) return false
    if (el.isContentEditable) return true
    if (el.tagName === 'TEXTAREA') return true
    if (el.tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.includes((el as HTMLInputElement).type)
    return false
}

// Runs `open` after `delayMs`, or later once focus has settled outside every text field.
// During focusout the next field has not received focus yet, so the check waits a task.
export function openWhenNoTextEntry(open: () => void, delayMs: number): () => void {
    let disposed = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const onFocusOut = () => {
        if (settleTimer !== null) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
            settleTimer = null
            if (disposed || textEntryFocused()) return
            dispose()
            open()
        }, 0)
    }
    const timer = setTimeout(() => {
        if (disposed) return
        if (!textEntryFocused()) {
            disposed = true
            open()
            return
        }
        document.addEventListener('focusout', onFocusOut)
    }, delayMs)
    function dispose() {
        disposed = true
        clearTimeout(timer)
        if (settleTimer !== null) clearTimeout(settleTimer)
        document.removeEventListener('focusout', onFocusOut)
    }
    return dispose
}
