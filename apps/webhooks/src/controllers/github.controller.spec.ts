import { GithubController } from './github.controller';

function response() {
    const res = {
        status: jest.fn(),
        send: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.send.mockReturnValue(res);
    return res;
}

describe('GithubController durable acknowledgement', () => {
    it('does not acknowledge before the workflow transaction commits', async () => {
        let commit!: (jobId: string) => void;
        const enqueue = {
            execute: jest.fn(
                () =>
                    new Promise<string>((resolve) => {
                        commit = resolve;
                    }),
            ),
        };
        const signatures = { validate: jest.fn(() => ({ valid: true })) };
        const controller = new GithubController(
            enqueue as any,
            signatures as any,
        );
        const res = response();
        const pending = controller.handleWebhook(
            {
                headers: {
                    'x-github-event': 'pull_request',
                    'x-github-delivery': 'delivery-1',
                },
                body: { action: 'opened' },
            } as any,
            res as any,
        );

        await Promise.resolve();
        expect(res.status).not.toHaveBeenCalled();

        commit('job-1');
        await pending;
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 503 when durable persistence fails', async () => {
        const controller = new GithubController(
            {
                execute: jest.fn().mockRejectedValue(new Error('db down')),
            } as any,
            { validate: jest.fn(() => ({ valid: true })) } as any,
        );
        const res = response();

        await controller.handleWebhook(
            {
                headers: { 'x-github-event': 'push' },
                body: {},
            } as any,
            res as any,
        );

        expect(res.status).toHaveBeenCalledWith(503);
    });
});
