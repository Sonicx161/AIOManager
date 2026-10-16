# Sync consistency review and local walkthrough

This candidate addresses deleted addons returning during sync, stale Nuvio addon lists entering the current setup, and false cloud conflicts. Nuvio's reported setup replacement refers to its **addon list**. The separate credential-owner fix is additional protection, not an explanation of that entire report.

## Behavior to review

| Trigger | Before | Candidate behavior |
| --- | --- | --- |
| A removed addon remains in a stale Stremio snapshot | Repeated sightings can adopt it on the third refresh | Passive reads cannot authorize reinstalling it |
| A stale source replays a removal after three weeks | The deletion record expires | Deletion remains effective until explicit reinstall |
| Canonical Nuvio data arrives without a remembered merge base | The caller can fold a previously deleted URL back in | Account deletion state filters the input before merging |
| A historical automatic-adoption marker exists | The cloud importer can clear a fresh deletion | Only the account's explicit reinstall acknowledgment can override that deletion |
| User explicitly reinstalls, then deletes again | The old global adoption marker can defeat the new delete | The new deletion advances beyond the observed reinstall |
| One device's clock is behind the server | Its own successful save can cause the next save to conflict | Successful responses establish a server timestamp and revision baseline |
| Another writer changes cloud content quickly | A five-second timestamp tolerance can miss the race | Modern clients compare the cloud revision they applied |
| Two owners share a Nuvio connection ID | URL preservation can select the other owner's metadata | Lookup is scoped to the authenticated owner |
| A stale connection is disabled then re-enabled | Its discovered URLs can clear deletion records | Reconnecting preserves deletions; reinstall remains explicit |
| Credentials are renewed while a platform list is stale | Re-authentication replaces the current list | Re-authentication uses the same additive, deletion-aware merge as passive sync |
| A clone replaces a collection but its platform write fails | Dropped entries can return from the platform | The clone records deletions for dropped URLs |
| A new account is registered on a slow clock | The first real push can conflict with registration | Registration adopts its server timestamp and revision before that push |
| A rejected cloud save carries an old account/key list | The losing save can still replace API-key rows | A conflict preserves the winner's API-key registry |

The server Nuvio reconciler already writes the provided canonical list to the selected profile. New tests retain that protection; this PR does not claim to fix server-side adoption that those tests did not find.

## Walkthrough before beta

Use a disposable workspace and test connections. Keep a copy of their starting addon lists.

1. Install two addons. Remove one in AIOManager, then replay its old list from Stremio or Nuvio. Refresh repeatedly, reload the app, and sync again. The removed addon should stay absent and the kept addon should survive.
2. Repeat with the final addon removed. The intentional empty collection should propagate. A failed or empty initial read must not itself authorize wiping a platform.
3. Explicitly reinstall the removed URL in AIOManager. Sync and reload. It should remain installed. Delete it again and replay the old snapshot; the new deletion should win.
4. Use the same URL in another account. A deletion or old sighting in the first account should not authorize changes in the second.
5. Switch between saved setups, including an intentionally empty default setup, and Nuvio profiles. Confirm each write goes to its selected profile and switching back restores the intended saved list.
6. With two disposable clients, make different edits from the same cloud revision. Save one, then the other. The stale save should refresh before retrying; it must not silently overwrite the first save or discard unsaved addon edits.
7. Repeat cloud saves with a skewed test clock and an unchanged conditional pull. A single device should not repeatedly report another device. Also verify a real later cloud write remains protected.

Automated fixtures use actual production merge functions and server routes with dependency doubles, in-memory SQLite, and synthetic Nuvio responses. They do not reproduce a customer's hosted instance or replace this walkthrough. PostgreSQL concurrency requires separate execution evidence.

## Verification evidence

The five new entry-point checks (re-authentication, clone overwrite, reconnect, platform-only timestamp, registration) fail against the original functions from `6ca450e` and pass against the candidate. Each failure is a behavioral assertion, not a loader failure. Full candidate validation passes 145 client tests and 37 server tests. The server suite includes overlapping HTTP saves from the same revision and checks that exactly one wins; this exercises SQLite serialization, not a live PostgreSQL instance. Production build, lint, typecheck, and API generation pass.

The client cloud tests include real registration execution and pure decisions plus source wiring checks. They do not execute an entire two-device conflict, deferred hydration, and republish cycle. That remains part of the disposable-client walkthrough above.

Switching to a saved setup is treated as an explicit request to install that setup's addons, including previously removed URLs. An empty default setup remains empty. Cloud mirror continues to respect local addon deletion records, so it is not a way to reinstall a deleted URL; explicitly install it in the hub or select a saved setup containing it. Update all clients before testing convergence: older versions do not understand the explicit restore records and can still auto-adopt stale addons.

## Candidate scope

The branch starts from the reviewed performance candidate (`cc8e40d`) and retains its six pending performance refinements in a separate commit. The original checkout's local edits are preserved. Client regression files and the Node test loader are now retained in git and run in CI; they no longer depend on an ignored local harness. No beta merge or deployment is part of the implementation step.
