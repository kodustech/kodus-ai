/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { PARAMETERS_PATHS } from '@services/parameters';
import { createOrUpdateCodeReviewParameter } from '@services/parameters/fetch';
import { generateQueryKey } from 'src/core/utils/reactQuery';
import { useCodeReviewSettingsMutation } from '../../../apps/web/src/app/(app)/settings/code-review/_hooks/use-code-review-settings-mutation';

jest.mock('@services/parameters/fetch', () => ({
    createOrUpdateCodeReviewParameter: jest.fn(),
}));
jest.mock('src/core/providers/auth.provider', () => ({ useAuth: jest.fn() }));

const save = jest.mocked(createOrUpdateCodeReviewParameter);
const scopesKey = (teamId: string) =>
    generateQueryKey(PARAMETERS_PATHS.CODE_REVIEW_SCOPES, {
        params: { teamId },
    });

function harness() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(scopesKey('team-1'), [
        { id: 'repo-1', isSelected: false },
    ]);
    client.setQueryData(scopesKey('team-2'), [
        { id: 'repo-2', isSelected: false },
    ]);
    const hook = renderHook(
        () => {
            const form = useForm({
                defaultValues: {
                    language: 'en-US',
                    automatedReviewActive: { value: true, level: 'global' },
                    byokModelId: { value: '', level: 'default' },
                },
            });
            const mutation = useCodeReviewSettingsMutation({
                teamId: 'team-1',
                repositoryId: 'repo-1',
                form: form as any,
            });
            return { form, ...mutation };
        },
        {
            wrapper: ({ children }) => (
                <QueryClientProvider client={client}>
                    {children}
                </QueryClientProvider>
            ),
        },
    );
    return { client, ...hook };
}

beforeEach(() => {
    save.mockReset().mockResolvedValue(true as any);
});

it('saves inherited repository settings in that repository and refreshes only its team scopes', async () => {
    const { client, result } = harness();
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
        await result.current.saveSettings({
            ...result.current.form.getValues(),
            automatedReviewActive: { value: false, level: 'repository' },
        } as any);
    });
    expect(save).toHaveBeenCalledWith(
        { automatedReviewActive: false },
        'team-1',
        'repo-1',
        undefined,
    );
    expect(client.getQueryState(scopesKey('team-1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(scopesKey('team-2'))?.isInvalidated).toBe(
        false,
    );
    expect(result.current.form.getValues('automatedReviewActive.value')).toBe(
        false,
    );
});

it('does not mark a failed save as saved or refresh its scope status', async () => {
    save.mockResolvedValueOnce({ error: '503' } as any);
    const { client, result } = harness();
    await act(async () => {
        await expect(
            result.current.saveSettings({
                ...result.current.form.getValues(),
                automatedReviewActive: { value: false, level: 'repository' },
            } as any),
        ).rejects.toThrow('Failed to save settings');
    });
    expect(result.current.form.getValues('automatedReviewActive.value')).toBe(
        true,
    );
    expect(client.getQueryState(scopesKey('team-1'))?.isInvalidated).toBe(
        false,
    );
});

it('returns centralized PR metadata while refreshing the persisted scope status', async () => {
    const centralizedPr = {
        mode: 'centralized-pr',
        prUrl: 'https://example.com/pull/1',
    };
    save.mockResolvedValueOnce(centralizedPr as any);
    const { client, result } = harness();
    await act(async () => {
        await expect(
            result.current.saveSettings(result.current.form.getValues() as any),
        ).resolves.toEqual({ centralizedPr });
    });
    expect(client.getQueryState(scopesKey('team-1'))?.isInvalidated).toBe(true);
});
