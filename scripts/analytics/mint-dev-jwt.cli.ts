import 'dotenv/config';

import { Client } from 'pg';
import { sign } from 'jsonwebtoken';

/**
 * Dev-only helper: looks a user up by email in the OLTP Postgres,
 * builds the same JWT payload the real `/auth/login` flow signs
 * (`libs/identity/infrastructure/adapters/services/auth/auth.service.ts:245`),
 * and prints the access token.
 *
 * Use it to hit authed endpoints from a terminal without logging into
 * the UI — parity runs, curl probing, etc.
 *
 * Usage:
 *   pnpm run analytics:mint-dev-jwt --email you@kodus.io
 *   pnpm run analytics:mint-dev-jwt --email you@kodus.io --expires 24h
 *
 * Env (from `.env`):
 *   API_JWT_SECRET       (required — same secret the api container uses)
 *   API_PG_DB_HOST, API_PG_DB_PORT, API_PG_DB_USERNAME,
 *   API_PG_DB_PASSWORD, API_PG_DB_DATABASE
 *
 * Safety: refuses to run if `API_DATABASE_ENV=production` — we never
 * want to accidentally mint a token against prod creds with this.
 */

interface CliArgs {
    email: string;
    expires: string;
    pgHost?: string;
}

function parseArgs(): CliArgs {
    const out: Partial<CliArgs> = { expires: '24h' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--email':
                out.email = next;
                i += 1;
                break;
            case '--expires':
                out.expires = next;
                i += 1;
                break;
            case '--pg-host':
                out.pgHost = next;
                i += 1;
                break;
            default:
                if (arg?.startsWith('--')) {
                    throw new Error(`unknown flag: ${arg}`);
                }
        }
    }
    if (!out.email) throw new Error('--email is required');
    return out as CliArgs;
}

async function main() {
    const args = parseArgs();

    const dbEnv = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
    if (dbEnv === 'production') {
        throw new Error(
            'refusing to mint a JWT when API_DATABASE_ENV=production — ' +
                'this script is dev-only.',
        );
    }

    const secret = process.env.API_JWT_SECRET;
    if (!secret) {
        throw new Error('API_JWT_SECRET not set');
    }

    const client = new Client({
        host: args.pgHost ?? process.env.API_PG_DB_HOST ?? 'localhost',
        port: parseInt(process.env.API_PG_DB_PORT ?? '5432', 10),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
    });

    try {
        await client.connect();
        const { rows } = await client.query(
            `SELECT u.uuid AS sub, u.email, u.role, u.status,
                    u.organization_id AS "organizationId"
               FROM public.users u
              WHERE u.email = $1
              LIMIT 1`,
            [args.email],
        );
        if (!rows.length) {
            throw new Error(`no user found with email "${args.email}"`);
        }
        const user = rows[0] as {
            sub: string;
            email: string;
            role: string;
            status: string;
            organizationId: string;
        };

        // `teamRole` isn't strictly required to pass JwtAuthGuard, but
        // some endpoints read it. Leaving undefined mirrors what happens
        // when a user without a team-membership record signs in.
        const payload = {
            email: user.email,
            role: user.role,
            status: user.status,
            sub: user.sub,
            organizationId: user.organizationId,
            iss: 'kodus-orchestrator',
            aud: 'web',
        };

        // `expiresIn: string` needs a `ms`-compatible literal like '24h';
        // typings in this repo want `StringValue` but accept a string at
        // runtime — cast to sidestep the overload complaint.
        const token = sign(payload, secret, {
            expiresIn: args.expires as unknown as number,
        });
        // Print ONLY the token on stdout so the caller can do:
        //   JWT=$(pnpm -s analytics:mint-dev-jwt --email ...)
        process.stdout.write(token + '\n');
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    process.stderr.write(
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    process.exit(1);
});
