export type LibraryActionSlot = 'save' | 'reinstall'

interface LibraryActionInput {
  protected?: boolean
  official?: boolean
  installed?: boolean
  saved?: boolean
}

export function getLibraryActionSlot(input: LibraryActionInput): LibraryActionSlot {
  const canSave = !input.protected && !input.official && !input.installed
  return canSave && !input.saved ? 'save' : 'reinstall'
}
