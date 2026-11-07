// Deployment tuning constants shared by addonStore, addonManifest and
// addonDeployment. Kept in a dependency-free module so the deployment
// implementation can stay out of the boot chunk graph.
export const SAVED_ADDON_ACCOUNT_CONCURRENCY = 5
