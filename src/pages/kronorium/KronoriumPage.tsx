import { source, loadPageModule } from '@/lib/source'
import type { ComponentProps } from 'react'
import { use } from 'react'
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page'
import { useLocation, Navigate } from 'react-router-dom'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import * as Components from '@/components/kronorium/KronoriumComponents'
import { Callout } from 'fumadocs-ui/components/callout'
import { Card, Cards } from 'fumadocs-ui/components/card'
import { Steps, Step } from 'fumadocs-ui/components/steps'
import { Tabs, Tab } from 'fumadocs-ui/components/tabs'
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { InstanceTabs } from '@/components/kronorium/InstanceTabs'
import { useDocumentTitle } from '@/hooks/use-document-title'

export function KronoriumPage() {
  const location = useLocation()
  const slug = location.pathname
    .replace(/^\/kronorium\/?/, '')
    .split('/')
    .filter(Boolean)

  const page = source.getPage(slug.length ? slug : [])

  const isIndex = slug.length === 0
  useDocumentTitle(page ? (isIndex ? 'Docs' : page.data.title ?? 'Docs') : '')

  if (!page) return <Navigate to="/404" replace state={{ from: location.pathname }} />

  // The body (and its toc) live in a per-page chunk; the sidebar tree only
  // needed frontmatter, so a first visit suspends under the route loader.
  const mod = use(loadPageModule(page.path) ?? Promise.reject(new Error('Docs page not found')))

  const { default: MDX, toc } = mod

  const content = (
    <MDX
      components={{
        ...defaultMdxComponents,
        Note: (props: ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
        Warning: (props: ComponentProps<typeof Callout>) => <Callout type="warn" {...props} />,
        Tip: (props: ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
        Callout,
        Card,
        Cards,
        Steps,
        Step,
        Tabs,
        Tab,
        Accordions,
        Accordion,
        Hero: Components.Hero,
        NavCards: Components.NavCards,
        NavCard: Components.NavCard,
        SectionHeading: Components.SectionHeading,
        MockupFlow: Components.MockupFlow,
        MockupToggle: Components.MockupToggle,
        DemoAddonCard: Components.DemoAddonCard,
        DemoFailoverChain: Components.DemoFailoverChain,
        DemoVaultKey: Components.DemoVaultKey,
        DemoAccountActions: Components.DemoAccountActions,
        DemoRuleCard: Components.DemoRuleCard,
        DemoDiscordEmbed: Components.DemoDiscordEmbed,
        InstanceTabs: InstanceTabs,
      }}
    />
  )

  if (isIndex) {
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6">
        {content}
      </div>
    )
  }

  return (
    <DocsPage
      toc={toc}
      full={false}
      tableOfContent={{ style: 'clerk' }}
      breadcrumb={{
        enabled: true,
        includePage: true,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        {content}
      </DocsBody>
    </DocsPage>
  )
}
