import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, maskProfileLevel } from '@/lib/utils'
import type { Profile } from '@/types/profile'
import { GripVertical, Pencil, Plus, User } from 'lucide-react'
import { ProfileDialog } from '../profiles/ProfileDialog'
import { ProfileReorderDialog } from '../profiles/ProfileReorderDialog'
import { AnimatedSettingsIcon } from '../ui/AnimatedIcons'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/store/uiStore'
import { getSidebarHighlight } from './library-sidebar-selection'

interface LibrarySidebarProps {
  profiles: Profile[]
  selectedProfileId: string | null
  onSelectProfile: (id: string | null) => void
  savedAddonCount: number
  unassignedCount: number
  profileAddonCounts: Record<string, number>
  allTags: string[]
  selectedTag: string | null
  onSelectTag: (tag: string | null) => void
  tagCounts: Record<string, number>
  showMobileFilters: boolean
  onCloseMobileFilters: () => void
  onManageTags: () => void
  onDeleteProfile: (id: string) => void
}

interface SidebarRowProps {
  ctrl: string
  label: string
  count: number
  active: boolean
  onClick: () => void
  icon?: ReactNode
  trailing?: ReactNode
}

// Every row (All Addons, Unassigned, profiles, tags) reserves the same fixed w-6
// trailing slot after a w-7 count column, so all counts share one right-aligned
// column. The row is a wrapper so the edit pencil can be a real button inside the
// row bounds (no nested buttons); the selectable area is the inner button.
function SidebarFilterRow({ ctrl, label, count, active, onClick, icon, trailing }: SidebarRowProps) {
  return (
    <div
      data-theme-part="nav-item"
      data-ctrl={ctrl}
      data-count={count}
      data-state={active ? 'active' : 'inactive'}
      className={cn(
        'group flex h-10 w-full shrink items-center gap-1 rounded-xl border px-2.5 text-sm transition-colors [&_svg]:!size-3.5',
        active
          ? 'border-foreground/10 bg-foreground/[0.08] text-foreground shadow-none'
          : 'border-transparent text-foreground/85 hover:bg-muted/50 hover:text-foreground'
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 && (
          <span data-ctrl="row-count" className="w-7 shrink-0 text-right text-xs font-bold tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </button>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">{trailing ?? null}</span>
    </div>
  )
}

// Default "All ..." heading rows: never highlighted, only a non-default pick is.
// Same fixed trailing slot as every other row so the counts stay in one column.
function SidebarAllRow({ ctrl, label, count, onClick }: { ctrl: string; label: string; count: number; onClick: () => void }) {
  return (
    <div
      data-theme-part="nav-item"
      data-ctrl={ctrl}
      data-count={count}
      data-state="inactive"
      className="flex h-9 w-full shrink items-center gap-1 rounded-xl border border-transparent px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <button
        type="button"
        aria-pressed={false}
        onClick={onClick}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate normal-case">{label}</span>
        <span data-ctrl="row-count" className="w-7 shrink-0 text-right text-xs font-bold tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center" />
    </div>
  )
}

export function LibrarySidebar({
  profiles,
  selectedProfileId,
  onSelectProfile,
  savedAddonCount,
  unassignedCount,
  profileAddonCounts,
  allTags,
  selectedTag,
  onSelectTag,
  tagCounts,
  showMobileFilters,
  onCloseMobileFilters,
  onManageTags,
  onDeleteProfile,
}: LibrarySidebarProps) {
  const [showProfileReorderDialog, setShowProfileReorderDialog] = useState(false)
  const { isPrivacyModeEnabled, privacyLevelProfiles } = useUIStore(
    useShallow((state) => ({
      isPrivacyModeEnabled: state.isPrivacyModeEnabled,
      privacyLevelProfiles: state.privacyLevelProfiles
    }))
  )
  const profilePrivacyLevel = isPrivacyModeEnabled ? privacyLevelProfiles : 0
  const nameOf = (profile: Profile) => maskProfileLevel(profile.name, profilePrivacyLevel)

  const handleMobileProfileSelect = (id: string | null) => {
    onSelectProfile(id)
    onCloseMobileFilters()
  }

  const handleMobileTagSelect = (tag: string | null) => {
    onSelectTag(tag)
    onCloseMobileFilters()
  }

  // One selection rule for both sections: defaults never highlighted, at most one
  // highlighted row per section, and a selection without a rendered row highlights
  // nothing.
  const highlight = getSidebarHighlight({
    selectedProfileId,
    selectedTag,
    profileIds: profiles.map((profile) => profile.id),
    visibleTags: allTags.filter((tag) => (tagCounts[tag] || 0) > 0),
  })

  // Section headers keep the app's existing controls: grip = reorder profiles,
  // plus = create profile, settings icon = manage tags.
  const reorderProfilesButton = (
    <Tooltip content="Reorder Profiles">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
        onClick={() => setShowProfileReorderDialog(true)}
        disabled={profiles.length === 0}
        aria-label="Reorder profiles"
        data-ctrl="profiles-reorder"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </Button>
    </Tooltip>
  )
  const createProfileButton = (
    <ProfileDialog trigger={
      <Tooltip content="Create Profile">
        <Button variant="ghost" size="icon" className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground" aria-label="Create profile" data-ctrl="profile-add">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    } />
  )
  const manageTagsButton = (
    <Tooltip content="Manage Tags">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
        onClick={onManageTags}
        aria-label="Manage tags"
        data-ctrl="tags-manage"
      >
        <AnimatedSettingsIcon className="h-3.5 w-3.5" />
      </Button>
    </Tooltip>
  )

  const sectionHeader = (label: string, ctrl: string, actions: ReactNode) => (
    <div className="mb-1 flex items-center justify-between px-2 py-1.5">
      <span data-ctrl={ctrl} className="text-xs font-medium uppercase text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  )

  // Profile rows: the edit pencil lives in the row's fixed trailing slot, inside
  // the row bounds. Desktop: every row has a hover/focus-revealed pencil. Phone
  // Filters sheet: only the selected row renders one.
  const renderProfiles = (mobile: boolean) => profiles.map((profile) => {
    const active = highlight.highlightedProfileKey === profile.id
    const showEdit = mobile ? active : true
    const editPencil = showEdit ? (
      <ProfileDialog
        profile={profile}
        onDelete={onDeleteProfile}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-6 w-6 p-0 text-muted-foreground hover:text-foreground',
              !mobile && 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
            )}
            aria-label="Edit profile"
            data-ctrl="profile-edit"
            data-reveal={mobile ? 'selected-row' : 'hover-focus'}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        }
      />
    ) : null
    return (
      <SidebarFilterRow
        key={profile.id}
        ctrl={mobile ? 'm-profile-row' : 'profile-row'}
        label={nameOf(profile)}
        count={profileAddonCounts[profile.id] || 0}
        active={active}
        onClick={() => (mobile ? handleMobileProfileSelect(profile.id) : onSelectProfile(profile.id))}
        icon={<User className="shrink-0 text-muted-foreground" />}
        trailing={editPencil}
      />
    )
  })

  const renderTags = (mobile: boolean) => allTags.map(tag => {
    const count = tagCounts[tag] || 0
    if (count === 0) return null
    return (
      <SidebarFilterRow
        key={tag}
        ctrl={mobile ? 'm-tag-row' : 'tag-row'}
        label={tag}
        count={count}
        active={highlight.highlightedTag === tag}
        onClick={() => {
          const next = selectedTag === tag ? null : tag
          if (mobile) handleMobileTagSelect(next)
          else onSelectTag(next)
        }}
      />
    )
  })

  return (
    <>
      <div className="hidden md:block md:w-[260px] flex-shrink-0">
        <div data-theme-part="panel" data-ctrl="sidebar-card" className="flex max-h-[calc(100vh-14rem)] flex-col overflow-hidden rounded-2xl border border-border/40 bg-card p-2.5 shadow-sm">
          <ProfileReorderDialog open={showProfileReorderDialog} onOpenChange={setShowProfileReorderDialog} />
          <div className="shrink-0 space-y-1">
            {sectionHeader('Profiles', 'profiles-header', <>{reorderProfilesButton}{createProfileButton}</>)}
            <SidebarAllRow ctrl="all-addons" label="All Addons" count={savedAddonCount} onClick={() => onSelectProfile(null)} />
            <SidebarFilterRow
              ctrl="unassigned"
              label="Unassigned"
              count={unassignedCount}
              active={highlight.highlightedProfileKey === 'unassigned'}
              onClick={() => onSelectProfile('unassigned')}
              icon={<User className="shrink-0 text-muted-foreground" />}
            />
          </div>
          {profiles.length > 0 && (
            <div className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto border-t border-border/35 pt-2 custom-scrollbar">
              {renderProfiles(false)}
            </div>
          )}
          {allTags.length > 0 && (
            <div className="mt-3 shrink-0 space-y-0.5 border-t border-border/35 pt-3">
              {sectionHeader('Tags', 'tags-header', manageTagsButton)}
              <SidebarAllRow ctrl="all-tags" label="All tags" count={savedAddonCount} onClick={() => onSelectTag(null)} />
              {renderTags(false)}
            </div>
          )}
        </div>
      </div>

      {showMobileFilters && (
        <div className="flex md:hidden flex-col gap-3">
          <div data-theme-part="panel" data-ctrl="m-sheet-panel" className="space-y-1 rounded-[1.75rem] border border-border/45 bg-card/80 p-3 shadow-sm">
            {sectionHeader('Profiles', 'm-profiles-header', <>{reorderProfilesButton}{createProfileButton}</>)}
            <SidebarAllRow ctrl="m-all-addons" label="All Addons" count={savedAddonCount} onClick={() => handleMobileProfileSelect(null)} />
            <SidebarFilterRow
              ctrl="m-unassigned"
              label="Unassigned"
              count={unassignedCount}
              active={highlight.highlightedProfileKey === 'unassigned'}
              onClick={() => handleMobileProfileSelect('unassigned')}
              icon={<User className="shrink-0 text-muted-foreground" />}
            />
            {renderProfiles(true)}
          </div>
          {allTags.length > 0 && (
            <div data-theme-part="panel" data-ctrl="m-sheet-panel" className="space-y-1 rounded-[1.75rem] border border-border/45 bg-card/80 p-3 shadow-sm">
              {sectionHeader('Tags', 'm-tags-header', manageTagsButton)}
              <SidebarAllRow ctrl="m-all-tags" label="All tags" count={savedAddonCount} onClick={() => handleMobileTagSelect(null)} />
              {renderTags(true)}
            </div>
          )}
        </div>
      )}
    </>
  )
}
