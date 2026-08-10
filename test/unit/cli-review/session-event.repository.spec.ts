import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventModel } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';

/**
 * Guards the wiring, not the sanitiser itself (that is covered in
 * test/unit/common/jsonb-safe.spec.ts). What matters here is that the
 * payload gets cleaned on the way to TypeORM — if the call is dropped
 * from `create`, these INSERTs go back to failing with
 * `unsupported Unicode escape sequence` and the event is lost.
 */
const NUL = String.fromCharCode(0);

describe('SessionEventRepository', () => {
    let repository: SessionEventRepository;
    let typeormRepo: { create: jest.Mock; save: jest.Mock };

    beforeEach(async () => {
        typeormRepo = {
            create: jest.fn((x) => x),
            save: jest.fn(async (x) => x),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SessionEventRepository,
                {
                    provide: getRepositoryToken(SessionEventModel),
                    useValue: typeormRepo,
                },
            ],
        }).compile();

        repository = module.get(SessionEventRepository);
    });

    it('strips jsonb-hostile characters from payload before saving', async () => {
        await repository.create({
            sessionId: 's-1',
            payload: { prompt: `write${NUL} tests`, ok: true },
        } as Partial<SessionEventModel>);

        const persisted = typeormRepo.create.mock.calls[0][0];

        expect(persisted.payload).toEqual({ prompt: 'write tests', ok: true });
        expect(JSON.stringify(persisted)).not.toContain('\\u0000');
    });

    it('leaves the rest of the row untouched', async () => {
        await repository.create({
            sessionId: 's-2',
            branch: 'main',
            payload: { a: 1 },
        } as Partial<SessionEventModel>);

        const persisted = typeormRepo.create.mock.calls[0][0];

        expect(persisted.sessionId).toBe('s-2');
        expect(persisted.branch).toBe('main');
        expect(persisted.payload).toEqual({ a: 1 });
    });

    it('handles a row with no payload at all', async () => {
        await expect(
            repository.create({
                sessionId: 's-3',
            } as Partial<SessionEventModel>),
        ).resolves.toBeDefined();

        expect(typeormRepo.create.mock.calls[0][0].payload).toBeUndefined();
    });
});
