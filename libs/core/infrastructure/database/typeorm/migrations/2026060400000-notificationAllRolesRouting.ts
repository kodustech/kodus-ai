import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification model redesign — make the `*` ("All Roles") routing row a literal
 * all-roles baseline, with the per-event default roles materialized as explicit
 * overrides.
 *
 * Why this is needed
 * ------------------
 * Previously a `*` row applied **only to an event's audience roles** (the code's
 * `audienceRoles`); non-audience roles were off. The redesign reinterprets `*`
 * as "every role." Left untouched, a seeded `*:{email,in_app}` row would suddenly
 * broadcast its event to *all* roles. This migration converts each such `*` row
 * into:
 *
 *   1. one explicit override row per default role (= the current `*` channels), and
 *   2. an emptied `*` baseline (`{}` = off),
 *
 * which reproduces today's "only the default roles receive it."
 *
 * Scope
 * -----
 * Only orgs that have a non-empty `*` row for a mapped event are touched.
 * Orgs with no routing rows keep working via the dispatcher's code fallback
 * (role ∈ defaultRoles ? catalog defaults : off) and need no data change.
 * The criticality channel-lock removal is behavior-neutral (ACTIVE_CHANNELS is
 * {EMAIL, IN_APP}, which equals the critical events' defaults) and needs no DML.
 *
 * Safety
 * ------
 * After the transform the default roles own an explicit row that *wins* under
 * both the old and new dispatcher, so effective delivery is unchanged the day it
 * runs and deploy order relative to the code change is flexible. Pure DML, runs
 * in the normal migration transaction. Idempotent (guarded INSERT + ON CONFLICT,
 * no-op UPDATE on re-run).
 *
 * Event → default roles is a point-in-time snapshot of the catalog
 * (`EVENT_DEFAULTS.defaultRoles`) at the time of writing, including the two
 * mixed events (review.failed, ide.rules_sync_failed) that gain `[owner]` in
 * the same change.
 */
export class NotificationAllRolesRouting2026060400000
    implements MigrationInterface
{
    name = 'NotificationAllRolesRouting2026060400000';

    /** Catalog snapshot — keep in sync with EVENT_DEFAULTS at migration time. */
    private readonly EVENT_DEFAULT_ROLES: ReadonlyArray<{
        event: string;
        roles: string[];
    }> = [
        // Billing — owner + billing manager
        { event: 'billing.payment_failed', roles: ['owner', 'billing_manager'] },
        { event: 'billing.trial_expiring', roles: ['owner', 'billing_manager'] },
        // Owner-only awareness events
        { event: 'byok.llm_errors_threshold', roles: ['owner'] },
        { event: 'spend_limit.threshold_reached', roles: ['owner'] },
        { event: 'spend_limit.exceeded_final', roles: ['owner'] },
        { event: 'org.role_changed', roles: ['owner'] },
        // Mixed events whose owner-awareness half became config-driven. The
        // other mixed candidates (org.member_removed, ide.rules_synced,
        // review.skipped_no_license, rule.file_references_invalid) keep their
        // bespoke/conditional recipients and stay directed-only, so they are
        // intentionally not listed here.
        { event: 'review.failed', roles: ['owner'] },
        { event: 'ide.rules_sync_failed', roles: ['owner'] },
    ];

    /** Channel set the override rows fall back to in `down()` (catalog default). */
    private readonly CATALOG_DEFAULT_CHANNELS = '{"email": true, "in_app": true}';

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const { event, roles } of this.EVENT_DEFAULT_ROLES) {
            // 1. Materialize one override row per default role, copying the
            //    org's current `*` channels. Guarded so we never seed from an
            //    already-emptied baseline (re-run safety); ON CONFLICT keeps
            //    any admin-made per-role row intact.
            for (const role of roles) {
                await queryRunner.query(
                    `
                    INSERT INTO "notification_routing_rules"
                        ("organization_id", "event", "category", "role", "channels")
                    SELECT
                        w."organization_id", w."event", w."category", $2, w."channels"
                    FROM "notification_routing_rules" w
                    WHERE w."event" = $1
                      AND w."role" = '*'
                      AND w."channels" <> '{}'::jsonb
                    ON CONFLICT ON CONSTRAINT "UQ_nrr_org_event_role" DO NOTHING
                    `,
                    [event, role],
                );
            }

            // 2. Empty the `*` baseline so non-default roles no longer inherit
            //    it under the new "all roles" semantics. No-op once already '{}'.
            await queryRunner.query(
                `
                UPDATE "notification_routing_rules"
                SET "channels" = '{}'::jsonb, "updatedAt" = now()
                WHERE "event" = $1 AND "role" = '*'
                `,
                [event],
            );
        }
    }

    /**
     * Best-effort reversal. It restores the `*` baseline to the catalog default
     * channels and removes the default-role overrides that still exactly equal
     * those defaults.
     *
     * Caveat — NOT a perfect inverse: `up()` overwrites the original `*`
     * channels with `{}`, so a `*` row that an admin had customized before the
     * migration is restored to the catalog default, not its prior value. The
     * delete cannot tell a migration-made override from an admin-made one that
     * happens to equal the defaults. Avoid running `down()` after admins have
     * started reconfiguring notifications.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const { event, roles } of this.EVENT_DEFAULT_ROLES) {
            // Restore the `*` baseline (only rows we emptied).
            await queryRunner.query(
                `
                UPDATE "notification_routing_rules"
                SET "channels" = $2::jsonb, "updatedAt" = now()
                WHERE "event" = $1 AND "role" = '*' AND "channels" = '{}'::jsonb
                `,
                [event, this.CATALOG_DEFAULT_CHANNELS],
            );

            // Drop the materialized default-role overrides that still match
            // the catalog defaults.
            await queryRunner.query(
                `
                DELETE FROM "notification_routing_rules"
                WHERE "event" = $1
                  AND "role" = ANY($2::text[])
                  AND "channels" = $3::jsonb
                `,
                [event, roles, this.CATALOG_DEFAULT_CHANNELS],
            );
        }
    }
}
