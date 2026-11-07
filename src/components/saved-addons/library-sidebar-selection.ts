// Pure selection rule for the Library sidebar (L1 look): the default rows
// (All Addons, All tags) are never highlighted, and at most one row per section
// (profiles, tags) can carry the A2 selected style. A selection that no longer
// maps to a rendered row (a deleted profile, a tag with no addons left)
// highlights nothing instead of dangling.

export interface SidebarHighlight {
  /** 'unassigned' or a profile id when that row is the pick, else null */
  highlightedProfileKey: string | null
  /** the picked tag when its row renders, else null */
  highlightedTag: string | null
}

export interface SidebarHighlightInput {
  selectedProfileId: string | null
  selectedTag: string | null
  /** ids of the rendered profile rows */
  profileIds: string[]
  /** tags that actually render as rows (count > 0) */
  visibleTags: string[]
}

export function getSidebarHighlight({
  selectedProfileId,
  selectedTag,
  profileIds,
  visibleTags,
}: SidebarHighlightInput): SidebarHighlight {
  const highlightedProfileKey =
    selectedProfileId !== null &&
    (selectedProfileId === 'unassigned' || profileIds.includes(selectedProfileId))
      ? selectedProfileId
      : null
  const highlightedTag =
    selectedTag !== null && visibleTags.includes(selectedTag) ? selectedTag : null
  return { highlightedProfileKey, highlightedTag }
}

/** How many non-default picks are active; drives the phone Filters badge count. */
export function getActiveFilterCount(
  selectedProfileId: string | null,
  selectedTag: string | null
): number {
  return (selectedProfileId !== null ? 1 : 0) + (selectedTag !== null ? 1 : 0)
}
