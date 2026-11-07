// Opt-in fixture for this PR's throwaway Runo preview, using its seeded Teams trial.
require('dotenv/config');
const { execFileSync } = require('node:child_process');

async function main() {
    if (process.env.PREVIEW_RISK_ROUTING_QA !== 'true')
        throw new Error('Run only through the opt-in risk-routing preview smoke.');
    const email = process.env.PREVIEW_SEED_EMAIL || 'preview@kodus.io';
    const password = process.env.PREVIEW_SEED_PASSWORD;
    if (!password) throw new Error('Preview login is missing.');
    const response = await fetch('http://127.0.0.1:3001/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Preview login returned HTTP ${response.status}.`);
    const body = await response.json();
    const token = body.data?.accessToken;
    if (!token) throw new Error('Preview login returned no token.');
    const { organizationId } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId))
        throw new Error('Preview organization identity is invalid.');
    execFileSync('docker', ['exec', '-i', 'db_postgres', 'sh', '-c',
        'PGPASSWORD=$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], {
        input: `UPDATE organizations SET release_track = 'beta' WHERE uuid = '${organizationId}';`,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('Risk-routing QA tenant is ready (beta, existing Teams trial).');
}

main().catch((error) => { console.error(error.message); process.exit(1); });
