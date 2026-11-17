/**
 * A failed SQL statement must never put its bound values in a log line.
 *
 * A QueryFailedError carries `parameters` (every value bound to the statement)
 * and the Postgres `detail` ("Key ("refreshToken")=(<value>) already exists.",
 * "Failing row contains (...)"), on the error and again on `driverError`.
 * Production logged a live refresh token through each of them (2026-11-16/17).
 *
 * A failing assertion here is a REAL leak, NOT a test to relax.
 */
import { QueryFailedError } from 'typeorm';

const { boundErrorForLog, deepSanitize } = jest.requireActual(
    '@libs/core/log/logger',
) as {
    boundErrorForLog: (err: unknown) => Record<string, unknown>;
    deepSanitize: (obj: unknown) => unknown;
};

const SECRET = 'not-a-real-refresh-token-0123456789abcdef';

const serialized = (err: unknown) =>
    JSON.stringify(deepSanitize(boundErrorForLog(err)));

const queryFailed = (detail: string) =>
    new QueryFailedError(
        'INSERT INTO "auth"("uuid", "refreshToken") VALUES ($1, $2)',
        ['row-uuid', SECRET],
        Object.assign(
            new Error(
                'duplicate key value violates unique constraint "UQ_auth_refresh"',
            ),
            {
                code: '23505',
                constraint: 'UQ_auth_refresh',
                detail,
            },
        ),
    );

describe('logger err serializer — SQL bound values', () => {
    it('keeps a unique violation diagnosable without the value that collided', () => {
        const line = serialized(
            queryFailed(`Key ("refreshToken")=(${SECRET}) already exists.`),
        );

        expect(line).not.toContain(SECRET);
        expect(line).toContain('UQ_auth_refresh');
        expect(line).toContain('Key (\\"refreshToken\\")');
        expect(line).toContain('already exists');
    });

    it('does not log the row a constraint rejected', () => {
        const line = serialized(
            queryFailed(`Failing row contains (row-uuid, ${SECRET}).`),
        );

        expect(line).not.toContain(SECRET);
    });

    it('keeps how many values were bound, not the values', () => {
        const line = serialized(queryFailed('anything'));

        expect(line).not.toContain(SECRET);
        expect(line).toContain('[2 values]');
    });
});

describe('logger err serializer — MongoDB duplicate key values', () => {
    // The real driver error: the colliding value sits on `keyValue`, inside
    // the message ("dup key: { email: "..." }") and again in `errorResponse`
    // (the whole server reply).
    const { MongoServerError } = jest.requireActual('mongodb');
    const duplicate = (value: string) =>
        new MongoServerError({
            errmsg: `E11000 duplicate key error collection: kodus.users index: email_1 dup key: { email: "${value}" }`,
            code: 11000,
            keyPattern: { email: 1 },
            keyValue: { email: value },
        });

    it('keeps the index and field of a duplicate key, not the value', () => {
        const line = serialized(duplicate(SECRET));

        expect(line).not.toContain(SECRET);
        expect(line).toContain('email_1');
        expect(line).toContain('11000');
    });

    it('does not leak a value that itself contains a closing brace', () => {
        const line = serialized(duplicate(`a}${SECRET}`));

        expect(line).not.toContain(SECRET);
    });

    it('does not leak a value that itself contains a newline', () => {
        const line = serialized(duplicate(`a\n${SECRET}`));

        expect(line).not.toContain(SECRET);
        expect(line).toContain('email_1');
    });

    it('redacts a truncated message whose value holds a brace', () => {
        const line = serialized(
            new Error(`E11000 index: email_1 dup key: { email: "a}${SECRET}"`),
        );

        expect(line).not.toContain(SECRET);
        expect(line).toContain('email_1');
    });

    it('redacts a message that never closes its brace', () => {
        const line = serialized(
            new Error(`E11000 index: email_1 dup key: { email: "${SECRET}`),
        );

        expect(line).not.toContain(SECRET);
        expect(line).toContain('email_1');
    });
});

describe('logger err serializer — Postgres exclusion constraint', () => {
    it('drops both the new and the existing key values', () => {
        const line = serialized(
            queryFailed(
                `Key (room)=(${SECRET}) conflicts with existing key (room)=(${SECRET}-other).`,
            ),
        );

        expect(line).not.toContain(SECRET);
        expect(line).toContain('conflicts with existing key');
    });
});
