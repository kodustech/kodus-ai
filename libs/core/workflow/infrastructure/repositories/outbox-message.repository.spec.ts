import { OutboxMessageRepository } from './outbox-message.repository';
import { OutboxMessageModel } from './schemas/outbox-message.model';
import type { OutboxMessage } from '../../domain/interfaces/outbox-message.interface';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ debug: jest.fn(), error: jest.fn() }) }));
// The unit boundary is the transaction manager, not TypeORM's connection bootstrap.
jest.mock('@nestjs/typeorm', () => ({ InjectRepository: () => () => undefined }));
jest.mock('typeorm', () => ({ LessThan: (value: unknown) => value }));
jest.mock('./schemas/outbox-message.model', () => ({ OutboxMessageModel: class {}, OutboxStatus: { READY: 'READY' } }));

const message = (n: number): OutboxMessage => ({ exchange: 'fixture', routingKey: 'fixture.run', payload: { n } });

/** A transactional database boundary: nothing becomes visible until its callback commits. */
function fixture(failSave = -1, failUpdate = -1) {
    const visible: any[] = [];
    let writes = 0;
    let updates = 0;
    const local = {
        create: jest.fn((row: unknown) => ({ ...(row as object) })),
        save: jest.fn(async (row: any) => {
            if (++writes === failSave) throw new Error('fixture-save-refused');
            const saved = { ...row, uuid: `row-${writes}` };
            pending.push(saved);
            return saved;
        }),
        update: jest.fn(async () => {
            if (++updates === failUpdate) throw new Error('fixture-update-refused');
            return { affected: 1 };
        }),
    };
    const pending: any[] = [];
    const manager = { getRepository: jest.fn(() => local) };
    const transaction = jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => {
        const value = await fn(manager);
        visible.push(...pending);
        return value;
    });
    const global = { manager: { transaction }, save: jest.fn(), create: jest.fn(), update: jest.fn() };
    return { repo: new OutboxMessageRepository(global as any), local, global, manager, transaction, visible };
}

describe('OutboxMessageRepository atomic batch', () => {
    it('persists every row and envelope update using one shared transaction manager', async () => {
        const f = fixture();
        const out = await (f.repo as any).createBatch([message(1), message(2), message(3)]);
        expect(f.transaction).toHaveBeenCalledTimes(1);
        expect(f.manager.getRepository).toHaveBeenCalledWith(OutboxMessageModel);
        expect(f.visible).toHaveLength(3);
        expect(out.map((r: any) => r.payload.messageId)).toEqual(['row-1', 'row-2', 'row-3']);
        expect(f.local.update).toHaveBeenCalledTimes(3);
        expect(f.global.save).not.toHaveBeenCalled();
    });

    it.each([{ failSave: 2, failUpdate: -1 }, { failSave: -1, failUpdate: 2 }])('rolls back the whole batch if a save or envelope update fails: %j', async ({ failSave, failUpdate }) => {
        const f = fixture(failSave, failUpdate);
        await expect((f.repo as any).createBatch([message(1), message(2), message(3)])).rejects.toThrow('fixture-');
        expect(f.transaction).toHaveBeenCalledTimes(1);
        expect(f.visible).toEqual([]);
        expect(f.global.save).not.toHaveBeenCalled();
    });
});
