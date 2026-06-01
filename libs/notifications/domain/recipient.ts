import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { NotificationChannel } from './enums/channel.enum';

/**
 * Discriminated union describing who should receive a notification.
 *
 * Every emitter is required to pass at least one recipient — the
 * dispatcher no longer infers recipients by introspecting the payload.
 *
 *  - `user`            — a specific internal user, by uuid.
 *  - `email`           — a bare email; the dispatcher resolves it to a
 *                        user when possible, otherwise the in-app
 *                        channel is skipped and only email-channel
 *                        adapters run.
 *  - `role`            — every active user in the org carrying that role.
 *  - `all_org_members` — every active user in the org.
 *
 * Each entry can optionally restrict the channels it receives via
 * `channels`. When absent, the event's catalog defaults apply. This is
 * used by events like `org.member_removed` where the removed user gets
 * email but the surviving owners get in-app.
 */
export type NotificationRecipient =
    | NotificationRecipientUser
    | NotificationRecipientEmail
    | NotificationRecipientRole
    | NotificationRecipientAllOrgMembers;

export interface NotificationRecipientUser {
    kind: 'user';
    userId: string;
    channels?: NotificationChannel[];
}

export interface NotificationRecipientEmail {
    kind: 'email';
    email: string;
    channels?: NotificationChannel[];
}

export interface NotificationRecipientRole {
    kind: 'role';
    role: Role;
    channels?: NotificationChannel[];
}

export interface NotificationRecipientAllOrgMembers {
    kind: 'all_org_members';
    channels?: NotificationChannel[];
}

export const recipientByUser = (
    userId: string,
    channels?: NotificationChannel[],
): NotificationRecipient => ({ kind: 'user', userId, channels });

export const recipientByEmail = (
    email: string,
    channels?: NotificationChannel[],
): NotificationRecipient => ({ kind: 'email', email, channels });

export const recipientByRole = (
    role: Role,
    channels?: NotificationChannel[],
): NotificationRecipient => ({ kind: 'role', role, channels });

export const recipientAllOrgMembers = (
    channels?: NotificationChannel[],
): NotificationRecipient => ({ kind: 'all_org_members', channels });
