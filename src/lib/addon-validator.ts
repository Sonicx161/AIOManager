/**
 * Addon Validator
 *
 * Provides validation and fetching of addon manifests for saved addons.
 */

/**
 * Validate saved addon name
 */
export function validateSavedAddonName(name: string): string | null {
  if (!name || typeof name !== 'string') {
    return 'Saved addon name is required'
  }

  const trimmed = name.trim()

  if (trimmed.length === 0) {
    return 'Saved addon name cannot be empty'
  }

  if (trimmed.length > 100) {
    return 'Saved addon name is too long (max 100 characters)'
  }

  return null
}

/**
 * Validate tag name
 */
export function validateTagName(tag: string): string | null {
  if (!tag || typeof tag !== 'string') {
    return 'Tag name is required'
  }

  const trimmed = tag.trim()

  if (trimmed.length === 0) {
    return 'Tag name cannot be empty'
  }

  if (trimmed.length > 50) {
    return 'Tag name is too long (max 50 characters)'
  }

  // Tags should be lowercase alphanumeric with hyphens
  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    return 'Tag name must be lowercase alphanumeric with hyphens only'
  }

  return null
}

/**
 * Normalize tag name
 */
export function normalizeTagName(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

/**
 * Validate tags array
 */
export function validateTags(tags: string[]): string | null {
  if (!Array.isArray(tags)) {
    return 'Tags must be an array'
  }

  for (const tag of tags) {
    const error = validateTagName(tag)
    if (error) {
      return error
    }
  }

  return null
}
