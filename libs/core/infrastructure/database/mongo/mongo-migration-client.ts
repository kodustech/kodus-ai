/**
 * Shared Mongo connection for TypeORM migrations and their standalone CLIs.
 *
 * Why it lives here (and stays dependency-free — only the `mongodb` driver, no
 * `@libs`/Nest imports): the migration build (`tsconfig.migrations.json`)
 * compiles this tree in isolation, and the prod migration step
 * (`migration:run:prod`) loads it from `dist/` with no Nest context. Pulling the
 * app's DI graph in here would bloat/break that build.
 *
 * The migration ledger is Postgres (the TypeORM `migrations` table). A Mongo
 * migration is a normal TypeORM migration whose `up()` opens a connection via
 * this helper, does the work, and closes — so Mongo schema/data changes ride
 * the SAME "runs once on boot, pod-locked" mechanism as the SQL migrations.
 */
import { ConnectionString } from 'connection-string';
import { Db, MongoClient } from 'mongodb';

/**
 * Builds the Mongo URI from the same env the API uses (mongodb.config.loader).
 * Prefers a full URI; otherwise assembles host/port/creds with the SAME
 * `connection-string` builder + protocol rule as the runtime app
 * (`MongooseFactory.createMongooseOptions`): a numeric `API_MG_DB_PORT`
 * → `mongodb://host:port`; anything else (empty, `''`, non-numeric — e.g.
 * Atlas via SSM) → `mongodb+srv://host` (SRV supplies the port).
 *
 * Keeping this in lock-step with the app matters because self-hosted customers
 * only test what boots the API. If a client's env boots the app it must also
 * boot migrations — we shouldn't have two independent URI dialects to keep in
 * sync.
 */
export function buildMongoUri(): string {
    const uri = process.env.MONGODB_URI ?? process.env.API_MG_DB_URI;
    if (uri) return uri;

    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = parseInt(process.env.API_MG_DB_PORT ?? '', 10);
    const hasPort = Number.isFinite(port);

    return new ConnectionString('', {
        user: process.env.API_MG_DB_USERNAME,
        password: process.env.API_MG_DB_PASSWORD,
        protocol: hasPort ? 'mongodb' : 'mongodb+srv',
        hosts: [{ name: host, port: hasPort ? port : undefined }],
    }).toString();
}

export function mongoDatabaseName(): string {
    return process.env.API_MG_DB_DATABASE ?? 'kodus';
}

/**
 * True when a Mongo migration should no-op. Set `SKIP_MONGO_MIGRATIONS=true` in
 * contexts that run `migration:run` (the TypeORM/Postgres runner) but CANNOT
 * reach Mongo — notably CI, where the step runs on the host runner and the Mongo
 * service is only resolvable inside the docker network (`getaddrinfo EAI_AGAIN`).
 * Prod / self-hosted boot leaves it unset: there `migration:run` executes inside
 * the API container, which reaches Mongo, so the migration runs for real.
 */
export function mongoMigrationsSkipped(): boolean {
    return process.env.SKIP_MONGO_MIGRATIONS === 'true';
}

export type MongoMigrationHandle = {
    client: MongoClient;
    db: Db;
    close: () => Promise<void>;
};

/**
 * Opens a Mongo connection scoped to the API's database. Always `await close()`
 * in a `finally` so a migration never leaks a socket into the boot sequence.
 */
export async function mongoMigrationClient(): Promise<MongoMigrationHandle> {
    const client = new MongoClient(buildMongoUri());
    await client.connect();
    const db = client.db(mongoDatabaseName());
    return { client, db, close: () => client.close() };
}
