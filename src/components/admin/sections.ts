/**
 * Dashboard section registry, shared by the header nav (which replaces the app
 * nav on /dashboard) and the phone drill-in list. Icons are stored as components
 * only: no API imports, so the header stays entry-chunk light.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Activity, ArrowLeft, Clock, Database, Gauge, KeyRound, ScrollText, Server, SlidersHorizontal,
  Terminal, Users, Zap,
} from 'lucide-react'

export interface DashboardSectionSpec {
  id: string
  label: string
  icon: LucideIcon
  group: 'Watch' | 'Operate' | 'Access'
  /** Order matches the approved top-nav mockup. */
  pillOrder: number
}

export const DASHBOARD_SECTIONS: DashboardSectionSpec[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, group: 'Watch', pillOrder: 0 },
  { id: 'users', label: 'Users', icon: Users, group: 'Watch', pillOrder: 1 },
  { id: 'logs', label: 'Logs', icon: Terminal, group: 'Operate', pillOrder: 2 },
  { id: 'system', label: 'System', icon: Server, group: 'Watch', pillOrder: 3 },
  { id: 'autopilot', label: 'Autopilot', icon: Zap, group: 'Watch', pillOrder: 4 },
  { id: 'activity-engine', label: 'Activity engine', icon: Activity, group: 'Watch', pillOrder: 5 },
  { id: 'tasks', label: 'Tasks', icon: Clock, group: 'Operate', pillOrder: 6 },
  { id: 'cache', label: 'Cache', icon: Database, group: 'Operate', pillOrder: 7 },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal, group: 'Access', pillOrder: 8 },
  { id: 'audit', label: 'Audit log', icon: ScrollText, group: 'Access', pillOrder: 9 },
  { id: 'sessions', label: 'Sessions', icon: KeyRound, group: 'Access', pillOrder: 10 },
]

export const DASHBOARD_GROUPS: DashboardSectionSpec['group'][] = ['Watch', 'Operate', 'Access']

/** True when the path is a dashboard section (or the dashboard root). */
export function dashboardSectionId(pathname: string): string | null {
  if (pathname === '/dashboard') return 'overview'
  if (!pathname.startsWith('/dashboard/')) return null
  const rest = pathname.slice('/dashboard/'.length)
  const id = rest.startsWith('users/') ? 'users' : rest.split('/')[0]
  return DASHBOARD_SECTIONS.some(s => s.id === id) ? id : null
}

export interface DashboardNavItem {
  id: string
  label: string
  to: string
  icon: LucideIcon
  match: (path: string) => boolean
}

/** Header pills in order: Back to app first, then the sections by pillOrder. */
export function dashboardNavItems(): DashboardNavItem[] {
  return [
    { id: 'back', label: 'Back to app', to: '/', icon: ArrowLeft, match: () => false },
    ...[...DASHBOARD_SECTIONS].sort((a, b) => a.pillOrder - b.pillOrder).map(spec => ({
      id: spec.id,
      label: spec.label,
      to: `/dashboard/${spec.id}`,
      icon: spec.icon,
      match: (path: string) => dashboardSectionId(path) === spec.id,
    })),
  ]
}
