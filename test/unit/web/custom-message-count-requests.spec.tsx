/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axiosAuthorized } from 'src/core/utils/axios';
import { apiProxyPath } from 'src/core/utils/api-proxy';
import { OverrideCount } from '../../../apps/web/src/app/(app)/settings/_components/override-count';

jest.mock('src/core/utils/axios', () => ({
    axiosAuthorized: { fetcher: jest.fn() },
}));
jest.mock('src/core/providers/auth.provider', () => ({ useAuth: () => ({}) }));
jest.mock('src/app/(app)/settings/_components/context', () => ({
    useDefaultCodeReviewConfig: () => ({}),
}));
jest.mock('src/app/(app)/settings/_hooks', () => ({
    useCodeReviewRouteParams: () => ({ repositoryId: 'global' }),
}));
jest.mock('@services/kodyRules/hooks', () => ({ useKodyRulesCount: () => 0 }));
// Avoid loading server configuration through the service URL helper.
jest.mock('src/core/utils/helpers', () => ({
    pathToApiUrl: (path: string) => apiProxyPath(path),
}));

describe('scope picker custom-message count requests', () => {
    it('shares one request across 100 repository badges and directory badges', async () => {
        const fetcher = jest.mocked(axiosAuthorized.fetcher);
        fetcher.mockResolvedValue({
            data: [
                {
                    repositoryId: 'repo-0',
                    repositoryOverrideCount: 2,
                    directoryOverrideCounts: [
                        { directoryId: 'dir-0', overrideCount: 3 },
                    ],
                },
            ],
        });
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const repositories = Array.from({ length: 100 }, (_, index) => ({
            id: `repo-${index}`,
            configs: {},
            directories: [],
        }));
        repositories[0].directories = [{ id: 'dir-0', configs: {} }] as any;
        const config = { configs: {}, repositories } as any;
        render(
            <QueryClientProvider client={client}>
                {repositories.map((repo) => (
                    <OverrideCount
                        key={repo.id}
                        config={config}
                        scope={{ repositoryId: repo.id }}
                        pages={['output']}
                    />
                ))}
                <OverrideCount
                    config={config}
                    scope={{ repositoryId: 'repo-0', directoryId: 'dir-0' }}
                    pages={['output']}
                />
            </QueryClientProvider>,
        );
        expect(
            await screen.findByTitle('2 settings overridden at this level'),
        ).toBeInTheDocument();
        expect(
            await screen.findByTitle('3 settings overridden at this level'),
        ).toBeInTheDocument();
        expect(
            screen.getAllByTitle(/settings overridden at this level/),
        ).toHaveLength(2);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe(
            apiProxyPath('/pull-request-messages/override-counts'),
        );
        expect(fetcher.mock.calls[0][1]).not.toHaveProperty('params');

        // The existing save invalidation must refresh every badge's shared result.
        fetcher.mockResolvedValue({ data: [] });
        await client.invalidateQueries({
            queryKey: [apiProxyPath('/pull-request-messages/override-counts')],
        });
        await waitFor(() =>
            expect(
                screen.queryByTitle(/settings overridden at this level/),
            ).not.toBeInTheDocument(),
        );
        expect(fetcher).toHaveBeenCalledTimes(2);
        client.clear();
    });
});
