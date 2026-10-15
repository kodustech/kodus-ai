#!/usr/bin/env npx ts-node
/**
 * Restores the Kody Rules that the FreezeAgentFileRulesMongo migration
 * removed from one organization: rules its onboarding import had made from
 * repository files outside .kody/rules (CLAUDE.md, .cursor/rules, Claude
 * skills, ...).
 * Each goes back to the status it had before (active, pending or paused).
 *
 * Restored rules are org-wide again, one per repository copy, as before the
 * migration. Prefer turning on "Use coding-agent instructions in reviews",
 * which reads the same files per repository.
 *
 * Usage:
 *   TS_NODE_PROJECT=tsconfig.json npx ts-node -r tsconfig-paths/register \
 *     scripts/restore-onboarding-agent-file-rules.ts --org-id=<uuid>
 */
import { mongoMigrationClient } from '../libs/core/infrastructure/database/mongo/mongo-migration-client';
import { restoreAgentFileRules } from '../libs/core/infrastructure/database/mongo/kody-rules/freeze-agent-file-rules';

async function main(): Promise<number> {
    const orgArg = process.argv.find((a) => a.startsWith('--org-id='));
    const organizationId = orgArg?.slice('--org-id='.length).trim();
    if (!organizationId) {
        console.error(
            'usage: restore-onboarding-agent-file-rules.ts --org-id=<uuid>',
        );
        return 2;
    }

    const { db, close } = await mongoMigrationClient();
    try {
        const { restored } = await restoreAgentFileRules(db, {
            organizationId,
            log: (m) => console.log(m),
        });
        if (restored === 0) {
            console.log('Nothing to restore for this organization.');
        }
        return 0;
    } finally {
        await close();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
    });
