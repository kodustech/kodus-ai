jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

// Production 2026-10-29: an org that uninstalled or suspended the GitHub App
// keeps its integration, so the approval cron asked GitHub for an installation
// token every 2 minutes (and retried, because the error link contains "token"),
// logging ~3.9k fatal errors a day across 6 orgs. GitHub's answer is final for
// a while: remember it instead of asking again on every call.
describe('GithubService — uninstalled or suspended installation', () => {
    const NOT_FOUND = Object.assign(
        new Error(
            'Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app',
        ),
        { status: 404 },
    );
    const SUSPENDED = Object.assign(
        new Error(
            'This installation has been suspended - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app',
        ),
        { status: 403 },
    );

    const makeService = (authError: Error) => {
        const store = new Map<string, unknown>();
        const cacheService = {
            getFromCache: jest.fn(async (key: string) => store.get(key) ?? null),
            addToCache: jest.fn(async (key: string, value: unknown) => {
                store.set(key, value);
            }),
            removeFromCache: jest.fn(async (key: string) => {
                store.delete(key);
            }),
        };
        const service = new GithubService(
            {} as any,
            {} as any,
            {} as any,
            cacheService as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        const auth = jest.fn().mockRejectedValue(authError);
        jest.spyOn(service as any, 'createOctokitInstance').mockReturnValue({
            auth,
        });
        const token = () =>
            (service as any).getInstallationAuthentication('123');
        return { token, auth };
    };

    it.each([
        ['uninstalled (404)', NOT_FOUND],
        ['suspended (403)', SUSPENDED],
    ])(
        'asks GitHub once when the installation is %s, then answers from memory',
        async (_label, error) => {
            const { token, auth } = makeService(error);

            await expect(token()).rejects.toThrow(error.message);
            await expect(token()).rejects.toThrow(error.message);

            expect(auth).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps retrying an error GitHub may not repeat', async () => {
        const { token, auth } = makeService(
            Object.assign(new Error('Bad gateway while creating token'), {
                status: 502,
            }),
        );

        await expect(token()).rejects.toThrow('Bad gateway');
        await expect(token()).rejects.toThrow('Bad gateway');

        expect(auth.mock.calls.length).toBeGreaterThan(2);
    });
});
