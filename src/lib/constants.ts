import { VaultProvider } from '@/types/vault'

export const PROVIDERS: { value: VaultProvider; label: string; url?: string }[] = [
    { value: 'torbox', label: 'TorBox', url: 'https://torbox.app/settings' },
    { value: 'real-debrid', label: 'Real-Debrid', url: 'https://real-debrid.com/apitoken' },
    { value: 'premiumize', label: 'Premiumize', url: 'https://www.premiumize.me/account' },
    { value: 'alldebrid', label: 'AllDebrid', url: 'https://alldebrid.com/apikeys' },
    { value: 'debrid-link', label: 'Debrid-Link', url: 'https://debrid-link.com/webapp/apikey' },
    { value: 'offcloud', label: 'Offcloud', url: 'https://offcloud.com/#/account' },
    { value: 'put-io', label: 'put.io', url: 'https://app.put.io/settings/account/oauth/apps' },
    { value: 'easynews', label: 'Easynews' },
    { value: 'pikpak', label: 'PikPak', url: 'https://mypikpak.com' },
    { value: 'trakt', label: 'Trakt (Client ID)', url: 'https://trakt.tv/oauth/applications' },
    { value: 'other', label: 'Other/Custom' },
]
