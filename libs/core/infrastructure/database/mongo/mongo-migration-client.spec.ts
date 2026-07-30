import { buildMongoUri, mongoDatabaseName } from './mongo-migration-client';

/**
 * `buildMongoUri` must resolve the SAME Mongo the API uses, from the same env —
 * a wrong URI here silently points a boot migration at the wrong database.
 * These cases mirror `MongooseFactory.createMongooseOptions`: if a client's env
 * boots the app, the exact same env must boot the migrations.
 */
describe('buildMongoUri', () => {
    const KEYS = [
        'MONGODB_URI',
        'API_MG_DB_URI',
        'API_MG_DB_HOST',
        'API_MG_DB_PORT',
        'API_MG_DB_USERNAME',
        'API_MG_DB_PASSWORD',
        'API_MG_DB_DATABASE',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = {};
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('prefers a full MONGODB_URI verbatim', () => {
        process.env.MONGODB_URI = 'mongodb://u:p@h:1/x?replicaSet=rs0';
        expect(buildMongoUri()).toBe('mongodb://u:p@h:1/x?replicaSet=rs0');
    });

    it('falls back to API_MG_DB_URI', () => {
        process.env.API_MG_DB_URI = 'mongodb://a:b@c:2/y';
        expect(buildMongoUri()).toBe('mongodb://a:b@c:2/y');
    });

    it('assembles mongodb://host:port when a numeric port is set', () => {
        process.env.API_MG_DB_HOST = 'db_mongodb';
        process.env.API_MG_DB_PORT = '27017';
        process.env.API_MG_DB_USERNAME = 'kodusdev';
        process.env.API_MG_DB_PASSWORD = 'secret';
        expect(buildMongoUri()).toBe(
            'mongodb://kodusdev:secret@db_mongodb:27017',
        );
    });

    it('url-encodes a password with special characters', () => {
        process.env.API_MG_DB_HOST = 'h';
        process.env.API_MG_DB_PORT = '27017';
        process.env.API_MG_DB_USERNAME = 'u';
        process.env.API_MG_DB_PASSWORD = 'p@ss:w/rd';
        expect(buildMongoUri()).toContain(':p%40ss%3Aw%2Frd@');
    });

    it('omits credentials when user/pass are absent', () => {
        process.env.API_MG_DB_HOST = 'h';
        process.env.API_MG_DB_PORT = '27017';
        expect(buildMongoUri()).toBe('mongodb://h:27017');
    });

    it('uses mongodb+srv (no port) when host is Atlas + port env is unset', () => {
        process.env.API_MG_DB_HOST = 'cluster0.pdqbyxj.mongodb.net';
        process.env.API_MG_DB_USERNAME = 'u';
        process.env.API_MG_DB_PASSWORD = 'p';
        expect(buildMongoUri()).toBe(
            'mongodb+srv://u:p@cluster0.pdqbyxj.mongodb.net',
        );
    });

    it("uses mongodb+srv when port env is a non-numeric string (e.g. \"''\")", () => {
        // Reproduces the QA outage: SSM had API_MG_DB_PORT stored as the literal
        // two-char string "''". parseInt → NaN → SRV, matching the runtime app.
        process.env.API_MG_DB_HOST = 'cluster0.pdqbyxj.mongodb.net';
        process.env.API_MG_DB_PORT = "''";
        expect(buildMongoUri()).toBe(
            'mongodb+srv://cluster0.pdqbyxj.mongodb.net',
        );
    });

    it('uses mongodb+srv when port env is any non-numeric value', () => {
        process.env.API_MG_DB_HOST = 'h';
        process.env.API_MG_DB_PORT = 'notaport';
        expect(buildMongoUri()).toBe('mongodb+srv://h');
    });

    it('mongoDatabaseName defaults to kodus, overridden by env', () => {
        expect(mongoDatabaseName()).toBe('kodus');
        process.env.API_MG_DB_DATABASE = 'kodus_db';
        expect(mongoDatabaseName()).toBe('kodus_db');
    });
});
