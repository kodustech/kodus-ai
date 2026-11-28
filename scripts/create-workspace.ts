/**
 * Adds workspaces (teams) to a user's organization, for customers who need
 * more than one Git organization or provider before #2106 makes it
 * self-serve.
 *
 * Writes the rows CreateTeamUseCase writes at signup: the team, the user as
 * team_leader, `platform_configs` (finishOnboard: false) and the default
 * `code_review_config`. One difference: the team starts `active`, not
 * `pending`, because the sidebar's workspace menu disables non-active teams
 * and the user has to pick it to reach setup.
 *
 * The user then picks the workspace in the sidebar, the app sends them
 * through setup, and they connect the Git organization there. Finishing
 * onboarding provisions the workspace's own trial license in billing, so this
 * script writes nothing to the `billing` schema.
 *
 * Dry run by default; --apply writes everything in one transaction.
 *
 *   op run --env-file=.env.prod -- env TS_NODE_PROJECT=tsconfig.json \
 *     npx ts-node --transpile-only -r tsconfig-paths/register \
 *     scripts/create-workspace.ts <email> "<workspace name>" ["<name>" ...] [--apply]
 */
import { Client } from 'pg';

import { buildNewTeamGlobalCodeReviewConfig } from '../libs/common/utils/validateCodeReviewConfigFile';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', 'db_postgres']);

// Same value CreateTeamUseCase.savePlatormConfigsParameters persists.
const INITIAL_PLATFORM_CONFIGS = {
    finishOnboard: false,
    finishProjectManagementConnection: false,
    kodyLearningStatus: 'enabled',
};

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const [email, ...names] = args.filter((a) => a !== '--apply');

    if (!email || !names.length) {
        console.error(
            'usage: create-workspace.ts <email> "<workspace name>" ["<name>" ...] [--apply]',
        );
        return 2;
    }

    if (new Set(names).size !== names.length) {
        console.error('workspace names must be distinct');
        return 2;
    }

    const host = process.env.API_PG_DB_HOST!;
    const client = new Client({
        host,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
        ssl: LOCAL.has(host) ? false : { rejectUnauthorized: false },
    });
    await client.connect();

    try {
        const users = await client.query(
            `SELECT u.uuid, u.status, u.role, o.uuid AS org_uuid, o.name AS org_name
               FROM users u JOIN organizations o ON o.uuid = u.organization_id
              WHERE lower(u.email) = lower($1)`,
            [email],
        );
        if (users.rowCount !== 1) {
            console.error(
                `expected 1 user for ${email}, found ${users.rowCount}`,
            );
            return 1;
        }
        const user = users.rows[0];
        console.log('user', JSON.stringify(user));

        const teams = await client.query(
            `SELECT t.uuid, t.name, t.status,
                    EXISTS (SELECT 1 FROM team_member tm
                             WHERE tm.team_id = t.uuid AND tm.user_id = $2) AS is_member
               FROM teams t
              WHERE t.organization_id = $1
              ORDER BY t."createdAt"`,
            [user.org_uuid, user.uuid],
        );
        for (const t of teams.rows) console.log('team', JSON.stringify(t));

        // CreateTeamUseCase rejects a name already used by a non-removed team.
        const taken = names.filter((name) =>
            teams.rows.some((t) => t.status !== 'removed' && t.name === name),
        );
        if (taken.length) {
            console.error(`name already used in this org: ${taken.join(', ')}`);
            return 1;
        }

        // Signup stores the user's display name on the member row.
        const member = await client.query(
            `SELECT name FROM team_member
              WHERE user_id = $1 AND organization_id = $2
              ORDER BY "createdAt" LIMIT 1`,
            [user.uuid, user.org_uuid],
        );
        if (!member.rowCount) {
            console.error('user has no team_member row to take the name from');
            return 1;
        }
        const memberName: string = member.rows[0].name;

        console.log(
            `${apply ? 'creating' : 'would create'} in "${user.org_name}" as team_leader "${memberName}": ${names.join(', ')}`,
        );
        if (!apply) {
            console.log('dry run, nothing written (pass --apply)');
            return 0;
        }

        await client.query('BEGIN');
        try {
            for (const name of names) {
                const team = await client.query(
                    `INSERT INTO teams (name, organization_id, status)
                     VALUES ($1, $2, 'active') RETURNING uuid, name, status`,
                    [name, user.org_uuid],
                );
                const teamId = team.rows[0].uuid;

                await client.query(
                    `INSERT INTO team_member (name, status, user_id, organization_id, team_id, "teamRole")
                     VALUES ($1, true, $2, $3, $4, 'team_leader')`,
                    [memberName, user.uuid, user.org_uuid, teamId],
                );

                await client.query(
                    `INSERT INTO parameters ("configKey", "configValue", team_id)
                     VALUES ('platform_configs', $1, $3), ('code_review_config', $2, $3)`,
                    [
                        JSON.stringify(INITIAL_PLATFORM_CONFIGS),
                        JSON.stringify(buildNewTeamGlobalCodeReviewConfig()),
                        teamId,
                    ],
                );

                console.log('created', JSON.stringify(team.rows[0]));
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        return 0;
    } finally {
        await client.end();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
    });
