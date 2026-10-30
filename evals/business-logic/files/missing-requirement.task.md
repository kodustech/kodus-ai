# Task: Soft-delete must revoke active sessions

When a user account is soft-deleted, the system must also revoke all of that
user's active sessions, so a deactivated user cannot keep using the app with an
existing session token.

## Acceptance criteria
- Soft-deleting a user sets `deleted_at`.
- Soft-deleting a user ALSO revokes every active session for that user.
- A request authenticated with a session belonging to a soft-deleted user is rejected.
