import {
    BadRequestException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';

import {
    FixedEgressIpNoIntegrationError,
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

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

const policyWith = (overrides: Record<string, jest.Mock> = {}) =>
    ({
        getFixedIpSetting: jest.fn(async () => ({
            allowedByPlan: true,
            enabled: true,
            fixedIp: '203.0.113.10',
        })),
        setFixedIp: jest.fn(async () => ({
            allowedByPlan: true,
            enabled: true,
        })),
        ...overrides,
    }) as any;

describe('GetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it("shows the team's setting and the IP to allowlist on Kodus Cloud", async () => {
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationAndTeamData,
            }),
        ).resolves.toEqual({
            available: true,
            allowedByPlan: true,
            enabled: true,
            fixedIp: '203.0.113.10',
        });
        expect(policy.getFixedIpSetting).toHaveBeenCalledWith(
            organizationAndTeamData,
        );
    });

    it('hides the setting on a self-hosted install, which reaches Git from its own network', async () => {
        mockEnvironment.API_CLOUD_MODE = false;
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationAndTeamData,
            }),
        ).resolves.toEqual(expect.objectContaining({ available: false }));
        expect(policy.getFixedIpSetting).not.toHaveBeenCalled();
    });
});

describe('SetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it('turns the fixed IP on for the team and names who did it', async () => {
        const policy = policyWith();
        await new SetFixedEgressIpUseCase(policy).execute({
            organizationAndTeamData,
            enabled: true,
            actorUserId: 'user-1',
        });
        expect(policy.setFixedIp).toHaveBeenCalledWith(
            organizationAndTeamData,
            true,
            'user-1',
        );
    });

    it('answers 403 with the plan message when the plan does not include it', async () => {
        const policy = policyWith({
            setFixedIp: jest.fn(async () => {
                throw new FixedEgressIpPlanRequiredError();
            }),
        });
        const error = await new SetFixedEgressIpUseCase(policy)
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
        const error = await new SetFixedEgressIpUseCase(policy)
            .execute({ organizationAndTeamData, enabled: true })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.message).toContain('Try again');
    });

    it('answers 400 when the team has no git integration to hold the setting', async () => {
        const policy = policyWith({
            setFixedIp: jest.fn(async () => {
                throw new FixedEgressIpNoIntegrationError();
            }),
        });
        await expect(
            new SetFixedEgressIpUseCase(policy).execute({
                organizationAndTeamData,
                enabled: true,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a value that is not true or false', async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy).execute({
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
            new SetFixedEgressIpUseCase(policy).execute({
                organizationAndTeamData,
                enabled: true,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });
});
