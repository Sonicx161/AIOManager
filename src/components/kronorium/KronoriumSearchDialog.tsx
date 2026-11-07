import {
    SearchDialog,
    SearchDialogClose,
    SearchDialogContent,
    SearchDialogHeader,
    SearchDialogIcon,
    SearchDialogInput,
    SearchDialogList,
    SearchDialogOverlay,
    type SharedProps,
} from 'fumadocs-ui/components/dialog/search'
import { useDocsSearch } from 'fumadocs-core/search/client'
import { searchDocs } from '@/lib/source'
import { useNavigate } from 'react-router-dom'
import { useCallback } from 'react'

export default function KronoriumSearchDialog(props: SharedProps) {
    const { onOpenChange } = props
    const { search, setSearch, query } = useDocsSearch({
        // Async: the first query pulls the corpus chunks and builds the index.
        client: { search: (q: string) => searchDocs(q) },
    })
    const navigate = useNavigate()

    const handleContentClick = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement
        const anchor = target.closest('a')
        if (anchor && anchor.pathname.startsWith('/kronorium')) {
            e.preventDefault()
            navigate(anchor.pathname + anchor.search + anchor.hash)
            onOpenChange?.(false)
        }
    }, [navigate, onOpenChange])

    return (
        <SearchDialog
            search={search}
            onSearchChange={setSearch}
            isLoading={query.isLoading}
            {...props}
        >
            <SearchDialogOverlay className="backdrop-blur-none" />
            <SearchDialogContent onClickCapture={handleContentClick}>
                <SearchDialogHeader>
                    <SearchDialogIcon />
                    <SearchDialogInput placeholder="Search the Kronorium..." />
                    <SearchDialogClose />
                </SearchDialogHeader>
                <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
            </SearchDialogContent>
        </SearchDialog>
    )
}
