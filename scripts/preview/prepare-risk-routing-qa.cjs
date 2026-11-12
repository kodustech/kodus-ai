// Opt-in fixture for this PR's throwaway Runo preview, using its seeded Teams trial.
require('dotenv/config');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');

async function main() {
    if (process.env.PREVIEW_RISK_ROUTING_QA !== 'true')
        throw new Error(
            'Run only through the opt-in risk-routing preview smoke.',
        );
    const email = process.env.PREVIEW_SEED_EMAIL || 'preview@kodus.io';
    const password = process.env.PREVIEW_SEED_PASSWORD;
    if (!password) throw new Error('Preview login is missing.');
    const response = await fetch('http://127.0.0.1:3001/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
        throw new Error(`Preview login returned HTTP ${response.status}.`);
    const body = await response.json();
    const token = body.data?.accessToken;
    if (!token) throw new Error('Preview login returned no token.');
    const { organizationId } = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url'),
    );
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            organizationId,
        )
    )
        throw new Error('Preview organization identity is invalid.');
    const query = (input) =>
        execFileSync(
            'docker',
            [
                'exec',
                '-i',
                'db_postgres',
                'sh',
                '-c',
                'PGPASSWORD=$POSTGRES_PASSWORD psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
            ],
            {
                input,
                stdio: ['pipe', 'pipe', 'pipe'],
                encoding: 'utf8',
            },
        ).trim();
    const mode = process.env.PREVIEW_QA_SETTINGS_MODE;
    if (mode) {
        const key = process.env.PREVIEW_QA_SNAPSHOT_KEY;
        if (
            !/^[0-9]+$/.test(key ?? '') ||
            !/^preview(?:-risk-[0-9]+)?@kodus\.io$/.test(email)
        )
            throw new Error(
                'Settings snapshots require the isolated UI QA account and run id.',
            );
        const file = `/tmp/kodus-risk-ui-${key}-${organizationId}.json`;
        const scope = `SELECT p.uuid FROM parameters p JOIN teams t ON t.uuid=p.team_id WHERE t.organization_id='${organizationId}' AND p."configKey"='code_review_config'`;
        if (mode === 'snapshot') {
            const rows = JSON.parse(
                query(
                    `SELECT COALESCE(json_agg(json_build_object('uuid',p.uuid,'configValue',p."configValue")), '[]'::json) FROM parameters p WHERE p.uuid IN (${scope});`,
                ),
            );
            writeFileSync(file, JSON.stringify(rows), {
                mode: 0o600,
                flag: 'wx',
            });
        } else if (mode === 'restore') {
            const rows = JSON.parse(readFileSync(file, 'utf8'));
            if (
                !Array.isArray(rows) ||
                rows.some((row) => !/^[a-f0-9-]{36}$/i.test(row.uuid))
            )
                throw new Error('Invalid saved QA parameter identity.');
            const keep = rows.length
                ? rows.map((row) => `'${row.uuid}'`).join(',')
                : 'NULL';
            const updates = rows
                .map((row) => {
                    const value = Buffer.from(
                        JSON.stringify(row.configValue),
                    ).toString('base64');
                    return `UPDATE parameters SET "configValue"=convert_from(decode('${value}','base64'),'UTF8')::jsonb WHERE uuid='${row.uuid}' AND uuid IN (${scope});`;
                })
                .join('\n');
            query(
                `BEGIN; DELETE FROM parameters WHERE uuid IN (${scope}) ${rows.length ? `AND uuid NOT IN (${keep})` : ''}; ${updates} COMMIT;`,
            );
            const restored = JSON.parse(
                query(
                    `SELECT COALESCE(json_agg(json_build_object('uuid',p.uuid,'configValue',p."configValue") ORDER BY p.uuid), '[]'::json) FROM parameters p WHERE p.uuid IN (${scope});`,
                ),
            );
            const stable = (value) =>
                JSON.stringify(value, (_key, item) =>
                    item && typeof item === 'object' && !Array.isArray(item)
                        ? Object.fromEntries(
                              Object.entries(item).sort(([a], [b]) =>
                                  a.localeCompare(b),
                              ),
                          )
                        : item,
                );
            if (
                stable(restored) !==
                stable(rows.sort((a, b) => a.uuid.localeCompare(b.uuid)))
            )
                throw new Error(
                    'QA parameter restore did not match its snapshot.',
                );
            unlinkSync(file);
        } else throw new Error('Unknown QA snapshot mode.');
        console.log(
            `QA settings ${mode} completed; no parameter contents exported.`,
        );
        return;
    }
    query(
        `UPDATE organizations SET release_track = 'beta' WHERE uuid = '${organizationId}';`,
    );
    console.log(
        'Risk-routing QA tenant is ready (beta, existing Teams trial).',
    );
}

main().catch((error) => {
    console.error('Could not prepare or restore the isolated risk-routing QA tenant.');
    process.exit(1);
});
