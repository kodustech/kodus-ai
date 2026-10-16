/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/ui/tooltip';

let mockPathname = '/settings/code-review/global/general';
let mockDirectoryId: string | null = null;
const mockPush = jest.fn();
const mockRedirect = jest.fn();

const scopes = [
    { id: 'configured', name: 'InfraScope', isSelected: true, directories: [] },
    { id: 'inherited', name: 'app', isSelected: false, directories: [] },
    {
        id: 'with-directory',
        name: 'monorepo',
        isSelected: false,
        directories: [{ id: 'dir-1', name: 'src', paths: ['/src'] }],
    },
];

const mockNavigation = {
    usePathname: () => mockPathname,
    useParams: () => ({ repositoryId: mockPathname.split('/')[3] }),
    useSearchParams: () =>
        new URLSearchParams(
            mockDirectoryId ? { directoryId: mockDirectoryId } : {},
        ),
    useRouter: () => ({ push: mockPush }),
    redirect: (href: string) => {
        mockRedirect(href);
        throw new Error('redirect');
    },
};
jest.mock('next/navigation', () => mockNavigation);

// Local installs can carry separate Next copies at the root and in apps/web.
jest.doMock(
    require.resolve('next/navigation', { paths: [`${process.cwd()}/apps/web`] }),
    () => mockNavigation,
);
jest.mock('nuqs', () => ({
    useQueryState: () => [mockDirectoryId, jest.fn()],
}));
jest.mock('@services/parameters/use-code-review-scopes', () => ({
    useCodeReviewScopes: () => scopes,
    directoryScopeLabel: (directory: { paths: string[] }) => directory.paths[0],
}));
jest.mock('@services/parameters/hooks', () => ({
    useCodeReviewSettingsShell: (
        _teamId: string,
        options: { initialData: unknown },
    ) => ({ data: options.initialData }),
    useSuspenseGetDefaultCodeReviewParameter: () => ({}),
    useSuspenseGetParameterPlatformConfigs: () => ({ configValue: {} }),
}));
jest.mock('@services/parameters/fetch', () => ({
    createOrUpdateCodeReviewParameter: jest.fn(),
}));
jest.mock('@services/permissions/hooks', () => ({ usePermission: () => true }));
jest.mock('src/core/providers/selected-team-context', () => ({
    useSelectedTeamId: () => ({ teamId: 'team-1' }),
}));
jest.mock('src/core/providers/all-teams-context', () => ({
    useAllTeams: () => ({
        teams: [{ uuid: 'team-1', name: 'Workspace', status: 'active' }],
    }),
}));
jest.mock(
    'src/features/ee/subscription/_providers/subscription-context',
    () => ({
        useSubscriptionContext: () => ({ license: {} }),
    }),
);
jest.mock('src/features/ee/subscription/_hooks/use-feature-gates', () => ({
    useFeatureGates: () => ({}),
}));
jest.mock('src/core/layout/navbar/use-main-nav-items', () => ({
    useMainNavItems: () => [],
}));
jest.mock('src/core/layout/navbar/_components/command-palette', () => ({
    CommandPalette: () => null,
}));
jest.mock('src/core/layout/navbar/_components/github-stars', () => ({
    GithubStars: () => null,
}));
jest.mock('src/core/layout/navbar/_components/notification-bell', () => ({
    NotificationBell: () => null,
}));
jest.mock('src/core/layout/navbar/_components/user-nav', () => ({
    UserNav: () => null,
}));
jest.mock('src/core/layout/sidebar/plan-status', () => ({
    SidebarPlanStatus: () => null,
}));
jest.mock(
    '../../../apps/web/src/app/(app)/settings/_components/copy-settings-modal',
    () => ({ AddRepoModal: () => null }),
);
jest.mock(
    '../../../apps/web/src/app/(app)/settings/_components/kodus-config-file-status',
    () => ({ KodusConfigFileStatusBadge: () => null }),
);
jest.mock(
    '../../../apps/web/src/app/(app)/settings/_components/override-count',
    () => ({ OverrideCount: () => null }),
);
jest.mock(
    '../../../apps/web/src/app/(app)/settings/_components/per-repository/options-dropdown',
    () => ({
        SidebarRepositoryOrDirectoryDropdown: () => (
            <button>Delete configuration</button>
        ),
    }),
);

const { SettingsLayout } = require('../../../apps/web/src/app/(app)/settings/_components/_layout');
const { useCodeReviewConfig } = require('../../../apps/web/src/app/(app)/settings/_components/context');
const { AppSidebar } = require('../../../apps/web/src/core/layout/sidebar');
const { ScopeToolsProvider } = require('../../../apps/web/src/core/layout/sidebar/scope-tools');
const { createOrUpdateCodeReviewParameter } = require('@services/parameters/fetch');

const configs = { automatedReviewActive: { value: true, level: 'global' } };
const configValue = {
    configs,
    repositories: scopes.map((scope) => ({
        ...scope,
        configs,
        directories: scope.directories.map((directory) => ({
            ...directory,
            configs,
        })),
    })),
};

const ConfigProbe = () => {
    const config = useCodeReviewConfig();
    return (
        <output>
            {config?.name}: {String(config?.automatedReviewActive.value)}
        </output>
    );
};

const Harness = () => (
    <TooltipProvider>
        <ScopeToolsProvider>
            <AppSidebar />
            <SettingsLayout
                initialTeamId="team-1"
                initialConfigValue={configValue as any}
                initialDefaultConfig={{} as any}
                initialPlatformConfig={{ configValue: {} } as any}
                initialParameters={{}}
                initialModelData={{ llmConfigStatus: null, byokModels: [] }}
            >
                <ConfigProbe />
            </SettingsLayout>
        </ScopeToolsProvider>
    </TooltipProvider>
);

beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
    window.matchMedia = jest.fn().mockReturnValue({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    });
    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
});

beforeEach(() => {
    mockPathname = '/settings/code-review/global/general';
    mockDirectoryId = null;
    jest.clearAllMocks();
});

it('lists and opens repositories inheriting Global without creating configuration', () => {
    const view = render(<Harness />);
    fireEvent.click(
        screen.getByRole('button', {
            name: 'Settings scope: Global. Change scope',
        }),
    );

    const inherited = screen.getByRole('option', {
        name: 'app Inherits Global',
    });
    expect(screen.getByRole('option', { name: 'InfraScope' })).toBeVisible();
    expect(
        screen.getByRole('option', { name: 'monorepo Inherits Global' }),
    ).toBeVisible();
    expect(screen.getByRole('option', { name: 'monorepo /src' })).toBeVisible();
    fireEvent.click(inherited);
    expect(mockPush).toHaveBeenCalledWith(
        '/settings/code-review/inherited/general',
    );

    mockPathname = mockPush.mock.calls[0][0];
    view.rerender(<Harness />);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByText('app: true')).toBeVisible();
    expect(
        screen.queryByRole('button', { name: 'Delete configuration' }),
    ).not.toBeInTheDocument();
    expect(createOrUpdateCodeReviewParameter).not.toHaveBeenCalled();
});

it('keeps directory navigation available under a repository inheriting Global', () => {
    mockPathname = '/settings/code-review/with-directory/general';
    mockDirectoryId = 'dir-1';
    render(<Harness />);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(
        screen.getByRole('button', { name: 'Delete configuration' }),
    ).toBeVisible();
    fireEvent.click(
        screen.getByRole('button', { name: /Settings scope: monorepo/ }),
    );
    const directory = screen.getByRole('option', { name: 'monorepo /src' });
    expect(directory).toHaveAttribute('aria-current', 'true');
    fireEvent.click(
        screen.getByRole('option', { name: 'monorepo Inherits Global' }),
    );
    expect(mockPush).toHaveBeenCalledWith(
        '/settings/code-review/with-directory/general',
    );
});

it.each([
    ['/settings/code-review/missing/general', null],
    ['/settings/code-review/with-directory/general', 'missing'],
    ['/settings/code-review/configured/general', 'missing'],
])(
    'redirects unavailable scopes %s / %s to Global',
    (pathname, directoryId) => {
        mockPathname = pathname!;
        mockDirectoryId = directoryId;
        expect(() => render(<Harness />)).toThrow('redirect');
        expect(mockRedirect).toHaveBeenCalledWith(
            '/settings/code-review/global/general',
        );
    },
);
