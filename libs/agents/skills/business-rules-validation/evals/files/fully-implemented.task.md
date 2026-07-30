# Task: Record last successful sync time

Add a `lastSyncedAt` timestamp to the local store and update it on every
successful sync, so the UI can show when data was last synced.

## Acceptance criteria
- A `lastSyncedAt` field exists on the local store.
- `lastSyncedAt` is updated to the current time on every successful sync.
- The behavior is covered by a test.
