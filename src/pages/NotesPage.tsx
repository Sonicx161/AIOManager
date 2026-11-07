import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNotesStore, type Note, type NoteMeta, extractTags } from '@/store/notesStore'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { NotesGraph } from '@/components/notes/NotesGraph'
import { NotesEmptyState } from '@/components/common/PageEmptyStates'
import {
    Plus, Trash2, Pin, StickyNote, Search, X, Network, ChevronLeft,
    Undo2, Redo2, Bold, Italic, List, ListOrdered, SquareTerminal, Check, Copy,
    Hash, Type, Heading1, Heading2, Heading3, Code, Quote, Keyboard, RotateCcw, Trash,
    Table, Minus, Download, HelpCircle, ListChecks, PanelLeftClose, PanelLeftOpen, Upload, Link, Link2
} from 'lucide-react'
import { cn, inlineFormat, escapeHtml } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { toast } from '@/hooks/use-toast'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDistanceToNow, format } from 'date-fns'
import { zipSync, strToU8, unzipSync } from 'fflate'
const SLASH_COMMANDS = [
    { label: 'Heading 1', icon: Heading1, prefix: '# ' },
    { label: 'Heading 2', icon: Heading2, prefix: '## ' },
    { label: 'Heading 3', icon: Heading3, prefix: '### ' },
    { label: 'Bullet List', icon: List, prefix: '- ' },
    { label: 'Numbered List', icon: ListOrdered, prefix: '1. ' },
    { label: 'Task List', icon: Check, prefix: '- [ ] ' },
    { label: 'Blockquote', icon: Quote, prefix: '> ' },
    { label: 'Code Block', icon: SquareTerminal, prefix: '```\n', suffix: '\n```' },
    { label: 'Divider', icon: Minus, prefix: '\n---\n' }
]



function getCaretCoordinates(element: HTMLTextAreaElement, position: number) {
    const div = document.createElement('div')
    const style = window.getComputedStyle(element)
    for (let i = 0; i < style.length; i++) {
        const prop = style[i]
        div.style.setProperty(prop, style.getPropertyValue(prop))
    }
    div.style.position = 'absolute'
    div.style.visibility = 'hidden'
    div.style.whiteSpace = 'pre-wrap'
    div.style.wordWrap = 'break-word'
    div.textContent = element.value.substring(0, position)
    
    const span = document.createElement('span')
    span.textContent = element.value.substring(position, position + 1) || '.'
    div.appendChild(span)
    document.body.appendChild(div)
    
    const top = span.offsetTop - element.scrollTop
    const left = span.offsetLeft - element.scrollLeft
    document.body.removeChild(div)
    return { top, left }
}

function findBacklinks(notes: NoteMeta[], title: string): NoteMeta[] {
    if (!title || title === 'Untitled') return []
    const lower = title.toLowerCase()
    return notes.filter(n => n.wikilinks.some(w => w.toLowerCase() === lower))
}

const MAX_IMPORT_MD_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_ZIP_ENTRIES = 200
const MAX_IMPORT_ZIP_TOTAL_BYTES = 20 * 1024 * 1024

async function importMarkdownFile(
    name: string,
    bytes: Uint8Array,
    createNote: (title: string, content: string) => Promise<Note>
): Promise<boolean> {
    if (bytes.length === 0 || bytes.length > MAX_IMPORT_MD_BYTES) return false
    const text = new TextDecoder().decode(bytes)
    if (text.includes('\u0000')) return false
    const heading = text.match(/^#\s+(.+)$/m)
    const fallback = (name.split('/').pop() || '').replace(/\.(md|markdown)$/i, '')
    const title = (heading?.[1] || fallback).trim() || 'Imported note'
    await createNote(title, text)
    return true
}

function noteDay(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return 'Today'
    const yest = new Date(now)
    yest.setDate(now.getDate() - 1)
    if (d.toDateString() === yest.toDateString()) return 'Yesterday'
    if ((now.getTime() - d.getTime()) < 7 * 24 * 60 * 60 * 1000) return d.toLocaleDateString(undefined, { weekday: 'long' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function groupNotesByDate(notes: NoteMeta[]): { label: string; notes: NoteMeta[] }[] {
    const groups: Map<string, NoteMeta[]> = new Map()
    for (const n of notes) {
        const day = noteDay(n.updatedAt)
        if (!groups.has(day)) groups.set(day, [])
        groups.get(day)!.push(n)
    }
    return [...groups.entries()].map(([label, notes]) => ({ label, notes }))
}

function buildMarkdownTable(rows: number, cols: number): string {
    const header = Array.from({ length: cols }, (_, i) => `Col ${i + 1}`)
    const sep = header.map(() => '------')
    const body = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
    return `| ${header.join(' | ')} |\n|${sep.join('|')}|\n${body.map(r => '| ' + r.join(' | ') + ' |').join('\n')}`
}

function splitTableCells(content: string): string[] {
    const cells: string[] = []
    let current = ''
    let inLink = false
    for (let i = 0; i < content.length; i++) {
        if (!inLink && content[i] === '[' && content[i + 1] === '[') {
            inLink = true
            current += '[['
            i++
        } else if (inLink && content[i] === ']' && content[i + 1] === ']') {
            inLink = false
            current += ']]'
            i++
        } else if (content[i] === '|' && !inLink) {
            cells.push(current.trim())
            current = ''
        } else {
            current += content[i]
        }
    }
    cells.push(current.trim())
    return cells
}

function getTableInfo(lines: string[], startLine: number) {
    const rowMatch = lines[startLine]?.match(/^\|(.+)\|$/)
    if (!rowMatch) return null
    const sepMatch = lines[startLine + 1]?.match(/^\|[\s\-:]+\|$/)
    const hasHeader = !!sepMatch
    const colCount = splitTableCells(rowMatch[1]).length
    const dataStart = hasHeader ? startLine + 2 : startLine
    let end = dataStart
    while (end < lines.length) {
        const m = lines[end]?.match(/^\|(.+)\|$/)
        const s = lines[end]?.match(/^\|[\s\-:]+\|$/)
        if (!m || s) break
        end++
    }
    return { hasHeader, colCount, headerLine: startLine, sepLine: hasHeader ? startLine + 1 : -1, dataStart, end }
}

function parseRowCells(line: string): string[] {
    const m = line.match(/^\|(.+)\|$/)
    return m ? splitTableCells(m[1]) : []
}

function buildRow(cells: string[]): string {
    return '| ' + cells.join(' | ') + ' |'
}

function tableEditCell(md: string, tableStart: number, rowIdx: number, colIdx: number, value: string): string {
    const lines = md.split('\n')
    const info = getTableInfo(lines, tableStart)
    if (!info || colIdx >= info.colCount) return md
    let targetLine: number
    if (rowIdx === -1) {
        if (!info.hasHeader) return md
        targetLine = info.headerLine
    } else {
        targetLine = info.dataStart + rowIdx
        if (targetLine >= info.end) return md
    }
    const cells = parseRowCells(lines[targetLine])
    if (colIdx >= cells.length) return md
    cells[colIdx] = value
    lines[targetLine] = buildRow(cells)
    return lines.join('\n')
}

function tableAddRow(md: string, tableStart: number, afterRow: number): string {
    const lines = md.split('\n')
    const info = getTableInfo(lines, tableStart)
    if (!info) return md
    const insertAt = afterRow < 0 ? info.dataStart : info.dataStart + afterRow + 1
    lines.splice(insertAt, 0, buildRow(Array.from({ length: info.colCount }, () => '')))
    return lines.join('\n')
}

function tableDeleteRow(md: string, tableStart: number, rowIdx: number): string {
    const lines = md.split('\n')
    const info = getTableInfo(lines, tableStart)
    if (!info || rowIdx < 0) return md
    const targetLine = info.dataStart + rowIdx
    if (targetLine < info.dataStart || targetLine >= info.end) return md
    if (info.end - info.dataStart <= 1) return md
    lines.splice(targetLine, 1)
    return lines.join('\n')
}

function tableAddColumn(md: string, tableStart: number, afterCol: number): string {
    const lines = md.split('\n')
    const info = getTableInfo(lines, tableStart)
    if (!info) return md
    const insertAt = afterCol + 1
    if (info.hasHeader) {
        const hCells = parseRowCells(lines[info.headerLine])
        hCells.splice(insertAt, 0, `Col ${info.colCount + 1}`)
        lines[info.headerLine] = buildRow(hCells)
        const sepParts = lines[info.sepLine].match(/^\|(.+)\|$/)
        if (sepParts) {
            const sepCells = sepParts[1].split('|')
            sepCells.splice(insertAt, 0, '------')
            lines[info.sepLine] = '|' + sepCells.join('|') + '|'
        }
    }
    for (let i = info.dataStart; i < info.end; i++) {
        const cells = parseRowCells(lines[i])
        cells.splice(insertAt, 0, '')
        lines[i] = buildRow(cells)
    }
    return lines.join('\n')
}

function tableDeleteColumn(md: string, tableStart: number, colIdx: number): string {
    const lines = md.split('\n')
    const info = getTableInfo(lines, tableStart)
    if (!info || info.colCount <= 1 || colIdx >= info.colCount) return md
    if (info.hasHeader) {
        const hCells = parseRowCells(lines[info.headerLine])
        hCells.splice(colIdx, 1)
        lines[info.headerLine] = buildRow(hCells)
        const sepParts = lines[info.sepLine].match(/^\|(.+)\|$/)
        if (sepParts) {
            const sepCells = sepParts[1].split('|')
            sepCells.splice(colIdx, 1)
            lines[info.sepLine] = '|' + sepCells.map(() => '------').join('|') + '|'
        }
    }
    for (let i = info.dataStart; i < info.end; i++) {
        const cells = parseRowCells(lines[i])
        cells.splice(colIdx, 1)
        lines[i] = buildRow(cells)
    }
    return lines.join('\n')
}

function renderMarkdown(text: string, onToggleTask?: (lineIndex: number) => void) {
    const lines = text.split('\n')
    const elements: React.ReactNode[] = []
    let listType: 'ul' | 'ol' | null = null
    let listItems: React.ReactNode[] = []
    let inBlockquote = false
    let blockquoteLines: string[] = []
    let inCodeBlock = false
    let codeLines: string[] = []
    let codeLang = ''
    let taskDone = 0
    let taskTotal = 0

    const flushList = () => {
        if (!listType || listItems.length === 0) return
        const key = `list-${elements.length}`
        if (listType === 'ul') {
            elements.push(<ul key={key} className="list-disc pl-5 space-y-1 my-2 text-sm">{listItems}</ul>)
        } else {
            elements.push(<ol key={key} className="list-decimal pl-5 space-y-1 my-2 text-sm">{listItems}</ol>)
        }
        listType = null
        listItems = []
    }

    const flushBlockquote = () => {
        if (!inBlockquote || blockquoteLines.length === 0) return
        const key = `bq-${elements.length}`
        elements.push(
            <blockquote key={key} className="border-l-2 border-primary/40 pl-4 my-2 text-sm text-muted-foreground italic">
                {blockquoteLines.map((l, i) => <p key={i} dangerouslySetInnerHTML={{ __html: inlineFormat(l) }} />)}
            </blockquote>
        )
        inBlockquote = false
        blockquoteLines = []
    }

    const flushCodeBlock = () => {
        if (!inCodeBlock) return
        const key = `code-${elements.length}`
        elements.push(
            <div key={key} data-theme-part="field" className="my-3 rounded-xl border border-border/40 overflow-hidden">
                {codeLang && (
                    <div className="px-3 py-1 bg-muted/60 border-b border-border/30 text-xs font-mono text-muted-foreground">{codeLang}</div>
                )}
                <pre className="p-3 overflow-x-auto bg-muted/20 text-sm leading-relaxed">
                    <code className="font-mono">{codeLines.join('\n')}</code>
                </pre>
            </div>
        )
        inCodeBlock = false
        codeLines = []
        codeLang = ''
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        if (line.startsWith('```')) {
            if (inCodeBlock) {
                flushCodeBlock()
            } else {
                flushList()
                flushBlockquote()
                inCodeBlock = true
                codeLang = line.slice(3).trim()
                codeLines = []
            }
            continue
        }

        if (inCodeBlock) {
            codeLines.push(line)
            continue
        }

        const tableRowMatch = line.match(/^\|(.+)\|$/)
        const tableSepMatch = line.match(/^\|[\s\-:]+\|$/)
        const taskMatch = line.match(/^[-*]\s+\[( |x)\]\s+(.+)/)
        const ulMatch = line.match(/^[-*]\s+(.+)/)
        const olMatch = line.match(/^\d+\.\s+(.+)/)
        const bqMatch = line.match(/^>\s?(.*)/)

        if (taskMatch) {
            flushList()
            flushBlockquote()
            taskTotal++
            const done = taskMatch[1] === 'x'
            if (done) taskDone++
            elements.push(
                <div key={i} className="flex items-start gap-2 my-1 text-sm group/task">
                    <button
                        onClick={() => onToggleTask?.(i)}
                        aria-label={`${done ? 'Mark task incomplete' : 'Mark task complete'}: ${taskMatch[2]}`}
                        aria-pressed={done}
                        className={cn('w-4 h-4 mt-0.5 rounded border shrink-0 flex items-center justify-center transition-colors cursor-pointer', done ? 'bg-primary border-primary' : 'border-muted-foreground/40 hover:border-primary/50')}
                    >
                        {done && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                    </button>
                    <span className={cn(done && 'line-through text-muted-foreground')} dangerouslySetInnerHTML={{ __html: inlineFormat(taskMatch[2]) }} />
                </div>
            )
            continue
        }

        if (bqMatch) {
            flushList()
            inBlockquote = true
            blockquoteLines.push(bqMatch[1])
            continue
        }
        flushBlockquote()

        if (tableRowMatch && !tableSepMatch) {
            flushList()
            const cells = splitTableCells(tableRowMatch[1])
            const peekNext = lines[i + 1]?.match(/^\|[\s\-:]+\|$/)
            const isHeader = !!peekNext

            if (isHeader) {
                const bodyRows: string[][] = []
                let ri = i + 2
                while (ri < lines.length) {
                    const rowMatch = lines[ri]?.match(/^\|(.+)\|$/)
                    const rowSep = lines[ri]?.match(/^\|[\s\-:]+\|$/)
                    if (!rowMatch || rowSep) break
                    bodyRows.push(splitTableCells(rowMatch[1]))
                    ri++
                }
                const key = `table-${elements.length}`
                elements.push(
                    <div key={key} data-table-start={i} data-table-end={ri} className="my-3 overflow-x-auto rounded-xl border border-border/40">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-muted/30 border-b border-border/30">
                                    {cells.map((cell, ci) => (
                                        <th key={ci} data-row="-1" data-col={ci} data-cell-raw={encodeURIComponent(cell)} className="px-3 py-2 text-left font-semibold">{cell}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {bodyRows.map((rowCells, rowIdx) => (
                                    <tr key={rowIdx} className="border-b border-border/20 last:border-0 hover:bg-muted/10">
                                        {rowCells.map((cell, ci) => (
                                            <td key={ci} data-row={rowIdx} data-col={ci} data-cell-raw={encodeURIComponent(cell)} className="px-3 py-2" dangerouslySetInnerHTML={{ __html: inlineFormat(cell) }} />
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
                i = ri - 1
            } else {
                const rows = [cells]
                let ri = i + 1
                while (ri < lines.length) {
                    const rowMatch = lines[ri]?.match(/^\|(.+)\|$/)
                    const rowSep = lines[ri]?.match(/^\|[\s\-:]+\|$/)
                    if (!rowMatch || rowSep) break
                    rows.push(splitTableCells(rowMatch[1]))
                    ri++
                }
                const key = `table-${elements.length}`
                elements.push(
                    <div key={key} data-table-start={i} data-table-end={ri} className="my-3 overflow-x-auto rounded-xl border border-border/40">
                        <table className="w-full text-sm">
                            <tbody>
                                {rows.map((rowCells, rowIdx) => (
                                    <tr key={rowIdx} className="border-b border-border/20 last:border-0 hover:bg-muted/10">
                                        {rowCells.map((cell, ci) => (
                                            <td key={ci} data-row={rowIdx} data-col={ci} data-cell-raw={encodeURIComponent(cell)} className="px-3 py-2" dangerouslySetInnerHTML={{ __html: inlineFormat(cell) }} />
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
                i = ri - 1
            }
            continue
        }

        if (tableSepMatch) continue

        if (ulMatch) {
            if (listType === 'ol') flushList()
            listType = 'ul'
            listItems.push(<li key={i} className="text-sm" dangerouslySetInnerHTML={{ __html: inlineFormat(ulMatch[1]) }} />)
            continue
        }
        if (olMatch) {
            if (listType === 'ul') flushList()
            listType = 'ol'
            listItems.push(<li key={i} className="text-sm" dangerouslySetInnerHTML={{ __html: inlineFormat(olMatch[1]) }} />)
            continue
        }
        flushList()

        if (/^---+$/.test(line.trim())) {
            elements.push(<hr key={i} className="border-border/40 my-4" />)
        } else if (line.startsWith('# ')) {
            elements.push(<h2 key={i} className="text-2xl font-bold mt-5 mb-2 tracking-tight">{line.slice(2)}</h2>)
        } else if (line.startsWith('## ')) {
            elements.push(<h3 key={i} className="text-lg font-bold mt-4 mb-1.5">{line.slice(3)}</h3>)
        } else if (line.startsWith('### ')) {
            elements.push(<h4 key={i} className="text-sm font-bold mt-2 mb-1 text-muted-foreground uppercase tracking-wide">{line.slice(4)}</h4>)
        } else if (line.trim() === '') {
            elements.push(<div key={i} className="h-2" />)
        } else {
            elements.push(
                <p key={i} className="text-[15px] leading-relaxed" dangerouslySetInnerHTML={{ __html: inlineFormat(line) }} />
            )
        }
    }

    flushList()
    flushBlockquote()
    flushCodeBlock()

    if (taskTotal > 0) {
        elements.unshift(
            <div key="task-progress" data-theme-part="badge" className="flex items-center gap-2 mb-3 px-3 py-1.5 rounded-lg bg-primary/5 border border-primary/10">
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-[transform,opacity,box-shadow]" style={{ width: `${taskTotal > 0 ? (taskDone / taskTotal) * 100 : 0}%` }} />
                </div>
                <span className="text-xs font-medium text-primary shrink-0">{taskDone}/{taskTotal}</span>
            </div>
        )
    }

    return elements
}

function countWords(text: string) {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    const chars = text.length
    return { words, chars }
}

function TB({ label, icon: Icon, onClick, disabled, className }: { label: string; icon: React.ElementType; onClick: () => void; disabled?: boolean; className?: string }) {
    return (
        <Tooltip content={label} side="top">
            <Button
                variant="ghost"
                onClick={onClick}
                disabled={disabled}
                aria-label={label}
                className={cn("h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30", className)}
            >
                <Icon className="h-3.5 w-3.5" />
            </Button>
        </Tooltip>
    )
}

function GridPicker({ onSelect, onClose }: { onSelect: (rows: number, cols: number) => void; onClose: () => void }) {
    const [hover, setHover] = useState<[number, number]>([0, 0])
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [onClose])

    return (
        <div ref={ref} data-theme-part="popover" className="absolute right-0 top-full mt-1 p-3 bg-popover border border-border/40 rounded-lg shadow-xl z-50 min-w-[200px]">
            <div className="grid grid-cols-5 gap-1">
                {Array.from({ length: 25 }, (_, idx) => {
                    const row = Math.floor(idx / 5)
                    const col = idx % 5
                    return (
                        <button
                            key={idx}
                            type="button"
                            aria-label={`Insert table with ${row + 1} rows and ${col + 1} columns`}
                            className={cn(
                                'w-7 h-7 rounded-sm border cursor-pointer transition-colors',
                                row <= hover[0] && col <= hover[1]
                                    ? 'bg-primary/20 border-primary/40'
                                    : 'border-border/40 hover:border-primary/30'
                            )}
                            onMouseEnter={() => setHover([row, col])}
                            onFocus={() => setHover([row, col])}
                            onClick={() => onSelect(row + 1, col + 1)}
                        />
                    )
                })}
            </div>
            <div className="text-center mt-2 text-xs text-muted-foreground">
                {hover[0] + 1} × {hover[1] + 1}
            </div>
        </div>
    )
}

function TableContextMenu({
    x, y, isHeader, onAction, onClose
}: {
    x: number; y: number; isHeader: boolean; onAction: (action: string) => void; onClose: () => void
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [onClose])

    return (
        <div ref={ref} data-theme-part="menu" className="fixed z-[100] min-w-[160px] bg-popover border border-border/40 rounded-lg shadow-xl overflow-hidden py-1" style={{ left: x, top: y }}>
            {!isHeader && (
                <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left" onClick={() => onAction('add-row-above')}>Add row above</button>
            )}
            <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left" onClick={() => onAction('add-row-below')}>Add row below</button>
            {!isHeader && (
                <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left text-destructive" onClick={() => onAction('delete-row')}>Delete row</button>
            )}
            <div className="my-1 border-t border-border/40" />
            <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left" onClick={() => onAction('add-col-left')}>Add column left</button>
            <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left" onClick={() => onAction('add-col-right')}>Add column right</button>
            <button data-theme-part="menu-item" className="w-full px-3 py-1.5 text-xs hover:bg-muted/50 text-left text-destructive" onClick={() => onAction('delete-col')}>Delete column</button>
        </div>
    )
}

interface NoteEditorProps {
    note: Note
    onClose: () => void
    onNavigateToNote?: (id: string) => void
    allNotes?: NoteMeta[]
}

type ViewMode = 'edit' | 'preview' | 'split'

function NoteEditor({ note, onClose, onNavigateToNote, allNotes }: NoteEditorProps) {
    const updateNote = useNotesStore(s => s.updateNote)
    const deleteNote = useNotesStore(s => s.deleteNote)
    const createNote = useNotesStore(s => s.createNote)

    const [title, setTitle] = useState(note.title === 'Untitled' ? '' : note.title)
    const [content, setContent] = useState(note.content)
    const [viewMode, setViewMode] = useState<ViewMode>(note.content.trim() ? 'preview' : 'edit')
    const [showShortcuts, setShowShortcuts] = useState(false)
    const [history, setHistory] = useState<string[]>([note.content])
    const [historyIndex, setHistoryIndex] = useState(0)
    const historyIndexRef = useRef(0)
    historyIndexRef.current = historyIndex
    const [copied, setCopied] = useState(false)
    const [showExport, setShowExport] = useState(false)
    const [showFind, setShowFind] = useState(false)
    const [findText, setFindText] = useState('')
    const [replaceText, setReplaceText] = useState('')
    const [showGridPicker, setShowGridPicker] = useState(false)
    const [contextMenu, setContextMenu] = useState<{
        x: number; y: number; tableStart: number; row: number; col: number; isHeader: boolean
    } | null>(null)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
    const [editingCell, setEditingCell] = useState<{
        tableStart: number; row: number; col: number; value: string; left: number; top: number; width: number; height: number
    } | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const previewRef = useRef<HTMLDivElement>(null)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const exportRef = useRef<HTMLDivElement>(null)
    const cellInputRef = useRef<HTMLInputElement>(null)
    const loadedNoteIdRef = useRef<string | null>(null)

    const [slashOpen, setSlashOpen] = useState(false)
    const [slashQuery, setSlashQuery] = useState('')
    const [slashIndex, setSlashIndex] = useState(0)
    const [slashPos, setSlashPos] = useState({ top: 0, left: 0 })
    const [showHelp, setShowHelp] = useState(false)
    const helpRef = useRef<HTMLDivElement>(null)
    const helpPopoverRef = useRef<HTMLDivElement>(null)
    const [helpPos, setHelpPos] = useState<{ top: number; left: number } | null>(null)

    useEffect(() => {
        if (!showHelp || !helpRef.current) return
        const r = helpRef.current.getBoundingClientRect()
        setHelpPos({ top: r.top, left: r.right })
    }, [showHelp])
    
    const [wikilinkOpen, setWikilinkOpen] = useState(false)
    const [wikilinkQuery, setWikilinkQuery] = useState('')
    const [wikilinkIndex, setWikilinkIndex] = useState(0)
    const [wikilinkPos, setWikilinkPos] = useState({ top: 0, left: 0 })
    
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
    const saveFailed = useNotesStore(s => s.saveFailed)

    useEffect(() => { setSaveStatus('idle') }, [note.id])

    const autosave = useCallback((newTitle: string, newContent: string) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        setSaveStatus('saving')
        saveTimerRef.current = setTimeout(() => {
            Promise.resolve(updateNote(note.id, { title: newTitle.trim() || 'Untitled', content: newContent }))
                .then(() => setSaveStatus('saved'), () => setSaveStatus('idle'))
        }, 600)
    }, [note.id, updateNote])

    const pushHistory = useCallback((val: string) => {
        const idx = historyIndexRef.current
        setHistory(prev => {
            const next = prev.slice(0, idx + 1)
            next.push(val)
            return next.length > 100 ? next.slice(-100) : next
        })
        const newIdx = Math.min(idx + 1, 99)
        historyIndexRef.current = newIdx
        setHistoryIndex(newIdx)
    }, [])

    const filteredCommands = useMemo(() => {
        if (!slashQuery) return SLASH_COMMANDS
        return SLASH_COMMANDS.filter(c => c.label.toLowerCase().includes(slashQuery.toLowerCase()))
    }, [slashQuery])

    const filteredWikilinks = useMemo(() => {
        if (!allNotes) return []
        const query = wikilinkQuery.toLowerCase()
        return allNotes
            .filter(n => n.id !== note.id && n.title.toLowerCase().includes(query))
            .sort((a, b) => a.title.localeCompare(b.title))
            .slice(0, 8)
    }, [allNotes, wikilinkQuery, note.id])

    const executeSlash = useCallback((cmd: typeof SLASH_COMMANDS[0]) => {
        const ta = textareaRef.current; if (!ta) return
        const s = ta.selectionStart
        const lineStart = content.lastIndexOf('\n', s - 1) + 1
        const lineToCursor = content.slice(lineStart, s)
        const slashIdx = lineToCursor.lastIndexOf('/')
        if (slashIdx === -1) return
        const slashPos = lineStart + slashIdx
        const beforeSlash = content.slice(0, slashPos)
        const afterCursor = content.slice(s)
        const newVal = beforeSlash + cmd.prefix + (cmd.suffix || '') + afterCursor
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setSlashOpen(false)
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = beforeSlash.length + cmd.prefix.length; ta.focus() }, 0)
    }, [content, pushHistory, autosave, title])

    const executeWikilink = useCallback((targetNote: NoteMeta) => {
        const ta = textareaRef.current; if (!ta) return
        const s = ta.selectionStart
        const lineStart = content.lastIndexOf('\n', s - 1) + 1
        const lineToCursor = content.slice(lineStart, s)
        const match = lineToCursor.match(/\[\[([^\]]*)$/)
        if (!match) return

        const startPos = s - match[0].length
        const newVal = content.slice(0, startPos) + '[[' + targetNote.title + ']]' + content.slice(s)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setWikilinkOpen(false)
        setTimeout(() => { 
            const newPos = startPos + targetNote.title.length + 4
            ta.selectionStart = ta.selectionEnd = newPos
            ta.focus() 
        }, 0)
    }, [content, pushHistory, autosave, title])

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExport(false)
        }
        if (showExport) document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showExport])



    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (helpRef.current && !helpRef.current.contains(e.target as Node)
                && helpPopoverRef.current && !helpPopoverRef.current.contains(e.target as Node)) setShowHelp(false)
        }
        if (showHelp) document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showHelp])

    useEffect(() => {
        if (loadedNoteIdRef.current === note.id) return
        loadedNoteIdRef.current = note.id
        setTitle(note.title === 'Untitled' ? '' : note.title)
        setContent(note.content)
        setHistory([note.content])
        setHistoryIndex(0)
    }, [note.id, note.title, note.content])

    const tags = useMemo(() => extractTags(content), [content])
    const backlinks = useMemo(() => allNotes ? findBacklinks(allNotes, note.title) : [], [allNotes, note.title])

    const handleWikilinkClick = useCallback(async (e: React.MouseEvent) => {
        const target = e.target as HTMLElement
        const wikilinkEl = target.closest('[data-wikilink]') as HTMLElement | null
        if (!wikilinkEl || !onNavigateToNote || !allNotes) return
        const linkTitle = wikilinkEl.dataset.wikilink
        if (!linkTitle) return
        const found = allNotes.find(n => n.title.toLowerCase() === linkTitle.toLowerCase())
        if (found) {
            onNavigateToNote(found.id)
        } else {
            const newNote = await createNote(linkTitle, '')
            onNavigateToNote(newNote.id)
        }
    }, [onNavigateToNote, allNotes, createNote])

    const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value
        const s = e.target.selectionStart
        setContent(val)
        pushHistory(val)
        autosave(title, val)

        const lineStart = val.lastIndexOf('\n', s - 1) + 1
        const lineToCursor = val.slice(lineStart, s)
        const match = lineToCursor.match(/^\/([a-zA-Z-]*)$/)
        if (match) {
            setSlashOpen(true)
            setSlashQuery(match[1])
            setSlashIndex(0)
            if (e.target) {
                const { top, left } = getCaretCoordinates(e.target, s)
                setSlashPos({ top: top + 24, left: Math.max(left, 24) })
            }
        } else {
            setSlashOpen(false)
        }

        const wikilinkMatch = lineToCursor.match(/\[\[([^\]]*)$/)
        if (wikilinkMatch) {
            setWikilinkOpen(true)
            setWikilinkQuery(wikilinkMatch[1])
            setWikilinkIndex(0)
            if (e.target) {
                const { top, left } = getCaretCoordinates(e.target, s)
                setWikilinkPos({ top: top + 24, left: Math.max(left, 24) })
            }
        } else {
            setWikilinkOpen(false)
        }
    }, [pushHistory, autosave, title])

    const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setTitle(val)
        autosave(val, content)
    }, [autosave, content])

    const handleTitleBlur = useCallback(() => {
        updateNote(note.id, { title: title.trim() || 'Untitled', content })
    }, [note.id, title, content, updateNote])

    const handleUndo = useCallback(() => {
        if (historyIndex > 0) { const ni = historyIndex - 1; setHistoryIndex(ni); setContent(history[ni]) }
    }, [historyIndex, history])

    const handleRedo = useCallback(() => {
        if (historyIndex < history.length - 1) { const ni = historyIndex + 1; setHistoryIndex(ni); setContent(history[ni]) }
    }, [historyIndex, history])

    const insertAt = useCallback((prefix: string) => {
        const ta = textareaRef.current; if (!ta) return
        const start = ta.selectionStart
        const lineStart = content.lastIndexOf('\n', start - 1) + 1
        const newVal = content.slice(0, lineStart) + prefix + content.slice(lineStart)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + prefix.length; ta.focus() }, 0)
    }, [content, pushHistory, autosave, title])

    const wrapSel = useCallback((before: string, after: string) => {
        const ta = textareaRef.current; if (!ta) return
        const s = ta.selectionStart, e = ta.selectionEnd
        const selected = content.slice(s, e)
        const newVal = content.slice(0, s) + before + selected + after + content.slice(e)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setTimeout(() => { ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + selected.length; ta.focus() }, 0)
    }, [content, pushHistory, autosave, title])

    const insertLink = useCallback(() => {
        const ta = textareaRef.current; if (!ta) return
        const s = ta.selectionStart, e = ta.selectionEnd
        const selected = content.slice(s, e)
        const newVal = content.slice(0, s) + `[${selected}]()` + content.slice(e)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = s + selected.length + 3; ta.focus() }, 0)
    }, [content, pushHistory, autosave, title])

    const insertWikilink = useCallback(() => {
        const ta = textareaRef.current; if (!ta) return
        const s = ta.selectionStart, e = ta.selectionEnd
        const selected = content.slice(s, e)
        const newVal = content.slice(0, s) + '[[' + selected + content.slice(e)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        const caret = s + 2 + selected.length
        setTimeout(() => {
            ta.selectionStart = ta.selectionEnd = caret
            ta.focus()
            const { top, left } = getCaretCoordinates(ta, caret)
            setWikilinkOpen(true); setWikilinkQuery(selected); setWikilinkIndex(0)
            setWikilinkPos({ top: top + 24, left: Math.max(left, 24) })
        }, 0)
    }, [content, pushHistory, autosave, title])

    const handleSave = useCallback(() => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        Promise.resolve(updateNote(note.id, { title: title.trim() || 'Untitled', content }))
            .then(() => setSaveStatus('saved'), () => setSaveStatus('idle'))
        setViewMode('preview')
    }, [note.id, title, content, updateNote])

    const handleDelete = useCallback(() => {
        deleteNote(note.id); onClose()
    }, [note.id, deleteNote, onClose])

    const handleCopyMd = useCallback(() => {
        navigator.clipboard.writeText(content); setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }, [content])

    const handleCopyHtml = useCallback(() => {
        const html = previewRef.current?.innerHTML || ''
        navigator.clipboard.writeText(html)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
        setShowExport(false)
    }, [])

    const downloadFile = useCallback((filename: string, data: string, mime: string) => {
        const blob = new Blob([data], { type: mime })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        URL.revokeObjectURL(url)
        setShowExport(false)
    }, [])

    const handleDownloadMd = useCallback(() => {
        const safeName = (title || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_')
        downloadFile(`${safeName}.md`, content, 'text/markdown;charset=utf-8')
    }, [title, content, downloadFile])

    const handleDownloadHtml = useCallback(() => {
        const safeName = (title || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_')
        const html = previewRef.current?.innerHTML || ''
        const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Untitled')}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.9em}pre{background:#f4f4f4;padding:1rem;border-radius:8px;overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f8f8f8}</style></head><body>${html}</body></html>`
        downloadFile(`${safeName}.html`, full, 'text/html;charset=utf-8')
    }, [title, downloadFile])

    const handleDownloadTxt = useCallback(() => {
        const safeName = (title || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_')
        const plain = content.replace(/^#{1,3}\s/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/~~(.+?)~~/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\(.+?\)/g, '$1').replace(/^[-*]\s/gm, '  • ').replace(/^>\s/gm, '')
        downloadFile(`${safeName}.txt`, plain, 'text/plain;charset=utf-8')
    }, [title, content, downloadFile])

    const handleReplaceAll = useCallback(() => {
        if (!findText) return
        const newVal = content.replaceAll(findText, replaceText)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
    }, [content, findText, replaceText, pushHistory, autosave, title])

    const handleReplaceNext = useCallback(() => {
        if (!findText) return
        const idx = content.indexOf(findText, textareaRef.current?.selectionEnd || 0)
        if (idx === -1) return
        const newVal = content.slice(0, idx) + replaceText + content.slice(idx + findText.length)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = idx
                textareaRef.current.selectionEnd = idx + replaceText.length
                textareaRef.current.focus()
            }
        }, 0)
    }, [content, findText, replaceText, pushHistory, autosave, title])

    const insertAtCursor = useCallback((text: string) => {
        const ta = textareaRef.current
        if (!ta) {
            const newVal = content + (content.endsWith('\n') ? '' : '\n') + text
            setContent(newVal); pushHistory(newVal); autosave(title, newVal)
            return
        }
        const pos = ta.selectionStart
        const needsNl = pos > 0 && content[pos - 1] !== '\n'
        const prefix = needsNl ? '\n' : ''
        const newVal = content.slice(0, pos) + prefix + text + content.slice(pos)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + prefix.length + text.length; ta.focus() }, 0)
    }, [content, pushHistory, autosave, title])

    const handleGridSelect = useCallback((rows: number, cols: number) => {
        insertAtCursor('\n' + buildMarkdownTable(rows, cols) + '\n')
        setShowGridPicker(false)
        if (viewMode === 'preview') setViewMode('split')
    }, [insertAtCursor, viewMode])

    const handlePreviewDoubleClick = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement
        const cell = target.closest('td, th') as HTMLElement | null
        if (!cell) return
        const table = cell.closest('[data-table-start]') as HTMLElement | null
        if (!table) return
        const tableStart = parseInt(table.dataset.tableStart || '0')
        const row = parseInt(cell.dataset.row || '0')
        const col = parseInt(cell.dataset.col || '0')
        const raw = decodeURIComponent(cell.dataset.cellRaw || '')
        const rect = cell.getBoundingClientRect()
        setEditingCell({ tableStart, row, col, value: raw, left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }, [])

    const handlePreviewContextMenu = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement
        const cell = target.closest('td, th') as HTMLElement | null
        if (!cell) return
        const table = cell.closest('[data-table-start]') as HTMLElement | null
        if (!table) return
        e.preventDefault()
        const tableStart = parseInt(table.dataset.tableStart || '0')
        const row = parseInt(cell.dataset.row || '0')
        const col = parseInt(cell.dataset.col || '0')
        const isHeader = cell.tagName === 'TH'
        setContextMenu({ x: e.clientX, y: e.clientY, tableStart, row, col, isHeader })
    }, [])

    const handleCellEditCommit = useCallback(() => {
        if (!editingCell) return
        const newVal = tableEditCell(content, editingCell.tableStart, editingCell.row, editingCell.col, editingCell.value)
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setEditingCell(null)
    }, [editingCell, content, pushHistory, autosave, title])

    const handleTableAction = useCallback((action: string) => {
        if (!contextMenu) return
        let newVal = content
        const { tableStart, row, col } = contextMenu
        switch (action) {
            case 'add-row-above': newVal = tableAddRow(newVal, tableStart, row - 1); break
            case 'add-row-below': newVal = tableAddRow(newVal, tableStart, row); break
            case 'delete-row': newVal = tableDeleteRow(newVal, tableStart, row); break
            case 'add-col-left': newVal = tableAddColumn(newVal, tableStart, col - 1); break
            case 'add-col-right': newVal = tableAddColumn(newVal, tableStart, col); break
            case 'delete-col': newVal = tableDeleteColumn(newVal, tableStart, col); break
        }
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
        setContextMenu(null)
    }, [contextMenu, content, pushHistory, autosave, title])

    const handleToggleTask = useCallback((lineIndex: number) => {
        const lines = content.split('\n')
        if (lineIndex < 0 || lineIndex >= lines.length) return
        const line = lines[lineIndex]
        const taskMatch = line.match(/^(\s*[-*]\s+\[)( |x)(\]\s+.*)$/)
        if (!taskMatch) return
        const toggled = taskMatch[2] === 'x' ? ' ' : 'x'
        lines[lineIndex] = taskMatch[1] + toggled + taskMatch[3]
        const newVal = lines.join('\n')
        setContent(newVal); pushHistory(newVal); autosave(title, newVal)
    }, [content, pushHistory, autosave, title])

    const { words } = useMemo(() => countWords(content), [content])

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const ta = e.currentTarget
        
        if (slashOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % filteredCommands.length); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return }
            if (e.key === 'Enter') { 
                e.preventDefault()
                const cmd = filteredCommands[slashIndex]
                if (cmd) executeSlash(cmd)
                return 
            }
            if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return }
        }

        if (wikilinkOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setWikilinkIndex(i => (i + 1) % filteredWikilinks.length); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setWikilinkIndex(i => (i - 1 + filteredWikilinks.length) % filteredWikilinks.length); return }
            if (e.key === 'Enter') { 
                e.preventDefault()
                const note = filteredWikilinks[wikilinkIndex]
                if (note) executeWikilink(note)
                return 
            }
            if (e.key === 'Escape') { e.preventDefault(); setWikilinkOpen(false); return }
        }

        if (e.key === 'Escape') { if (showFind) { setShowFind(false); return } handleSave(); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); handleRedo(); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); wrapSel('**', '**'); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); wrapSel('*', '*'); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); wrapSel('`', '`'); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); setViewMode(v => v === 'preview' ? 'edit' : 'preview'); return }
        if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); setShowFind(v => !v); return }

        if (e.key === 'Tab') {
            e.preventDefault()
            const s = ta.selectionStart, end = ta.selectionEnd
            const newVal = content.slice(0, s) + '  ' + content.slice(end)
            setContent(newVal); pushHistory(newVal); autosave(title, newVal)
            setTimeout(() => { ta.selectionStart = ta.selectionEnd = s + 2 }, 0)
            return
        }

        if (e.key === 'Enter') {
            const pos = ta.selectionStart
            const lineStart = content.lastIndexOf('\n', pos - 1) + 1
            const currentLine = content.slice(lineStart, pos)
            const ulMatch = currentLine.match(/^(\s*)([-*])\s/)
            const olMatch = currentLine.match(/^(\s*)(\d+)\.\s/)
            const taskMatch = currentLine.match(/^(\s*)([-*])\s\[( |x)\]\s/)
            if (taskMatch) {
                e.preventDefault()
                if (currentLine.trim() === '- [ ] ' || currentLine.trim() === '* [ ] ') {
                    const newVal = content.slice(0, lineStart) + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = lineStart }, 0)
                } else {
                    const { 1: indent, 2: bullet } = taskMatch
                    const newVal = content.slice(0, pos) + '\n' + indent + bullet + ' [ ] ' + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + 6 }, 0)
                }
            } else if (ulMatch) {
                e.preventDefault()
                if (currentLine.trim() === '- ' || currentLine.trim() === '* ') {
                    const newVal = content.slice(0, lineStart) + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = lineStart }, 0)
                } else {
                    const { 1: indent, 2: bullet } = ulMatch
                    const newVal = content.slice(0, pos) + '\n' + indent + bullet + ' ' + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + 2 }, 0)
                }
            } else if (olMatch) {
                e.preventDefault()
                const { 1: indent, 2: numStr } = olMatch
                if (currentLine.trim() === numStr + '. ') {
                    const newVal = content.slice(0, lineStart) + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = lineStart }, 0)
                } else {
                    const num = parseInt(numStr) + 1
                    const newVal = content.slice(0, pos) + '\n' + indent + num + '. ' + content.slice(pos)
                    setContent(newVal); pushHistory(newVal)
                    setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + num.toString().length + 2 }, 0)
                }
            }
        }
    }, [content, pushHistory, autosave, title, handleSave, handleUndo, handleRedo, wrapSel, showFind, slashOpen, slashIndex, filteredCommands, executeSlash, wikilinkOpen, wikilinkIndex, filteredWikilinks, executeWikilink])

    const viewLabel = viewMode === 'edit' ? 'Edit' : viewMode === 'preview' ? 'Preview' : 'Split'

    const editorPane = (
        <div className="flex-1 min-h-0 overflow-auto relative">
            <Textarea
                data-theme-part="inline-input"
                aria-label="Note content"
                ref={textareaRef}
                autoFocus
                maxLength={50000}
                value={content}
                onChange={handleContentChange}
                onKeyDown={onKeyDown}
                placeholder={"Start writing...\n\nType / for commands, [[ to link notes, or # for tags..."}
                className="h-full min-h-full border-0 rounded-none focus-visible:ring-0 resize-none text-sm bg-transparent px-4 sm:px-6 py-5 font-mono leading-relaxed whitespace-pre-wrap break-words"
            />
            {slashOpen && filteredCommands.length > 0 && (
                <div data-theme-part="menu"
                    className="absolute w-64 max-h-[300px] overflow-y-auto bg-popover border border-border/40 rounded-xl shadow-2xl z-50 flex flex-col p-1.5 animate-in fade-in zoom-in-95 duration-100"
                    style={{ top: slashPos.top, left: slashPos.left }}
                >
                    <div className="px-2 pt-1 pb-2 text-[13px] font-medium text-foreground/60">Basic Blocks</div>
                    {filteredCommands.map((cmd, i) => {
                        const Icon = cmd.icon
                        return (
                            <button
                                key={cmd.label}
                                data-theme-part="menu-item"
                                data-highlighted={i === slashIndex ? '' : undefined}
                                onClick={() => executeSlash(cmd)}
                                className={cn(
                                    "flex items-center gap-3 px-2 py-1.5 rounded-lg text-sm text-left transition-colors",
                                    i === slashIndex ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                )}
                            >
                                <div className={cn("p-1.5 rounded-md flex items-center justify-center border", i === slashIndex ? "bg-background border-primary/20 shadow-sm" : "bg-muted/50 border-transparent")}>
                                    <Icon className="h-3.5 w-3.5" />
                                </div>
                                <span className="font-medium text-xs">{cmd.label}</span>
                            </button>
                        )
                    })}
                </div>
            )}
            {wikilinkOpen && filteredWikilinks.length > 0 && (
                <div data-theme-part="menu"
                    className="absolute w-64 max-h-[300px] overflow-y-auto bg-popover border border-border/40 rounded-xl shadow-2xl z-50 flex flex-col p-1.5 animate-in fade-in zoom-in-95 duration-100"
                    style={{ top: wikilinkPos.top, left: wikilinkPos.left }}
                >
                    <div className="px-2 pt-1 pb-2 text-[13px] font-medium text-foreground/60">Link Note</div>
                    {filteredWikilinks.map((n, i) => (
                        <button
                            key={n.id}
                            data-theme-part="menu-item"
                            data-highlighted={i === wikilinkIndex ? '' : undefined}
                            onClick={() => executeWikilink(n)}
                            className={cn(
                                "flex items-center gap-3 px-2 py-1.5 rounded-lg text-sm text-left transition-colors",
                                i === wikilinkIndex ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                            )}
                        >
                            <div className={cn("p-1.5 rounded-md flex items-center justify-center border", i === wikilinkIndex ? "bg-background border-primary/20 shadow-sm" : "bg-muted/50 border-transparent")}>
                                <StickyNote className="h-3.5 w-3.5" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="font-medium text-xs truncate">{n.title}</p>
                                <p className="text-xs text-muted-foreground truncate opacity-60">
                                    {formatDistanceToNow(new Date(n.updatedAt), { addSuffix: true })}
                                </p>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )

    const renderedMarkdown = useMemo(
        () => (viewMode === 'preview' || viewMode === 'split') && content.trim() ? renderMarkdown(content, handleToggleTask) : null,
        [viewMode, content, handleToggleTask]
    )

    const previewPane = (
        <div ref={previewRef} className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 py-5 prose-sm space-y-0.5 break-words"
            onDoubleClick={handlePreviewDoubleClick}
            onContextMenu={handlePreviewContextMenu}
            onClick={handleWikilinkClick}>
            {renderedMarkdown || (
                <p className="text-muted-foreground/60 text-sm italic">Empty note - click Edit to write something.</p>
            )}
        </div>
    )

    return (
        <div className="flex flex-col h-full bg-card">
            {/* Top Header - Airy and minimal */}
            <div data-theme-part="toolbar" data-theme-inset className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b border-border/40 shrink-0">
                <Button
                    variant="outline"
                    onClick={onClose}
                    className="h-8 gap-1.5 rounded-lg bg-background/80 px-3 text-xs font-medium shadow-sm md:hidden"
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Notes
                </Button>

                <div className="hidden flex-1 items-center gap-3 text-[11px] text-muted-foreground font-medium min-[560px]:flex">
                    <span>Updated {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}</span>
                    <span>·</span>
                    <span>{words} {words === 1 ? 'word' : 'words'}</span>
                    <span aria-live="polite" className="min-w-[3.5rem] text-muted-foreground/60">
                        {saveFailed ? '' : saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : ''}
                    </span>
                    {viewMode === 'edit' && (
                        <>
                            <span>·</span>
                            <Button variant="link" onClick={handleSave} className="!h-auto !p-0 text-[11px] font-medium leading-none text-primary">
                                Save
                            </Button>
                        </>
                    )}
                </div>

                {tags.length > 0 && (
                    <div className="hidden md:flex items-center gap-2 shrink-0 border-r border-border/40 pr-4 mr-1">
                        {tags.slice(0, 3).map(tag => (
                            <span key={tag} className="text-[11px] font-medium text-info">
                                #{tag}
                            </span>
                        ))}
                    </div>
                )}

                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {viewMode === 'edit' && (
                        <Button variant="ghost" size="sm" onClick={handleSave} className="h-7 px-2 text-xs font-medium text-primary hover:bg-primary/10 hover:text-primary min-[560px]:hidden">
                            Save
                        </Button>
                    )}
                    <Tooltip content={viewLabel} side="top">
                        <div data-theme-part="tabs-list" data-theme-inset className="inline-flex p-0.5 rounded-md bg-muted/40 border border-border/40 mr-2">
                            <button data-theme-part="tab" data-theme-inset data-state={viewMode === 'preview' ? 'active' : 'inactive'} onClick={() => setViewMode('preview')}
                                    className={cn('h-6 px-2.5 rounded text-[11px] font-medium transition-[transform,opacity,box-shadow]', viewMode === 'preview' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>Preview</button>
                            <button data-theme-part="tab" data-theme-inset data-state={viewMode === 'edit' ? 'active' : 'inactive'} onClick={() => setViewMode('edit')}
                                    className={cn('h-6 px-2.5 rounded text-[11px] font-medium transition-[transform,opacity,box-shadow]', viewMode === 'edit' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>Edit</button>
                            <button data-theme-part="tab" data-theme-inset data-state={viewMode === 'split' ? 'active' : 'inactive'} onClick={() => setViewMode('split')}
                                    className={cn('h-6 px-2.5 rounded text-[11px] font-medium transition-[transform,opacity,box-shadow] hidden md:block', viewMode === 'split' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>Split</button>
                        </div>
                    </Tooltip>

                    <Tooltip content={note.pinned ? 'Unpin' : 'Pin'} side="top">
                        <Button variant="ghost" onClick={() => updateNote(note.id, { pinned: !note.pinned })}
                            aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                            className={cn('h-7 w-7 flex items-center justify-center p-0 rounded-md transition-colors', note.pinned ? 'text-warning bg-warning/10' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}>
                            <Pin className="h-3.5 w-3.5" />
                        </Button>
                    </Tooltip>
                    <Tooltip content="Delete" side="top">
                        <Button variant="ghost" aria-label="Delete note" onClick={() => setShowDeleteConfirm(true)} className="h-7 w-7 flex items-center justify-center p-0 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    </Tooltip>
                </div>
            </div>

            {/* Toolbar - No background, simplified */}
            <div data-theme-part="toolbar" data-theme-inset className="flex items-center gap-0.5 px-5 py-1 border-b border-border/40 shrink-0 flex-wrap">
                <TB label="Undo (Ctrl+Z)" icon={Undo2} onClick={handleUndo} disabled={historyIndex === 0} />
                <TB label="Redo (Ctrl+Y)" icon={Redo2} onClick={handleRedo} disabled={historyIndex >= history.length - 1} />
                <div className="w-px h-4 bg-border mx-1 shrink-0" />
                <TB label="Bold (Ctrl+B)" icon={Bold} onClick={() => wrapSel('**', '**')} />
                <TB label="Italic (Ctrl+I)" icon={Italic} onClick={() => wrapSel('*', '*')} />
                <TB label="Inline code (Ctrl+E)" icon={Code} onClick={() => wrapSel('`', '`')} />
                <TB label="Strikethrough" icon={Type} onClick={() => wrapSel('~~', '~~')} />
                <div className="w-px h-4 bg-border mx-1 shrink-0" />
                <TB label="Insert link" icon={Link} onClick={insertLink} />
                <TB label="Link to note ([[)" icon={Link2} onClick={insertWikilink} />
                <div className="w-px h-4 bg-border mx-1 shrink-0" />
                <TB label="Heading 1" icon={Heading1} onClick={() => insertAt('# ')} />
                <TB label="Heading 2" icon={Heading2} onClick={() => insertAt('## ')} />
                <TB label="Heading 3" icon={Heading3} onClick={() => insertAt('### ')} />
                <TB label="Blockquote" icon={Quote} onClick={() => insertAt('> ')} />
                <div className="w-px h-4 bg-border mx-1 shrink-0" />
                <TB label="Bullet list" icon={List} onClick={() => insertAt('- ')} />
                <TB label="Numbered list" icon={ListOrdered} onClick={() => insertAt('1. ')} />
                <TB label="Task list" icon={Check} onClick={() => insertAt('- [ ] ')} />
                <div className="relative">
                    <TB label="Insert table" icon={Table} onClick={() => setShowGridPicker(v => !v)} className={showGridPicker ? 'bg-muted/60' : ''} />
                    {showGridPicker && <GridPicker onSelect={handleGridSelect} onClose={() => setShowGridPicker(false)} />}
                </div>
                <TB label="Code block" icon={SquareTerminal} onClick={() => wrapSel('```\n', '\n```')} />
                <TB label="Horizontal rule" icon={Minus} onClick={() => insertAt('\n---\n')} />
                <div className="flex-1" />

                <div className="w-px h-4 bg-border mx-1 shrink-0" />
                <TB label="Find & Replace (Ctrl+H)" icon={Search} onClick={() => setShowFind(v => !v)} className={showFind ? 'bg-muted/60' : ''} />
                <div ref={exportRef} className="relative">
                    <TB label="Export" icon={Download} onClick={() => setShowExport(v => !v)} className={showExport ? 'bg-muted/60' : ''} />
                    {showExport && (
                        <div data-theme-part="menu" className="absolute right-0 top-full mt-1 w-44 bg-popover border border-border/40 rounded-lg shadow-xl z-50 overflow-hidden">
                            <button data-theme-part="menu-item" onClick={handleCopyMd} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors">
                                <Copy className="h-3 w-3" /> Copy as Markdown
                            </button>
                            <button data-theme-part="menu-item" onClick={handleCopyHtml} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors">
                                <Copy className="h-3 w-3" /> Copy as HTML
                            </button>
                            <div className="border-t border-border/40" />
                            <button data-theme-part="menu-item" onClick={handleDownloadMd} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors">
                                <Download className="h-3 w-3" /> Download .md
                            </button>
                            <button data-theme-part="menu-item" onClick={handleDownloadHtml} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors">
                                <Download className="h-3 w-3" /> Download .html
                            </button>
                            <button data-theme-part="menu-item" onClick={handleDownloadTxt} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors">
                                <Download className="h-3 w-3" /> Download .txt
                            </button>
                        </div>
                    )}
                </div>
                <TB label="Copy all" icon={copied ? Check : Copy} onClick={handleCopyMd} />
                <div ref={helpRef} className="relative">
                    <Tooltip content="Syntax Help" side="top">
                        <Button variant="ghost" onClick={() => setShowHelp(v => !v)}
                            aria-label="Syntax help"
                            className={cn('h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md', showHelp ? 'bg-muted/60' : 'hover:bg-muted/50')}>
                            <HelpCircle className="h-3.5 w-3.5" />
                        </Button>
                    </Tooltip>
                    {showHelp && helpPos && createPortal(
                        <div
                            ref={helpPopoverRef}
                            data-theme-part="popover"
                            className="fixed w-64 bg-popover border border-border/40 rounded-xl shadow-2xl z-[100] overflow-hidden animate-in fade-in zoom-in-95 duration-100"
                            style={{
                                left: Math.max(8, Math.min(helpPos.left - 256, window.innerWidth - 264)),
                                top: Math.min(helpPos.top + 32, window.innerHeight - 470),
                            }}
                        >
                            <div className="px-3 py-2 text-[13px] font-medium text-foreground/60 border-b border-border/40 bg-muted/30">Markdown Syntax</div>
                            <div className="p-3 space-y-2.5 max-h-[400px] overflow-y-auto">
                                <div className="space-y-1">
                                    <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-tighter">Text Formatting</p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">**bold**</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">*italic*</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">~~strike~~</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">`code`</code>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-tighter">Organization</p>
                                    <div className="flex flex-col gap-1.5 text-[11px]">
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40"># Heading 1</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">## Heading 2</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">- List Item</code>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">- [ ] Task</code>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-tighter">Special Features</p>
                                    <div className="flex flex-col gap-1.5 text-[11px]">
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-primary/12 text-primary px-1 py-0.5 rounded border border-primary/25">[[Note Title]]</code>
                                            <span className="text-muted-foreground/60 scale-90">Wikilink</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-info/10 text-info px-1 py-0.5 rounded border border-info/20">#tag</code>
                                            <span className="text-muted-foreground/60 scale-90">Tagging</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <code className="text-xs bg-muted px-1 py-0.5 rounded border border-border/40">/</code>
                                            <span className="text-muted-foreground/60 scale-90">Slash Commands</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>,
                        document.body
                    )}
                </div>
                <Tooltip content="Shortcuts" side="top">
                    <Button variant="ghost" onClick={() => setShowShortcuts(v => !v)}
                        aria-label="Keyboard shortcuts"
                        className={cn('h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md', showShortcuts ? 'bg-muted/60' : 'hover:bg-muted/50')}>
                        <Keyboard className="h-3.5 w-3.5" />
                    </Button>
                </Tooltip>
            </div>

            {showShortcuts && (
                <div className="border-b bg-muted/10 px-4 py-3 text-xs text-muted-foreground/70 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 shrink-0">
                    {[
                        ['Ctrl+B', 'Bold'], ['Ctrl+I', 'Italic'], ['Ctrl+E', 'Inline code'],
                        ['Ctrl+S', 'Save'], ['Ctrl+P', 'Cycle view'], ['Ctrl+Z', 'Undo'],
                        ['Ctrl+Y', 'Redo'], ['Ctrl+H', 'Find & Replace'], ['Tab', 'Indent'],
                        ['Esc', 'Save & close panel'],
                    ].map(([k, d]) => (
                        <div key={k} className="flex items-center gap-2">
                            <kbd className="bg-muted border border-border/40 rounded px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                            <span>{d}</span>
                        </div>
                    ))}
                </div>
            )}

            {showFind && (
                <div data-theme-part="toolbar" data-theme-inset className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 px-3 py-1.5 border-b bg-muted/10 shrink-0">
                    <input
                        data-theme-part="input"
                        value={findText}
                        aria-label="Find in note"
                        onChange={e => setFindText(e.target.value)}
                        placeholder="Find..."
                        className="flex-1 bg-background/60 border border-border/40 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                        autoFocus
                    />
                    <input
                        data-theme-part="input"
                        value={replaceText}
                        aria-label="Replace with"
                        onChange={e => setReplaceText(e.target.value)}
                        placeholder="Replace..."
                        className="flex-1 bg-background/60 border border-border/40 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button variant="ghost" size="sm" onClick={handleReplaceNext} disabled={!findText} className="h-6 px-2 text-xs">Replace</Button>
                    <Button variant="ghost" size="sm" onClick={handleReplaceAll} disabled={!findText} className="h-6 px-2 text-xs">All</Button>
                    <Button variant="ghost" size="icon" onClick={() => setShowFind(false)} className="h-6 w-6 flex items-center justify-center shrink-0" aria-label="Close find bar">
                        <X className="h-3 w-3" />
                    </Button>
                </div>
            )}

            <div className="px-4 sm:px-6 pt-5 pb-1 shrink-0">
                <input
                    data-theme-part="inline-input"
                    value={title}
                    aria-label="Note title"
                    onChange={handleTitleChange}
                    onBlur={handleTitleBlur}
                    placeholder="Untitled"
                    className="w-full bg-transparent text-2xl sm:text-[36px] font-bold outline-none tracking-apple-tight placeholder:text-muted-foreground/20"
                />
            </div>

            <div className={cn(
                'flex-1 min-h-0',
                viewMode === 'split' ? 'grid grid-cols-2 divide-x divide-border' : 'flex'
            )}>
                {(viewMode === 'edit' || viewMode === 'split') && editorPane}
                {(viewMode === 'preview' || viewMode === 'split') && previewPane}
            </div>

            {backlinks.length > 0 && (
                <div data-theme-part="toolbar" data-theme-inset className="px-5 py-2.5 border-t bg-muted/5 shrink-0 flex items-center gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60 shrink-0">Backlinks</span>
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                        {backlinks.map(bl => (
                            <button
                                key={bl.id}
                                data-theme-part="button"
                                onClick={() => onNavigateToNote?.(bl.id)}
                                className="px-2 py-0.5 rounded-md bg-primary/8 text-primary text-xs font-medium hover:bg-primary/15 transition-colors border border-primary/10 whitespace-nowrap"
                            >
                                {bl.title}
                            </button>
                        ))}
                    </div>
                </div>
            )}


            {contextMenu && (
                <TableContextMenu
                    x={contextMenu.x} y={contextMenu.y} isHeader={contextMenu.isHeader}
                    onAction={handleTableAction} onClose={() => setContextMenu(null)}
                />
            )}
            {editingCell && (
                <input
                    key={`${editingCell.tableStart}-${editingCell.row}-${editingCell.col}`}
                    ref={cellInputRef}
                    data-theme-part="input"
                    autoFocus
                    value={editingCell.value}
                    onChange={e => setEditingCell({ ...editingCell, value: e.target.value })}
                    onBlur={handleCellEditCommit}
                    onKeyDown={e => { if (e.key === 'Enter') handleCellEditCommit(); if (e.key === 'Escape') setEditingCell(null) }}
                    className="fixed z-[100] px-2 py-1 text-sm border border-primary/50 bg-background rounded shadow-lg outline-none"
                    style={{ left: editingCell.left, top: editingCell.top, width: Math.max(editingCell.width, 80), height: editingCell.height }}
                />
            )}

            <ConfirmationDialog
                open={showDeleteConfirm}
                onOpenChange={setShowDeleteConfirm}
                title="Delete Note?"
                description="This note will be moved to trash."
                confirmText="Delete"
                isDestructive={true}
                onConfirm={handleDelete}
            />
        </div>
    )
}

function NoteCard({ 
    note, isActive, isSelected, selectionMode, onSelect, onClick 
}: { 
    note: NoteMeta; isActive: boolean; isSelected?: boolean; selectionMode?: boolean; onSelect?: (id: string) => void; onClick: () => void 
}) {
    const tags = note.tags

    return (
        <button onClick={selectionMode ? () => onSelect?.(note.id) : onClick}
            data-theme-part="nav-item"
            data-theme-inset
            data-state={isActive && !selectionMode ? 'active' : 'inactive'}
            className={cn('w-full text-left px-3 py-3 border-b border-border/40 transition-[transform,opacity,box-shadow] hover:bg-muted/40 group relative', isActive && !selectionMode && 'bg-primary/12', isSelected && 'bg-primary/8')}>
            {isActive && !selectionMode && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r" />
            )}
            <div className="flex items-start gap-2 min-w-0 pl-1">
                {selectionMode && (
                    <div className={cn(
                        "mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-[transform,opacity,box-shadow]",
                        isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 bg-background"
                    )}>
                        {isSelected && <Check className="h-2.5 w-2.5" />}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        {note.pinned && <Pin className="h-2.5 w-2.5 text-primary shrink-0" />}
                        <span className={cn('text-sm font-semibold truncate', isActive ? 'text-foreground' : 'text-foreground/90')}>{note.title}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
                        </span>
                        {note.wikilinks.length > 0 && (
                            <span className="text-xs text-muted-foreground/60">{note.wikilinks.length} link{note.wikilinks.length !== 1 ? 's' : ''}</span>
                        )}
                    </div>
                    {tags.length > 0 && (
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                            {tags.slice(0, 3).map(tag => (
                                <span key={tag} data-theme-part="badge" className="px-1 py-0 rounded bg-info/10 text-info text-xs font-medium">
                                    #{tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </button>
    )
}

export function NotesPage() {
    useDocumentTitle('Notes')
    const location = useLocation()
    const requestedNoteId = new URLSearchParams(location.search).get('note')
    const openedNoteLink = useRef<string | null>(null)
    const notes = useNotesStore(s => s.notes)
    const trash = useNotesStore(s => s.trash)
    const createNote = useNotesStore(s => s.createNote)
    const restoreNote = useNotesStore(s => s.restoreNote)
    const emptyTrash = useNotesStore(s => s.emptyTrash)
    const trashAllNotes = useNotesStore(s => s.trashAllNotes)
    const loadNoteContent = useNotesStore(s => s.loadNoteContent)
    const activeNote = useNotesStore(s => s.activeNote)
    const saveFailed = useNotesStore(s => s.saveFailed)

    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [showEditor, setShowEditor] = useState(false)
    const [view, setView] = useState<'notes' | 'trash' | 'graph'>('notes')
    const [activeTag, setActiveTag] = useState<string | null>(null)
    const [selectionMode, setSelectionMode] = useState(false)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [eraseAllOpen, setEraseAllOpen] = useState(false)
    const [emptyTrashOpen, setEmptyTrashOpen] = useState(false)
    const [isErasing, setIsErasing] = useState(false)
    const searchRef = useRef<HTMLInputElement>(null)
    const importInputRef = useRef<HTMLInputElement>(null)
    const sidebarCollapsed = useUIStore(s => s.notesSidebarCollapsed)
    const setSidebarCollapsed = useUIStore(s => s.setNotesSidebarCollapsed)

    const sorted = useMemo(() => [...notes].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    }), [notes])

    const allTags = useMemo(() => {
        const tagMap = new Map<string, number>()
        for (const n of notes) {
            for (const t of n.tags) {
                tagMap.set(t, (tagMap.get(t) || 0) + 1)
            }
        }
        return [...tagMap.entries()].sort((a, b) => b[1] - a[1])
    }, [notes])

    const filteredNotes = useMemo(() => {
        let result = sorted
        if (activeTag) {
            result = result.filter(n => n.tags.includes(activeTag))
        }
        if (search.trim()) {
            const q = search.toLowerCase()
            result = result.filter(n =>
                n.title.toLowerCase().includes(q) ||
                n.tags.some(t => t.toLowerCase().includes(q)) ||
                n.wikilinks.some(w => w.toLowerCase().includes(q))
            )
        }
        return result
    }, [sorted, search, activeTag])

    const filteredTrash = useMemo(() => search.trim()
        ? [...trash].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .filter(n => n.title.toLowerCase().includes(search.toLowerCase()))
        : [...trash].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    , [trash, search])

    const filtered = view === 'trash' ? filteredTrash : filteredNotes

    const selected = selectedId ? activeNote?.id === selectedId ? activeNote : null : null

    type VirtualItem = { type: 'header'; label: string; icon?: React.ReactNode } | { type: 'note'; note: NoteMeta } | { type: 'trash'; note: Note }

    const virtualItems = useMemo<VirtualItem[]>(() => {
        if (view === 'trash') return filtered.map(note => ({ type: 'trash' as const, note: note as Note }))
        if (search || activeTag) return filtered.map(note => ({ type: 'note' as const, note: note as NoteMeta }))

        const items: VirtualItem[] = []
        const pinned = filtered.filter(n => n.pinned)
        const unpinned = filtered.filter(n => !n.pinned)

        if (pinned.length > 0) {
            items.push({ type: 'header', label: 'Pinned', icon: <Pin className="h-2.5 w-2.5" /> })
            pinned.forEach(n => items.push({ type: 'note', note: n }))
            items.push({ type: 'header', label: 'All Notes', icon: <Hash className="h-2.5 w-2.5" /> })
        }

        const groups = groupNotesByDate(unpinned)
        for (const group of groups) {
            items.push({ type: 'header', label: group.label })
            for (const n of group.notes) items.push({ type: 'note', note: n })
        }
        return items
    }, [filtered, view, search, activeTag])

    const listRef = useRef<HTMLDivElement>(null)
    const virtualizer = useVirtualizer({
        count: virtualItems.length,
        getScrollElement: () => listRef.current,
        estimateSize: (i) => virtualItems[i].type === 'header' ? 28 : 72,
        overscan: 10,
    })

    const handleCreate = useCallback(async () => {
        const note = await createNote('Untitled', '')
        setSelectedId(note.id)
        setView('notes')
        setShowEditor(true)
    }, [createNote])

    const handleSelect = useCallback(async (id: string) => {
        setSelectedId(id); setShowEditor(true)
        await loadNoteContent(id)
    }, [loadNoteContent])

    useEffect(() => {
        if (requestedNoteId && notes.some(note => note.id === requestedNoteId)) {
            const linkKey = `${location.key}:${requestedNoteId}`
            if (openedNoteLink.current !== linkKey) {
                openedNoteLink.current = linkKey
                setSelectedId(requestedNoteId)
                setView('notes')
                setSearch('')
                setActiveTag(null)
                setShowEditor(true)
                void loadNoteContent(requestedNoteId)
            }
            return
        }
        if (!selectedId && sorted.length > 0) {
            const firstId = sorted[0].id
            setSelectedId(firstId)
            loadNoteContent(firstId)
        }
    }, [selectedId, sorted, notes, loadNoteContent, requestedNoteId, location.key])

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                e.preventDefault(); handleCreate()
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [handleCreate])

    const handleExportZip = useCallback(async (ids?: string[]) => {
        let allNotesWithContent: Note[]
        try {
            allNotesWithContent = await useNotesStore.getState().getAllNotesWithContent()
        } catch {
            toast({ variant: 'destructive', title: 'Notes export paused', description: 'Some notes could not be read. No partial backup was created. Unlock your vault or restore its key, then retry.', href: '/vault' })
            return
        }
        const files: Record<string, Uint8Array> = {}
        const notesToExport = ids ? allNotesWithContent.filter(n => ids.includes(n.id)) : allNotesWithContent
        if (notesToExport.length === 0) return

        notesToExport.forEach(note => {
            const title = note.title === 'Untitled' ? `Untitled_${note.id.substring(0,6)}` : note.title.replace(/[^a-zA-Z0-9 _-]/g, '_')
            let finalName = `${title}.md`
            let counter = 1
            while (files[finalName]) {
                finalName = `${title} (${counter}).md`
                counter++
            }
            files[finalName] = strToU8(note.content || '')
        })
        const zipped = zipSync(files)
        const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = ids ? `Selected_Notes_${format(new Date(), 'yyyy-MM-dd')}.zip` : `Notes_Backup_${format(new Date(), 'yyyy-MM-dd')}.zip`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }, [])

    const handleImportFiles = useCallback(async (files: File[]) => {
        const createNote = useNotesStore.getState().createNote
        let imported = 0
        let skipped = 0

        for (const file of files) {
            if (/\.zip$/i.test(file.name)) {
                let entries: Record<string, Uint8Array>
                try {
                    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
                } catch {
                    skipped++
                    continue
                }
                const mdNames = Object.keys(entries).filter(n => /\.(md|markdown)$/i.test(n)).sort()
                if (mdNames.length === 0) {
                    toast({ variant: 'destructive', title: 'No notes found', description: `${file.name} contains no .md files.` })
                    continue
                }
                if (mdNames.length > MAX_IMPORT_ZIP_ENTRIES) {
                    toast({ variant: 'destructive', title: 'Archive too large', description: `${file.name} has ${mdNames.length} entries (max ${MAX_IMPORT_ZIP_ENTRIES}).` })
                    continue
                }
                const totalBytes = mdNames.reduce((sum, n) => sum + entries[n].length, 0)
                if (totalBytes > MAX_IMPORT_ZIP_TOTAL_BYTES) {
                    toast({ variant: 'destructive', title: 'Archive too large', description: `Uncompressed content exceeds ${Math.floor(MAX_IMPORT_ZIP_TOTAL_BYTES / (1024 * 1024))} MB.` })
                    continue
                }
                for (const name of mdNames) {
                    if (await importMarkdownFile(name, entries[name], createNote)) imported++
                    else skipped++
                }
            } else if (/\.(md|markdown)$/i.test(file.name)) {
                if (await importMarkdownFile(file.name, new Uint8Array(await file.arrayBuffer()), createNote)) imported++
                else skipped++
            } else {
                skipped++
            }
        }

        if (imported > 0) {
            toast({ title: 'Import complete', description: `Imported ${imported} note${imported !== 1 ? 's' : ''}${skipped > 0 ? ` · ${skipped} skipped` : ''}.` })
        } else if (skipped > 0) {
            toast({ variant: 'destructive', title: 'Nothing imported', description: 'Use .md files or a notes backup ZIP (max 2 MB per note).' })
        }
    }, [])

    const toggleSelection = useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])

    const handleBulkDelete = useCallback(async () => {
        const deleteNote = useNotesStore.getState().deleteNote
        for (const id of selectedIds) {
            await deleteNote(id)
        }
        setSelectedIds(new Set())
        setSelectionMode(false)
    }, [selectedIds])

    return (
        <div className="flex flex-col gap-4">
            {saveFailed && (
                <div data-theme-part="panel" data-theme-tone="status" className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                    <span>Failed to save changes. Your latest edits may not be persisted.</span>
                </div>
            )}
        <div className="flex flex-col md:flex-row gap-6 h-[calc(100vh-16rem)] min-h-[500px]">
            <div data-theme-part="card" className={cn(
                'flex flex-col w-full md:w-[300px] min-h-0 flex-1 md:flex-none md:shrink-0 bg-card border border-border/40 rounded-2xl shadow-sm overflow-hidden transition-[width] duration-200',
                showEditor && selected ? 'hidden md:flex' : 'flex',
                sidebarCollapsed && 'md:w-[52px]'
            )}>
            <div className={cn('flex flex-col min-h-0 flex-1', sidebarCollapsed && 'md:hidden')}>
                <div className="flex items-center gap-2 px-3 pt-4 pb-2 shrink-0">
                    <div className="flex-1 min-w-0">
                        <h1 className="text-lg font-bold tracking-tight">
                            {view === 'trash' ? 'Recently Deleted' : 'Notes'}
                        </h1>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {view === 'trash'
                                ? `${trash.length} ${trash.length === 1 ? 'item' : 'items'} · auto-purge after 30 days`
                                : `${notes.length} note${notes.length !== 1 ? 's' : ''}`
                            }
                        </p>
                    </div>
                    {view !== 'trash' ? (
                        <div className="flex items-center gap-1.5">
                            <Tooltip content={selectionMode ? "Exit Selection" : "Select Notes"} side="left">
                                <Button variant={selectionMode ? 'default' : 'ghost'} onClick={() => { setSelectionMode(!selectionMode); setSelectedIds(new Set()) }}
                                    aria-label={selectionMode ? 'Exit note selection' : 'Select notes'}
                                    className={cn("h-7 w-7 flex items-center justify-center p-0 shrink-0 shadow-none", selectionMode ? "bg-primary text-primary-foreground hover:bg-primary/90" : "text-muted-foreground hover:text-foreground")}>
                                    <ListChecks className="h-4 w-4" />
                                </Button>
                            </Tooltip>
                            <Tooltip content={view === 'graph' ? "Close Graph" : "Graph View"} side="left">
                                <Button variant={view === 'graph' ? 'secondary' : 'ghost'} onClick={() => setView(view === 'graph' ? 'notes' : 'graph')}
                                    aria-label={view === 'graph' ? 'Close graph view' : 'Open graph view'}
                                    className="h-7 w-7 flex items-center justify-center p-0 shrink-0 text-muted-foreground hover:text-foreground">
                                    <Network className="h-4 w-4" />
                                </Button>
                            </Tooltip>
                            <Tooltip content="New note" side="right">
                                <Button variant="default" onClick={handleCreate}
                                    aria-label="New note"
                                    className="relative h-7 w-7 flex items-center justify-center p-0 shrink-0 shadow-sm rounded-lg">
                                    <Plus className="h-4 w-4" />
                                </Button>
                            </Tooltip>
                        </div>
                    ) : (
                        trash.length > 0 && (
                            <Tooltip content="Empty trash" side="right">
                                <Button variant="ghost" onClick={() => setEmptyTrashOpen(true)}
                                    aria-label="Empty trash"
                                    className="h-7 px-2 shrink-0 text-xs font-semibold text-destructive hover:bg-destructive/10">
                                    <Trash className="h-3 w-3" /> Empty
                                </Button>
                            </Tooltip>
                        )
                    )}
                </div>

                <div className="px-3 pb-2 shrink-0">
                    <div data-theme-part="tabs-list" data-theme-inset className="grid grid-cols-2 gap-1.5 rounded-2xl border border-border/40 bg-card p-1.5 shadow-sm">
                        <Button variant="ghost" onClick={() => setView('notes')}
                            data-theme-part="tab"
                            data-theme-inset
                            data-state={view !== 'trash' ? 'active' : 'inactive'}
                            className={cn('h-8 rounded-xl border border-transparent text-xs font-semibold transition-colors', view !== 'trash' ? 'border-border/40 bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40')}>
                            <StickyNote className="h-3.5 w-3.5" />
                            Notes
                            <span data-theme-part="badge" className="ml-auto rounded-md bg-muted/60 px-1.5 text-xs tabular-nums text-muted-foreground">{notes.length}</span>
                        </Button>
                        <Button variant="ghost" onClick={() => setView('trash')}
                            data-theme-part="tab"
                            data-theme-inset
                            data-state={view === 'trash' ? 'active' : 'inactive'}
                            className={cn('h-8 rounded-xl border border-transparent text-xs font-semibold transition-colors', view === 'trash' ? 'border-border/40 bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40')}>
                            <Trash className="h-3.5 w-3.5" />
                            Deleted
                            {trash.length > 0 && <span data-theme-part="badge" className="ml-auto rounded-md bg-muted/60 px-1.5 text-xs tabular-nums text-muted-foreground">{trash.length}</span>}
                        </Button>
                    </div>
                </div>

                {view === 'notes' && allTags.length > 0 && (
                    <div className="px-3 pb-2 shrink-0">
                        <div className="flex items-center gap-1 flex-wrap">
                            <button
                                onClick={() => setActiveTag(null)}
                                data-theme-part="tab"
                                data-theme-inset
                                data-state={!activeTag ? 'active' : 'inactive'}
                                className={cn(
                                    'px-2 py-0.5 rounded-full text-xs font-medium transition-[transform,opacity,box-shadow] border whitespace-nowrap',
                                    !activeTag ? 'bg-primary/12 text-primary border-primary/25' : 'text-muted-foreground border-transparent hover:text-foreground'
                                )}
                            >
                                All
                            </button>
                            {allTags.slice(0, 8).map(([tag]) => (
                                <button
                                    key={tag}
                                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                                    data-theme-part="tab"
                                    data-theme-inset
                                    data-state={activeTag === tag ? 'active' : 'inactive'}
                                    className={cn(
                                        'px-2 py-0.5 rounded-full text-xs font-medium transition-[transform,opacity,box-shadow] border whitespace-nowrap',
                                        activeTag === tag ? 'bg-primary/12 text-primary border-primary/25' : 'text-muted-foreground border-transparent hover:text-foreground'
                                    )}
                                >
                                    #{tag}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="px-3 pb-2 shrink-0">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
                        <input
                            ref={searchRef}
                            aria-label="Search notes"
                            data-theme-part="input"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search…"
                            className="w-full bg-muted/30 border border-border/40 rounded-lg pl-8 pr-7 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring focus:border-primary/50"
                        />
                        {search && (
                            <button data-theme-part="button" aria-label="Clear note search" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground">
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>

                <div ref={listRef} className="flex-1 overflow-y-auto">
                    {virtualItems.length === 0 && view !== 'trash' && !search && !activeTag ? (
                        <NotesEmptyState onAdd={handleCreate} />
                    ) : virtualItems.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
                            {view === 'trash' ? (
                                <>
                                    <Trash className="h-7 w-7 text-muted-foreground/20" />
                                    <p className="text-xs text-muted-foreground/60">Trash is empty</p>
                                </>
                            ) : (
                                <>
                                    <StickyNote className="h-7 w-7 text-muted-foreground/20" />
                                    <p className="text-xs text-muted-foreground/60">No notes match</p>
                                </>
                            )}
                        </div>
                    ) : (
                        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                            {virtualizer.getVirtualItems().map(vItem => {
                                const item = virtualItems[vItem.index]
                                return (
                                    <div
                                        key={vItem.key}
                                        style={{ position: 'absolute', top: vItem.start, left: 0, width: '100%' }}
                                        ref={virtualizer.measureElement}
                                        data-index={vItem.index}
                                    >
                                        {item.type === 'header' ? (
                                            <div className="px-3 pt-3 pb-1">
                                                <span className="text-xs font-medium uppercase text-muted-foreground flex items-center gap-1.5">
                                                    {item.icon}{item.label}
                                                </span>
                                            </div>
                                        ) : item.type === 'trash' ? (
                                            <div className="px-3 py-3 border-b border-border/30 flex items-start gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-semibold truncate text-muted-foreground">{item.note.title}</p>
                                                    <p className="text-xs text-muted-foreground/60 mt-0.5">
                                                        Deleted {formatDistanceToNow(new Date(item.note.updatedAt), { addSuffix: true })}
                                                    </p>
                                                </div>
                                                <Tooltip content="Restore note" side="left">
                                                    <button data-theme-part="button" onClick={() => restoreNote(item.note.id)}
                                                        aria-label={`Restore ${item.note.title}`}
                                                        className="shrink-0 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-primary transition-colors">
                                                        <RotateCcw className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tooltip>
                                            </div>
                                        ) : (
                                            <NoteCard
                                                note={item.note}
                                                isActive={item.note.id === selectedId}
                                                isSelected={selectedIds.has(item.note.id)}
                                                selectionMode={selectionMode}
                                                onSelect={toggleSelection}
                                                onClick={() => handleSelect(item.note.id)}
                                            />
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
                {selectionMode && selectedIds.size > 0 && (
                    <div data-theme-part="toolbar" data-theme-inset className="p-3 border-t bg-card shrink-0 flex items-center justify-between gap-2 animate-in slide-in-from-bottom-2 duration-200 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
                        <span className="text-[13px] font-medium text-foreground/60">{selectedIds.size} selected</span>
                        <div className="flex items-center gap-1.5">
                            <Button variant="outline" size="sm" onClick={() => handleExportZip(Array.from(selectedIds))} className="h-7 text-xs gap-1.5 px-2.5 border-border/40">
                                <Download className="h-3 w-3" /> Backup
                            </Button>
                            <Button variant="destructive" size="sm" onClick={handleBulkDelete} className="h-7 text-xs gap-1.5 px-2.5">
                                <Trash2 className="h-3 w-3" /> Trash
                            </Button>
                        </div>
                    </div>
                )}
                {!selectionMode && (
                    <div data-theme-part="toolbar" data-theme-inset className="mt-auto px-3 py-2 border-t border-border/40 shrink-0 flex items-center justify-between gap-2">
                        <input
                            ref={importInputRef}
                            type="file"
                            accept=".md,.markdown,.zip"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                const files = Array.from(e.target.files || [])
                                if (files.length > 0) handleImportFiles(files)
                                e.target.value = ''
                            }}
                        />
                        <div className="flex items-center gap-1 min-w-0">
                            <Tooltip content="Import .md files or a notes backup ZIP" side="top">
                                <Button variant="ghost" onClick={() => importInputRef.current?.click()} className="shrink-0 justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                                    <Upload className="h-3.5 w-3.5" /> Import
                                </Button>
                            </Tooltip>
                            <Tooltip content="Download a ZIP backup of all notes" side="top">
                                <Button variant="ghost" onClick={() => handleExportZip()} className="shrink-0 justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                                    <Download className="h-3.5 w-3.5" /> Backup
                                </Button>
                            </Tooltip>
                            <Tooltip content="Erase all notes" side="top">
                                <Button variant="ghost" aria-label="Erase all notes" onClick={() => setEraseAllOpen(true)} disabled={notes.length === 0} className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive">
                                    <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                            </Tooltip>
                        </div>
                        <ConfirmationDialog
                            open={emptyTrashOpen}
                            onOpenChange={setEmptyTrashOpen}
                            title="Empty Trash?"
                            description={`${trash.length} deleted note${trash.length === 1 ? '' : 's'} will be permanently erased. This cannot be undone.`}
                            confirmText="Empty Trash"
                            isDestructive={true}
                            onConfirm={() => { setEmptyTrashOpen(false); emptyTrash() }}
                        />
                        <ConfirmationDialog
                            open={eraseAllOpen}
                            onOpenChange={setEraseAllOpen}
                            title="Erase All Notes"
                            description={`Are you sure you want to erase all ${notes.length} notes? They move to Deleted, where they can be restored or emptied.`}
                            confirmText="Erase All"
                            isDestructive={true}
                            isLoading={isErasing}
                            disabled={notes.length === 0}
                            onConfirm={async () => {
                                setIsErasing(true)
                                try {
                                    await trashAllNotes()
                                    toast({ title: 'Notes Erased', description: 'All notes were moved to Deleted.' })
                                    setEraseAllOpen(false)
                                } finally {
                                    setIsErasing(false)
                                }
                            }}
                        />
                        <Tooltip content="Collapse sidebar" side="right">
                            <Button variant="ghost" onClick={() => setSidebarCollapsed(true)}
                                aria-label="Collapse notes sidebar"
                                className="hidden md:inline-flex h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground">
                                <PanelLeftClose className="h-4 w-4" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
            </div>
            {sidebarCollapsed && (
                <div className="hidden md:flex flex-col items-center gap-2 px-2 py-4 min-h-0 flex-1">
                    {view !== 'trash' && (
                        <>
                            <Tooltip content="New note" side="right">
                                <Button variant="default" onClick={handleCreate}
                                    aria-label="New note"
                                    className="h-8 w-8 shrink-0 p-0 shadow-sm rounded-lg">
                                    <Plus className="h-4 w-4" />
                                </Button>
                            </Tooltip>
                            <Tooltip content={view === 'graph' ? "Close Graph" : "Graph View"} side="right">
                                <Button variant={view === 'graph' ? 'secondary' : 'ghost'} onClick={() => setView(view === 'graph' ? 'notes' : 'graph')}
                                    aria-label={view === 'graph' ? 'Close graph view' : 'Open graph view'}
                                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground">
                                    <Network className="h-4 w-4" />
                                </Button>
                            </Tooltip>
                            <span data-theme-part="badge" className="mt-1 rounded-full bg-muted px-1.5 text-[10px] font-bold leading-4 text-muted-foreground tabular-nums">
                                {notes.length}
                            </span>
                        </>
                    )}
                    <div className="mt-auto">
                        <Tooltip content="Expand sidebar" side="right">
                            <Button variant="ghost" onClick={() => setSidebarCollapsed(false)}
                                aria-label="Expand notes sidebar"
                                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground">
                                <PanelLeftOpen className="h-4 w-4" />
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            )}
            </div>

            <div data-theme-part="card" className={cn(
                'flex flex-1 min-w-0 flex-col bg-card border border-border/40 rounded-2xl shadow-sm overflow-hidden',
                (view === 'graph' || (showEditor && selected && view === 'notes')) ? 'flex' : 'hidden md:flex'
            )}>
                {view === 'graph' ? (
                    <NotesGraph notes={notes} onNodeClick={(id) => { setView('notes'); handleSelect(id); }} />
                ) : selected && view === 'notes' ? (
                    <NoteEditor key={selected.id} note={selected} onClose={() => { setShowEditor(false); setSelectedId(null) }} onNavigateToNote={(id) => { setSelectedId(id); setShowEditor(true); loadNoteContent(id) }} allNotes={notes} />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6 bg-card">
                        {view === 'trash' ? (
                            <>
                                <Trash className="h-12 w-12 text-muted-foreground/15" />
                                <div className="space-y-1">
                                    <p className="text-sm font-semibold text-muted-foreground/60">Recently Deleted</p>
                                    <p className="text-xs text-muted-foreground/60">Notes are kept for 30 days before being permanently removed.</p>
                                </div>
                            </>
                        ) : (
                            <>
                                <StickyNote className="h-12 w-12 text-muted-foreground/15" />
                                <p className="text-sm font-semibold text-muted-foreground/60">Select a note to open it</p>
                                <Button variant="default" onClick={handleCreate}
                                    className="gap-1.5 h-8 px-4 rounded-lg text-xs font-semibold shadow-sm">
                                    <Plus className="h-3.5 w-3.5" /> New Note
                                </Button>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
        </div>
    )
}
