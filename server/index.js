// Apply stored settings and the account admin state snapshot before loading the server.
import { preloadInstanceSettings } from './lib/settings-boot.js'
import { preloadAccountAdminState } from './admin/account-state.js'

await preloadInstanceSettings()
await preloadAccountAdminState()
await import('./main.js')
