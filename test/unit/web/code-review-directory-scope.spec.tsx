/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { magicModal } from '@components/ui/magic-modal';
import { toast } from '@components/ui/toaster/use-toast';
import { PARAMETERS_PATHS } from '@services/parameters';
import { createOrUpdateCodeReviewParameter } from '@services/parameters/fetch';
import { generateQueryKey } from 'src/core/utils/reactQuery';
import { DirectoryScopeModal } from '../../../apps/web/src/app/(app)/settings/_components/directory-scope-modal';

jest.mock('@services/parameters/fetch', () => ({
    createOrUpdateCodeReviewParameter: jest.fn(),
}));
jest.mock('src/core/providers/auth.provider', () => ({ useAuth: jest.fn() }));
jest.mock('src/core/providers/selected-team-context', () => ({
    useSelectedTeamId: () => ({ teamId: 'team-1' }),
}));
jest.mock('@components/ui/magic-modal', () => ({
    ...jest.requireActual('@components/ui/magic-modal'),
    magicModal: { hide: jest.fn(), lock: jest.fn(), unlock: jest.fn() },
}));
jest.mock('@components/ui/toaster/use-toast', () => ({ toast: jest.fn() }));
jest.mock(
    '../../../apps/web/src/app/(app)/settings/code-review/_components/git-directory-selector',
    () => ({
        GitDirectorySelector: ({
            onValueChange,
        }: {
            onValueChange: (paths: string[]) => void;
        }) => (
            <div>
                <button onClick={() => onValueChange(['/'])}>
                    Select repository root
                </button>
                <button onClick={() => onValueChange(['/src'])}>
                    Select src
                </button>
            </div>
        ),
    }),
);

const save = jest.mocked(createOrUpdateCodeReviewParameter);
const scopesKey = (teamId: string) =>
    generateQueryKey(PARAMETERS_PATHS.CODE_REVIEW_SCOPES, {
        params: { teamId },
    });

function harness(editGroup?: { id: string; initialPaths: string[] }) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(scopesKey('team-1'), []);
    client.setQueryData(scopesKey('team-2'), []);
    render(
        <QueryClientProvider client={client}>
            <DirectoryScopeModal
                repository={{ id: 'repo-1', name: 'app' }}
                editGroup={editGroup}
            />
        </QueryClientProvider>,
    );
    return client;
}

beforeEach(() => {
    jest.clearAllMocks();
    save.mockResolvedValue(true as any);
});

it('requires directories and cannot create an empty repository configuration', async () => {
    const client = harness();
    const submit = screen.getByRole('button', { name: 'Add directory scope' });
    expect(
        screen.getByText(
            'Choose directories in app that should share review settings.',
        ),
    ).toBeVisible();
    expect(submit).toBeDisabled();
    fireEvent.click(
        screen.getByRole('button', { name: 'Select repository root' }),
    );
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Select src' }));
    fireEvent.click(submit);
    await waitFor(() => expect(magicModal.hide).toHaveBeenCalledWith(true));
    expect(save).toHaveBeenCalledWith({}, 'team-1', 'repo-1', undefined, [
        '/src',
    ]);
    expect(client.getQueryState(scopesKey('team-1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(scopesKey('team-2'))?.isInvalidated).toBe(
        false,
    );
});

it('edits paths on the existing directory scope while preserving its identity', async () => {
    harness({ id: 'dir-1', initialPaths: ['/src', '/tests'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove /tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save directories' }));
    await waitFor(() => expect(magicModal.hide).toHaveBeenCalledWith(true));
    expect(save).toHaveBeenCalledWith({}, 'team-1', 'repo-1', 'dir-1', [
        '/src',
    ]);
});

it('keeps selected paths available for retry when the API rejects a directory update', async () => {
    save.mockResolvedValue({ error: 500 } as any);
    const client = harness({ id: 'dir-1', initialPaths: ['/src'] });
    fireEvent.click(screen.getByRole('button', { name: 'Save directories' }));
    await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({ variant: 'danger' }),
        ),
    );
    expect(magicModal.hide).not.toHaveBeenCalled();
    expect(magicModal.unlock).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove /src' })).toBeVisible();
    expect(client.getQueryState(scopesKey('team-1'))?.isInvalidated).toBe(
        false,
    );
});
