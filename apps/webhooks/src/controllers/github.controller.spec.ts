import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { GithubController } from './github.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('GithubController push filtering', () => {
    const queueRef =
        'refs/heads/gh-readonly-queue/main/pr-1-b849a34be3d6e2b91399a6ddca1a4d3ea153839d';

    let enqueue: jest.Mock;
    let controller: GithubController;

    const makeRes = () => {
        const res: any = {};
        res.status = jest.fn().mockReturnValue(res);
        res.send = jest.fn().mockReturnValue(res);
        return res;
    };

    const send = async (payload: Record<string, unknown>) => {
        const res = makeRes();
        controller.handleWebhook(
            { headers: { 'x-github-event': 'push' }, body: payload } as any,
            res,
        );
        await new Promise((resolve) => setImmediate(resolve));
        return res;
    };

    beforeEach(() => {
        enqueue = jest.fn().mockResolvedValue(undefined);
        controller = new GithubController({ execute: enqueue } as any);
    });

    it('enqueues a push that creates a merge queue branch', async () => {
        const payload = { ref: queueRef, created: true, deleted: false };

        const res = await send(payload);

        expect(res.send).toHaveBeenCalledWith('Webhook received');
        expect(enqueue).toHaveBeenCalledWith({
            platformType: PlatformType.GITHUB,
            event: 'push',
            payload,
        });
    });

    it.each([
        ['an ordinary branch push', { ref: 'refs/heads/main' }],
        ['a merge queue branch deletion', { ref: queueRef, deleted: true }],
    ])('does not enqueue %s', async (_label, payload) => {
        const res = await send(payload);

        expect(res.send).toHaveBeenCalledWith(
            'Webhook ignored (event not supported)',
        );
        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe('GithubController repository events', () => {
    let enqueue: jest.Mock;
    let controller: GithubController;

    const send = async (event: string, payload: Record<string, unknown>) => {
        const res: any = {};
        res.status = jest.fn().mockReturnValue(res);
        res.send = jest.fn().mockReturnValue(res);
        controller.handleWebhook(
            { headers: { 'x-github-event': event }, body: payload } as any,
            res,
        );
        await new Promise((resolve) => setImmediate(resolve));
        return res;
    };

    beforeEach(() => {
        enqueue = jest.fn().mockResolvedValue(undefined);
        controller = new GithubController({ execute: enqueue } as any);
    });

    it.each([
        ['installation_repositories', 'added'],
        ['repository', 'created'],
    ])(
        'enqueues %s/%s, so a new repository is picked up right away',
        async (event, action) => {
            const payload = { action, installation: { id: 42 } };

            await send(event, payload);

            expect(enqueue).toHaveBeenCalledWith({
                platformType: PlatformType.GITHUB,
                event,
                payload,
            });
        },
    );

    it.each([
        ['installation_repositories', 'removed'],
        ['repository', 'archived'],
        ['repository', 'edited'],
    ])('ignores %s/%s', async (event, action) => {
        await send(event, { action, installation: { id: 42 } });

        expect(enqueue).not.toHaveBeenCalled();
    });
});
