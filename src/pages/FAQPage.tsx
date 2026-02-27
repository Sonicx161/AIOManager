import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { GripVertical, Activity, LayoutGrid, ShieldAlert, Palette, Layers, Edit, FileText, Github, ExternalLink, Lightbulb, Key, Zap, Shield, Cloud, Eye, HeartPulse } from 'lucide-react'
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function FAQPage() {
  const location = useLocation()

  useEffect(() => {
    if (location.hash) {
      const element = document.querySelector(location.hash)
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      }
    }
  }, [location])

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div className="text-center mb-6 md:mb-10">
        <h1 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
          Features & FAQ
        </h1>
        <p className="text-muted-foreground text-lg text-balance">
          Master your <strong>AIOManager</strong> experience with these guides.
        </p>
      </div>

      <div className="grid gap-8">

        {/* Section: Motivation */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-yellow-500" />
            Why I Created This
          </h2>
          <Card>
            <CardHeader>
              <CardTitle>The Mission</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-muted-foreground">
                <p>
                  I wanted to build an <strong>account manager</strong> that had full functional and granular control that I just wasn't getting from all the various ones offered in the community.
                </p>
                <p>
                  So I created this and took all the fun stuff I loved from all the projects I enjoyed and built upon them to create the ultimate management experience.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Section: Core Concepts */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-500" />
            Core Concepts
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>The "Library"</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Your personal repository of configured addons. Save them here to create snapshots of difficult configurations (like <strong>AIOStreams</strong> or <strong>AIOMetadata</strong>) and deploy them to any account instantly.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Profiles vs Accounts</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  <strong>Accounts</strong> are your Stremio logins. <strong>Profiles</strong> are your custom sidebar items that link to those accounts. You can group profiles (e.g., "Kids", "Main") to stay organized.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Section: Account Setup */}
        <section id="account-setup" className="space-y-4 scroll-mt-48">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Key className="h-5 w-5 text-orange-500" />
            Account Setup
          </h2>
          <Card>
            <CardHeader>
              <CardTitle>How do I get my AuthKey?</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-muted-foreground">
                <p>
                  Your <strong>AuthKey</strong> is a unique identifier that allows this tool to access your Stremio account. You can retrieve it from your browser's local storage.
                </p>

                <h4 className="font-semibold text-foreground text-sm">Instructions:</h4>
                <ol className="list-decimal list-inside space-y-2 text-sm ml-2">
                  <li>Log into <a href="https://web.stremio.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">web.stremio.com</a>.</li>
                  <li>Press <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">F12</kbd> & select the <strong>Console</strong> tab.</li>
                  <li>Paste this code and press Enter:
                    <pre className="mt-2 text-xs bg-slate-950 p-3 rounded-md overflow-x-auto font-mono text-zinc-300 border border-white/10 select-all whitespace-pre-wrap break-all">
                      JSON.parse(localStorage.getItem("profile")).auth.key
                    </pre>
                  </li>
                  <li>Copy the resulting string and paste it into the AIOManager <strong>Add Account</strong> dialog.</li>
                </ol>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Section: Features */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <LayoutGrid className="h-5 w-5 text-purple-500" />
            Key Features
          </h2>
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-primary" />
                  Activity & Metrics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Track your watch history across all connected accounts. Data is <strong>stored locally</strong> and never leaves your device. View global stats like total watch time and your current watch streak.
                </p>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Edit className="h-4 w-4" /> Catalog Editing
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    Reorder or hide specific catalogs within an addon. Perfect for removing "Popular" lists if you prefer a clean dashboard.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <GripVertical className="h-4 w-4" /> Profile Reordering
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    Click and drag the <GripVertical className="inline h-3 w-3" /> handle in the sidebar to reorder your profiles exactly how you want.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Palette className="h-4 w-4" /> Community Themes
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    Personalize your experience with custom themes inspired by the community's favorite services like Real-Debrid, TorBox, and Trakt.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Batch Operations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    Perform complex actions on multiple accounts at once. Install, remove, clone, or sync addons across your entire collection with just a few clicks. Access this via the <strong>Batch Operations</strong> dialog in the account list.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Section: Autopilot & Automation */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Autopilot & Automation
          </h2>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Failover Chains
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 text-muted-foreground text-sm">
                <p>
                  Create <strong>priority chains</strong> of addons — Autopilot monitors each addon's health and automatically swaps to the next in line if the primary goes down. When the primary recovers, it switches back.
                </p>
                <p>
                  <strong>Quick setup:</strong> Select 2+ addons in the Installed tab, then click the <strong>⚡ Autopilot</strong> button to instantly create a failover chain.
                </p>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <HeartPulse className="h-4 w-4 text-green-500" />
                  Health Monitoring
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Autopilot periodically pings each addon in your chains, tracking latency and reliability points. The <strong>Reliability Score</strong> reflects consecutive successful health checks.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4 text-amber-500" />
                  Manual Override Detection
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  If you manually toggle an addon that's part of an active Autopilot rule, the system automatically pauses that rule to respect your choice. Re-enable it anytime.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Section: Advanced Features */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Shield className="h-5 w-5 text-emerald-500" />
            Advanced Features
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Cloud className="h-4 w-4 text-blue-500" />
                  Cloud Sync
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Optionally sync your data across devices using your UUID. All synced data is <strong>end-to-end encrypted</strong> — the server never sees your credentials or addon configs in plaintext.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Key className="h-4 w-4 text-orange-500" />
                  Stremio OAuth
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Add accounts without manual AuthKey entry. Click <strong>"Login with Stremio"</strong> in the Add Account dialog to authenticate via device code — no copy-pasting required.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye className="h-4 w-4 text-violet-500" />
                  Privacy Mode
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Toggle <strong>Privacy Mode</strong> to mask account emails and sensitive data in the UI — perfect for streaming or screenshots.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-500" />
                  Addon Protection
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Mark addons as <strong>protected</strong> to prevent accidental deletion during bulk operations. Protected addons display a shield badge.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Section: Security */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-red-500" />
            Security & Safety
          </h2>
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Local Encryption</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  All your AuthKeys and passwords are encrypted using <strong>AES-256-GCM</strong> directly in your browser. This application has no servers and stores no data externally.
                </p>
              </CardContent>
            </Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Reinstall Safety</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    The app ensures a successful configuration fetch before removing an old addon during reinstallation, preventing "blind uninstalls" that leave you empty-handed.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Unsafe Mode</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    A safety latch in Settings that prevents accidental destructive actions. You must explicitly toggle it on to perform full data wipes.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Section: Tips & Tricks */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-yellow-500" />
            Tips & Tricks
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Power User Shortcuts</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
                  <li><strong>Middle-click</strong> an addon's "Configure" button to open it in a new tab.</li>
                  <li>Use the <strong>Global Search</strong> (<kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">Ctrl+K</kbd>) to quickly filter accounts and addons.</li>
                  <li><strong>Selection Mode</strong> in the library allows you to move dozens of addons between profiles in seconds.</li>
                  <li>Press <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">Esc</kbd> to exit selection mode, <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">S</kbd> to save selected, <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">Ctrl+A</kbd> to select all.</li>
                  <li>Configure <strong>Discord/Ntfy webhooks</strong> in Autopilot to receive failover alerts on your phone.</li>
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Data Portability</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Moving devices? Use the <strong>Export Data</strong> function in Settings. It generates a single file containing all your profiles, accounts, and library snapshots.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Section: Troubleshooting */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Troubleshooting
          </h2>
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">"My Activity Feed is empty"</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Stremio's API can sometimes be slow to update watch history. If you've just watched something, wait 30 seconds and click the <strong>Refresh</strong> button.
                </p>
                <p>
                  <em>Note: Only items that appear in your official Stremio "Continue Watching" or "Library" (with watch progress) are synced.</em>
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">"Addon configuration failed"</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>
                  If you get a 401 or "Unauthorized" error, your <strong>AuthKey</strong> may have expired or been revoked. Try logging out and back into the official Stremio web app to generate a fresh key.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="credits" className="space-y-4 scroll-mt-48">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Credits & Acknowledgements
          </h2>
          <Card>
            <CardHeader>
              <CardTitle>Standing on the shoulders of giants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-muted-foreground">
                <p className="text-sm">
                  AIOManager is a fork and major evolution of the original <strong>Stremio Account Manager</strong> by <strong>Asymons</strong>. Full credit to the projects that made this possible:
                </p>
                <ul className="grid gap-3 sm:grid-cols-2">
                  <li className="p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                    <a href="https://github.com/pancake3000/stremio-addon-manager" target="_blank" rel="noopener noreferrer" className="flex flex-col gap-1">
                      <span className="font-medium text-foreground flex items-center gap-2">
                        <Github className="h-4 w-4" /> pancake3000
                      </span>
                      <span className="text-xs">The original creator of the addon manager.</span>
                    </a>
                  </li>
                  <li className="p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                    <a href="https://github.com/Asymons/stremio-account-manager" target="_blank" rel="noopener noreferrer" className="flex flex-col gap-1">
                      <span className="font-medium text-foreground flex items-center gap-2">
                        <Github className="h-4 w-4" /> Asymons
                      </span>
                      <span className="text-xs">Original Stremio Account Manager fork.</span>
                    </a>
                  </li>
                  <li className="p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                    <a href="https://stremio.com" target="_blank" rel="noopener noreferrer" className="flex flex-col gap-1">
                      <span className="font-medium text-foreground flex items-center gap-2">
                        <ExternalLink className="h-4 w-4" /> Stremio
                      </span>
                      <span className="text-xs">The best media center platform.</span>
                    </a>
                  </li>
                  <li className="p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                    <a href="https://github.com/iamneur0/syncio" target="_blank" rel="noopener noreferrer" className="flex flex-col gap-1">
                      <span className="font-medium text-foreground flex items-center gap-2">
                        <Activity className="h-4 w-4" /> Syncio
                      </span>
                      <span className="text-xs">Watch History logic inspiration.</span>
                    </a>
                  </li>
                </ul>

                <div className="pt-2 border-t mt-2">
                  <p className="text-xs text-balance">
                    Special thanks to the community inspirations who made this journey possible:
                    {' '}
                    <a href="https://github.com/redd-ravenn/stremio-addon-manager" className="hover:text-primary underline">redd-raven</a>,
                    {' '}
                    <a href="https://github.com/Viren070/stremio-addon-manager" className="hover:text-primary underline">Viren070</a>,
                    {' '}
                    <a href="https://github.com/0xConstant1/stremio-addon-manager" className="hover:text-primary underline">0xConstant1</a>,
                    {' '}
                    <a href="https://github.com/sleeyax" className="hover:text-primary underline">Sleeyax</a>
                    {' & '}
                    <span className="text-muted-foreground/80">&lt;Code/&gt;</span>.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

      </div>
    </div>
  )
}
