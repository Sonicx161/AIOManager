import type { ComponentProps } from 'react'
import { AddonIcon } from '@/components/ui/addon-icon'
import { useSavedAddonLogo } from './hooks/useSavedAddonLogo'
import type { SavedAddonLogoTarget } from './saved-addon-logo'

type SavedAddonIconProps = ComponentProps<typeof AddonIcon> & { addon?: SavedAddonLogoTarget }

export function SavedAddonIcon({ addon, logo, ...props }: SavedAddonIconProps) {
  const resolved = useSavedAddonLogo(addon)
  return <AddonIcon {...props} logo={logo || resolved} />
}
