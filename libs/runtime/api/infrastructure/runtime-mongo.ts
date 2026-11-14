import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Db, MongoClient } from 'mongodb';
import type { Connection } from 'mongoose';

/**
 * The Mongo database that holds `runtime_runs`. With RUNTIME_MONGO_URL the API
 * reads the Runtime's own database (ADR-025; give it a read-only user); without
 * it, the product connection (local and self-hosted, where they are the same).
 */
@Injectable()
export class RuntimeMongo implements OnModuleDestroy {
    private client?: MongoClient;
    private dbPromise?: Promise<Db>;

    constructor(@InjectConnection() private readonly connection: Connection) {}

    db = (): Promise<Db> => {
        this.dbPromise ??= this.open().catch((e) => {
            this.dbPromise = undefined;
            throw e;
        });
        return this.dbPromise;
    };

    private async open(): Promise<Db> {
        const url = process.env.RUNTIME_MONGO_URL;
        if (url) {
            // Primary reads: the trigger's "is a Run live on this head?" must not see a stale secondary.
            this.client = new MongoClient(url, { maxPoolSize: 5, readPreference: 'primary' });
            await this.client.connect();
            return this.client.db(process.env.RUNTIME_MONGO_DB || undefined);
        }
        return this.connection.db as unknown as Db;
    }

    async onModuleDestroy() {
        await this.client?.close();
    }
}
