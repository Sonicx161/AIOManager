
import { SavedAddon, BulkResult } from '@/types/saved-addon';
import { AddonDescriptor } from '@/types/addon';

// Mock types
type Account = { id: string; authKey: string };

// --- Mocks ---
const mockAddons: AddonDescriptor[] = [
    {
        transportUrl: 'https://cinemeta.strem.io/manifest.json',
        manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta', version: '1.0.0', resources: ['catalog'], types: ['movie'], catalogs: [] },
        flags: { official: true }
    },
    {
        transportUrl: 'https://opensubtitles.strem.io/manifest.json',
        manifest: { id: 'com.linvo.opensubtitles', name: 'OpenSubtitles', version: '1.0.0', resources: ['subtitles'], types: [], catalogs: [] }
    }
];

const mockSavedAddon: SavedAddon = {
    id: 'saved-1',
    name: 'Torrentio',
    installUrl: 'https://torrentio.strem.io/manifest.json',
    manifest: { id: 'com.monster.torrentio', name: 'Torrentio', version: '0.0.14', resources: ['stream'], types: ['movie'], catalogs: [] },
    tags: ['essential'],
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceType: 'manual'
};

// --- Logic from addon-merger.ts (Simplified for test) ---
async function mergeAddons(current: AddonDescriptor[], saved: SavedAddon[]) {
    const updated = [...current];
    const added: any[] = [];
    const skipped: any[] = [];

    for (const s of saved) {
        // Simulate checking existence
        if (updated.some(a => a.transportUrl === s.installUrl)) {
            skipped.push({ addonId: s.manifest.id, reason: 'already-exists' });
        } else {
            // Simulate fetch
            // updated.push({ ...s, transportUrl: s.installUrl, flags: {} } as any);
            console.log(`[Mock] Fetching ${s.installUrl}...`);
            added.push({ addonId: s.manifest.id, name: s.name });
        }
    }
    return { addons: updated, result: { added, updated: [], skipped, protected: [] } };
}

// --- Logic from addonStore.ts (Simplified for test) ---
async function bulkApply(savedAddons: SavedAddon[], accounts: Account[]): Promise<BulkResult> {
    const result: BulkResult = { success: 0, failed: 0, errors: [], details: [] };

    for (const acc of accounts) {
        try {
            console.log(`Processing account ${acc.id}...`);
            // Mock getAddons
            const current = [...mockAddons];

            // Mock Merge
            const { result: mergeResult } = await mergeAddons(current, savedAddons);

            // Mock Update (Simulate failure for one account)
            if (acc.id === 'acc-fail') {
                throw new Error('Network error');
            }

            result.success++;
            result.details.push({ accountId: acc.id, result: mergeResult });

        } catch (err: any) {
            result.failed++;
            result.errors.push({ accountId: acc.id, error: err.message });
        }
    }
    return result;
}

// --- Test Execution ---
(async () => {
    console.log("--- Starting Bulk Logic Verification ---");

    const accounts: Account[] = [
        { id: 'acc-1', authKey: 'auth-1' },
        { id: 'acc-fail', authKey: 'auth-fail' } // Should fail
    ];

    const result = await bulkApply([mockSavedAddon], accounts);

    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));

    if (result.success === 1 && result.failed === 1) {
        console.log("\n✅ Verification Passed: Logic correctly separates success and failure.");
    } else {
        console.error("\n❌ Verification Failed: Unexpected result structure.");
    }
})();
