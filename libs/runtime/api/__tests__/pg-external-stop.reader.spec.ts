import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';

const client = { query: jest.fn(), release: jest.fn() };
const pool = Object.assign(new EventEmitter(), {
    connect: jest.fn(async () => client),
    end: jest.fn(),
});
jest.mock('pg', () => ({ Pool: jest.fn(() => pool) }));
import { PgExternalStopReader } from '../infrastructure/pg-external-stop.reader';

describe('read-only external finding stop gate', () => {
    beforeEach(() => {
        client.query.mockReset().mockResolvedValue({ rows: [] });
        client.release.mockClear();
        pool.connect.mockClear();
        pool.removeAllListeners();
    });
    it('fails closed without a dedicated read URL and opens no connection', async () => {
        await expect(
            new PgExternalStopReader(undefined).isStopped('org-a'),
        ).rejects.toThrow('unavailable');
        expect(pool.connect).not.toHaveBeenCalled();
    });
    it('uses a bounded read-only transaction with org/global scope', async () => {
        client.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ one: 1 }] })
            .mockResolvedValueOnce({ rows: [] });
        expect(
            await new PgExternalStopReader(
                'postgres://fixture.invalid',
            ).isStopped('org-a'),
        ).toBe(true);
        expect(client.query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
        expect(client.query.mock.calls[2][0]).toContain(
            "scope='global' OR organization_id=$1",
        );
        expect(client.query.mock.calls[2][1]).toEqual(['org-a']);
        expect(client.query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(client.release).toHaveBeenCalledTimes(1);
    });
    it('contains idle pool errors without exposing connection details and remains usable', async () => {
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        try {
            const reader = new PgExternalStopReader(
                'postgres://fixture.invalid',
            );
            await reader.isStopped('org-a');
            expect(() =>
                pool.emit(
                    'error',
                    new Error('credential-bearing connection detail'),
                ),
            ).not.toThrow();
            expect(warn).toHaveBeenCalledWith({
                event: 'runtime.a2a.stop_reader_unavailable',
                reason: 'idle_connection_error',
            });
            expect(await reader.isStopped('org-a')).toBe(false);
            expect(pool.connect).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });
    it('rolls back and releases without treating unavailable state as running', async () => {
        client.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(new Error('fixture unavailable'))
            .mockResolvedValueOnce({ rows: [] });
        await expect(
            new PgExternalStopReader('postgres://fixture.invalid').isStopped(
                'org-a',
            ),
        ).rejects.toThrow('fixture unavailable');
        expect(client.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
