import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Client } from 'pg';

/**
 * A database of its own for one integration suite, on the server the given
 * URL names (RUNTIME_IT_DATABASE_URL). The Runtime's tables are global: the
 * admission scans and counts, the reaper, retention and DBOS's queues read
 * every organization's rows, so suites run in parallel against one database
 * see each other's rows and DBOS workflows.
 *
 * The database is leased, not created and dropped. DROP DATABASE forces an
 * immediate checkpoint that flushes every dirty buffer on the server; with
 * suites (and whole jest runs) in parallel, the drops queued behind each
 * other's checkpoints and starved every other suite's I/O until hooks and
 * tests timed out. So a suite takes the first free slot of its label
 * (`<base>_<label>_<n>`), creates it once, and on every later lease empties it
 * (every schema dropped with what is in it, and an empty public recreated).
 *
 * The URL is known at once (a suite builds its pools and engine before
 * beforeAll), so the slot is chosen synchronously, through a lease file on
 * this machine; create() then holds a PostgreSQL advisory lock on the slot
 * for the suite's lifetime, so two holders of one slot fail loudly instead of
 * sharing a database. drop() frees the slot; the next lease ends any
 * connection still open to it (what WITH (FORCE) did) before emptying it.
 */
export function isolatedDatabase(serverUrl: string, label: string): { url: string; create(): Promise<void>; drop(): Promise<void> } {
    if (!serverUrl) return { url: '', create: async () => undefined, drop: async () => undefined };
    const u = new URL(serverUrl);
    const base = u.pathname.slice(1) || 'runtime_it';
    const prefix = `${base.slice(0, 24)}_${label.slice(0, 24)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const lease = leaseSlot(`${u.host}/${base}`, prefix);
    const name = lease.name;
    u.pathname = `/${name}`;
    const url = u.toString();
    let admin: Client | undefined;

    const endConnections = (c: Client) =>
        c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);

    return {
        url,
        async create() {
            admin = new Client({ connectionString: serverUrl });
            admin.on('error', () => undefined);
            await admin.connect();
            const { rows } = await admin.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held', [name]);
            if (!rows[0].held) throw new Error(`integration database ${name} is held by another process on this server`);
            if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 0) {
                await admin.query(`CREATE DATABASE "${name}"`);
                // A commit is acknowledged before its WAL reaches the disk: what
                // a commit makes visible, and every lock, constraint and
                // isolation level, is unchanged; only a server crash could lose
                // the last commits, which no suite causes. Waiting for the WAL
                // flush of every commit was what the suites in parallel queued on.
                await admin.query(`ALTER DATABASE "${name}" SET synchronous_commit = off`);
                return;
            }
            // A holder that died may have left connections behind.
            await endConnections(admin);
            const db = new Client({ connectionString: url });
            await db.connect();
            try {
                const { rows: schemas } = await db.query(
                    `SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`,
                );
                for (const { nspname } of schemas) await db.query(`DROP SCHEMA "${nspname}" CASCADE`);
                await db.query('CREATE SCHEMA public');
            } finally {
                await db.end();
            }
        },
        async drop() {
            // Connections a suite leaves open stay until the next lease of the
            // slot ends them: ending them here raises their pool's error in a
            // suite that already finished.
            try {
                await admin?.end();
            } finally {
                admin = undefined;
                lease.release();
            }
        },
    };
}

const LEASES = path.join(os.tmpdir(), 'kodus-runtime-it-databases');

function alive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The first slot of `prefix` no live process on this machine holds; a dead holder's slot is taken over. */
function leaseSlot(server: string, prefix: string): { name: string; release(): void } {
    fs.mkdirSync(LEASES, { recursive: true });
    const key = createHash('sha256').update(server).digest('hex').slice(0, 12);
    const me = String(process.pid);
    for (let slot = 0; ; slot++) {
        const name = `${prefix}_${slot}`;
        const file = path.join(LEASES, `${key}_${name}.pid`);
        if (take(file, me)) {
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                process.removeListener('exit', release);
                try {
                    if (fs.readFileSync(file, 'utf8') === me) fs.unlinkSync(file);
                } catch {
                    // already gone
                }
            };
            process.once('exit', release);
            return { name, release };
        }
    }
}

function take(file: string, me: string): boolean {
    try {
        fs.writeFileSync(file, me, { flag: 'wx' });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Held. Take it over only from a dead holder, one taker at a time.
    const guard = `${file}.takeover`;
    try {
        fs.mkdirSync(guard);
    } catch {
        return false;
    }
    try {
        let holder = '';
        try {
            holder = fs.readFileSync(file, 'utf8');
        } catch {
            // released meanwhile
        }
        if (holder && (holder === me || alive(Number(holder)))) return false;
        fs.writeFileSync(file, me);
        return true;
    } finally {
        fs.rmdirSync(guard);
    }
}
