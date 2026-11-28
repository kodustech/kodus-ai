import { PruneRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/prune-removed-license-seats.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

const workspace = { organizationId: 'org-1', teamId: 'team-1' };

const build = (opts: {
    connections: string[];
    /** Creation time per connection; the oldest is the primary. */
    createdAt?: Record<string, string>;
    seats: Record<string, string[]>;
    /** Seats from before connections were recorded: in every connection's pool. */
    shared?: string[];
    members: Record<string, string[] | 'unavailable'>;
    bound?: boolean;
    /** The connection billing keeps the workspace plan on, when not the oldest. */
    primary?: string;
    autoAssign?: Record<string, unknown>;
}) => {
    const licenseService = {
        getAllUsersWithLicense: jest.fn(async (otd: any) => [
            ...(opts.seats[otd.integrationId] ?? []).map((git_id) => ({
                git_id,
            })),
            ...(opts.shared ?? []).map((git_id) => ({
                git_id,
                sharedAcrossConnections: true,
            })),
        ]),
        unassignLicenses: jest.fn(async (_otd: any, gitIds: string[]) => ({
            revoked: gitIds,
            failed: [],
        })),
    };
    const memberList = {
        fetch: jest.fn(async (otd: any) => {
            const members = opts.members[otd.integrationId];
            return members === 'unavailable'
                ? { status: 'unavailable', members: [] }
                : {
                      status: 'ok',
                      members: (members ?? []).map((id) => ({ id })),
                  };
        }),
    };
    const codeManagement = {
        getTypeIntegration: jest.fn(async (otd: any) =>
            otd.integrationId === 'gl-b' ? 'gitlab' : 'github',
        ),
    };
    const oldestFirst = [...opts.connections].sort(
        (a, b) =>
            new Date(opts.createdAt?.[a] ?? 0).getTime() -
            new Date(opts.createdAt?.[b] ?? 0).getTime(),
    );
    const connectionBilling = {
        workspaceConnections: jest.fn(async () =>
            oldestFirst.map((uuid) => ({
                uuid,
                createdAt: opts.createdAt?.[uuid],
            })),
        ),
        ensurePrimary: jest.fn(async () =>
            opts.bound === false
                ? { status: 'failed' }
                : {
                      status: 'bound',
                      primaryConnectionId: opts.primary ?? oldestFirst[0],
                  },
        ),
    };
    const useCase = new PruneRemovedLicenseSeatsUseCase(
        memberList as any,
        codeManagement as any,
        licenseService as any,
        {
            findByKey: jest.fn(async () =>
                opts.autoAssign ? { configValue: opts.autoAssign } : undefined,
            ),
        } as any,
        connectionBilling as any,
    );
    return { useCase, licenseService, memberList, connectionBilling };
};

describe('PruneRemovedLicenseSeatsUseCase per Git connection', () => {
    it("checks each connection's seats against that connection's members only", async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': ['1', '2'], 'gl-b': ['1', '9'] },
            members: { 'gh-a': ['1', '2'], 'gl-b': ['9'] },
        });

        const result = await useCase.execute({
            organizationAndTeamData: workspace,
        });

        expect(licenseService.unassignLicenses).toHaveBeenCalledTimes(1);
        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gl-b' },
            ['1'],
            'gitlab',
        );
        expect(result).toMatchObject({
            status: 'ok',
            candidates: ['1'],
            revoked: ['1'],
        });
    });

    it('still prunes a readable connection when another cannot be read, and reports the gap', async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': ['1', '2'], 'gl-b': ['9'] },
            members: { 'gh-a': ['1'], 'gl-b': 'unavailable' },
        });

        const result = await useCase.execute({
            organizationAndTeamData: workspace,
        });

        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gh-a' },
            ['2'],
            'github',
        );
        expect(result.status).toBe('members_unavailable');
        expect(result.revoked).toEqual(['2']);
    });

    it("never revokes a seat shared by every connection from one connection's member list", async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': ['1'], 'gl-b': [] },
            shared: ['5'],
            members: { 'gh-a': ['1', '5'], 'gl-b': [] },
        });

        const result = await useCase.execute({
            organizationAndTeamData: workspace,
        });

        expect(licenseService.unassignLicenses).not.toHaveBeenCalled();
        expect(result.candidates).toEqual([]);
    });

    it('revokes a shared seat once every connection confirms its holder is gone', async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': [], 'gl-b': [] },
            shared: ['5', '6'],
            // Seat 6's holder is only on the second connection.
            members: { 'gh-a': [], 'gl-b': ['6'] },
        });

        const result = await useCase.execute({
            organizationAndTeamData: workspace,
        });

        expect(licenseService.unassignLicenses).toHaveBeenCalledTimes(1);
        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gh-a' },
            ['5'],
            'github',
        );
        expect(result.revoked).toEqual(['5']);
    });

    it('revokes shared seats through the primary connection, whatever order connections come in', async () => {
        const { useCase, licenseService } = build({
            connections: ['gl-b', 'gh-a'],
            createdAt: { 'gh-a': '2024-01-01', 'gl-b': '2026-01-01' },
            seats: { 'gh-a': [], 'gl-b': [] },
            shared: ['5'],
            members: { 'gh-a': [], 'gl-b': [] },
        });

        await useCase.execute({ organizationAndTeamData: workspace });

        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gh-a' },
            ['5'],
            'github',
        );
    });

    it('revokes shared seats through the connection billing keeps the workspace plan on', async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            createdAt: { 'gh-a': '2024-01-01', 'gl-b': '2026-01-01' },
            primary: 'gl-b',
            seats: { 'gh-a': [], 'gl-b': [] },
            shared: ['5'],
            members: { 'gh-a': [], 'gl-b': [] },
        });

        await useCase.execute({ organizationAndTeamData: workspace });

        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gl-b' },
            ['5'],
            'gitlab',
        );
    });

    it('leaves shared seats while any connection cannot be read', async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': [], 'gl-b': [] },
            shared: ['5'],
            members: { 'gh-a': [], 'gl-b': 'unavailable' },
        });

        await useCase.execute({ organizationAndTeamData: workspace });

        expect(licenseService.unassignLicenses).not.toHaveBeenCalled();
    });

    it('keeps the single-connection path unchanged', async () => {
        const { useCase, memberList } = build({
            connections: ['gh-a'],
            seats: {},
            members: {},
        });

        await useCase.execute({ organizationAndTeamData: workspace });

        expect(memberList.fetch).toHaveBeenCalledWith(
            workspace,
            expect.anything(),
        );
    });

    it('revokes nothing while billing has not recorded which connection keeps the workspace seats', async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': ['1'], 'gl-b': ['9'] },
            members: { 'gh-a': [], 'gl-b': [] },
            bound: false,
        });

        const result = await useCase.execute({
            organizationAndTeamData: workspace,
        });

        expect(result.status).toBe('members_unavailable');
        expect(licenseService.unassignLicenses).not.toHaveBeenCalled();
    });

    it("keeps the bots seeded on a connection's own lists out of that connection's prune", async () => {
        const { useCase, licenseService } = build({
            connections: ['gh-a', 'gl-b'],
            seats: { 'gh-a': [], 'gl-b': ['bot-gl', '9'] },
            members: { 'gh-a': [], 'gl-b': [] },
            autoAssign: {
                seededBotIds: [],
                connections: { 'gl-b': { seededBotIds: ['bot-gl'] } },
            },
        });

        await useCase.execute({ organizationAndTeamData: workspace });

        expect(licenseService.unassignLicenses).toHaveBeenCalledWith(
            { ...workspace, integrationId: 'gl-b' },
            ['9'],
            'gitlab',
        );
    });
});
