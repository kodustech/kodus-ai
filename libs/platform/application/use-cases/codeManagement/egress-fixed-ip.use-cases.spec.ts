import {
    BadRequestException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import {
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
} from '@libs/sandbox/domain/egress-plan';

import {
    GetFixedEgressIpUseCase,
    SetFixedEgressIpUseCase,
} from './egress-fixed-ip.use-cases';

const mockEnvironment = { API_CLOUD_MODE: true };
jest.mock('@libs/ee/configs/environment', () => ({
    get environment() {
        return mockEnvironment;
    },
}));

const ORG = 'org-1';
const TEAM = 'team-1';
const INTEGRATION = 'int-1';
const organizationAndTeamData = { organizationId: ORG, teamId: TEAM };

const setting = {
    allowedByPlan: true,
    enabled: true,
    savedOn: true,
    inRollout: true,
    fixedIp: '203.0.113.10',
};

const policyWith = (overrides: Record<string, jest.Mock> = {}) =>
    ({
        getFixedIpSetting: jest.fn(async () => ({ ...setting })),
        setFixedIp: jest.fn(async () => ({ ...setting })),
        ...overrides,
    }) as any;

/** Integrations by organization and team; anything else finds none. */
const integrationsOf = (owned: Record<string, string> = { [ORG]: TEAM }) =>
    ({
        findOne: jest.fn(async (filter: any) =>
            owned[filter.organization?.uuid] === filter.team?.uuid
                ? { uuid: INTEGRATION }
                : null,
        ),
    }) as any;

describe('GetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it("shows the team's setting and the IP to allowlist on Kodus Cloud", async () => {
        const policy = policyWith();
        const integrations = integrationsOf();
        await expect(
            new GetFixedEgressIpUseCase(policy, integrations).execute({
                organizationAndTeamData,
            }),
        ).resolves.toEqual({ available: true, ...setting });
        expect(integrations.findOne).toHaveBeenCalledWith({
            organization: { uuid: ORG },
            team: { uuid: TEAM },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
        });
        expect(policy.getFixedIpSetting).toHaveBeenCalledWith(
            organizationAndTeamData,
            INTEGRATION,
        );
    });

    it("never reads another organization's team", async () => {
        const policy = policyWith();
        const integrations = integrationsOf({ 'org-2': 'team-of-org-2' });
        await expect(
            new GetFixedEgressIpUseCase(policy, integrations).execute({
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: 'team-of-org-2',
                },
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.getFixedIpSetting).not.toHaveBeenCalled();
    });

    it('refuses a request without a team before looking anything up', async () => {
        const policy = policyWith();
        const integrations = integrationsOf();
        await expect(
            new GetFixedEgressIpUseCase(policy, integrations).execute({
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: undefined as any,
                },
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(integrations.findOne).not.toHaveBeenCalled();
    });

    it('does not offer the setting while direct egress is not rolled out to the organization', async () => {
        const policy = policyWith({
            getFixedIpSetting: jest.fn(async () => ({
                ...setting,
                inRollout: false,
            })),
        });
        await expect(
            new GetFixedEgressIpUseCase(policy, integrationsOf()).execute({
                organizationAndTeamData,
            }),
        ).resolves.toEqual(expect.objectContaining({ available: false }));
    });

    it('hides the setting on a self-hosted install, which reaches Git from its own network', async () => {
        mockEnvironment.API_CLOUD_MODE = false;
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy, integrationsOf()).execute({
                organizationAndTeamData,
            }),
        ).resolves.toEqual(expect.objectContaining({ available: false }));
        expect(policy.getFixedIpSetting).not.toHaveBeenCalled();
    });
});

describe('SetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it("turns the fixed IP on for the team's integration and names who did it", async () => {
        const policy = policyWith();
        await new SetFixedEgressIpUseCase(policy, integrationsOf()).execute({
            organizationAndTeamData,
            enabled: true,
            actorUserId: 'user-1',
        });
        expect(policy.setFixedIp).toHaveBeenCalledWith(
            organizationAndTeamData,
            true,
            { integrationId: INTEGRATION, actorUserId: 'user-1' },
        );
    });

    it("never changes another organization's team", async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(
                policy,
                integrationsOf({ 'org-2': 'team-of-org-2' }),
            ).execute({
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: 'team-of-org-2',
                },
                enabled: false,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });

    it('refuses a request without a team before looking anything up', async () => {
        const policy = policyWith();
        const integrations = integrationsOf();
        await expect(
            new SetFixedEgressIpUseCase(policy, integrations).execute({
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: undefined as any,
                },
                enabled: false,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(integrations.findOne).not.toHaveBeenCalled();
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });

    it('answers 403 with the plan message when the plan does not include it', async () => {
        const policy = policyWith({
            setFixedIp: jest.fn(async () => {
                throw new FixedEgressIpPlanRequiredError();
            }),
        });
        const error = await new SetFixedEgressIpUseCase(
            policy,
            integrationsOf(),
        )
            .execute({ organizationAndTeamData, enabled: true })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toContain('Teams and Enterprise');
    });

    it('answers 503 asking to try again when billing cannot confirm the plan', async () => {
        const policy = policyWith({
            setFixedIp: jest.fn(async () => {
                throw new FixedEgressIpPlanUnconfirmedError();
            }),
        });
        const error = await new SetFixedEgressIpUseCase(
            policy,
            integrationsOf(),
        )
            .execute({ organizationAndTeamData, enabled: true })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.message).toContain('Try again');
    });

    it('answers 400 when the team has no active git integration', async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy, integrationsOf({})).execute({
                organizationAndTeamData,
                enabled: true,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });

    it('refuses a value that is not true or false', async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy, integrationsOf()).execute({
                organizationAndTeamData,
                enabled: 'yes' as any,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });

    it('changes nothing on a self-hosted install', async () => {
        mockEnvironment.API_CLOUD_MODE = false;
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy, integrationsOf()).execute({
                organizationAndTeamData,
                enabled: true,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });
});
