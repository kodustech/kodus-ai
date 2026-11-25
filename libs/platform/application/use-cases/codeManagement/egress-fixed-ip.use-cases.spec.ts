import {
    BadRequestException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';

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

describe('GetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it("shows the organization's setting and the IP to allowlist on Kodus Cloud", async () => {
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationId: ORG,
            }),
        ).resolves.toEqual({ available: true, ...setting });
        expect(policy.getFixedIpSetting).toHaveBeenCalledWith(ORG);
    });

    it('refuses a session without an organization', async () => {
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationId: undefined,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.getFixedIpSetting).not.toHaveBeenCalled();
    });

    it('does not offer the setting while direct egress is not rolled out to the organization', async () => {
        const policy = policyWith({
            getFixedIpSetting: jest.fn(async () => ({
                ...setting,
                inRollout: false,
            })),
        });
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationId: ORG,
            }),
        ).resolves.toEqual(expect.objectContaining({ available: false }));
    });

    it('hides the setting on a self-hosted install, which reaches Git from its own network', async () => {
        mockEnvironment.API_CLOUD_MODE = false;
        const policy = policyWith();
        await expect(
            new GetFixedEgressIpUseCase(policy).execute({
                organizationId: ORG,
            }),
        ).resolves.toEqual(expect.objectContaining({ available: false }));
        expect(policy.getFixedIpSetting).not.toHaveBeenCalled();
    });
});

describe('SetFixedEgressIpUseCase', () => {
    afterEach(() => (mockEnvironment.API_CLOUD_MODE = true));

    it('turns the fixed IP on for the organization and names who did it', async () => {
        const policy = policyWith();
        await new SetFixedEgressIpUseCase(policy).execute({
            organizationId: ORG,
            enabled: true,
            actorUserId: 'user-1',
        });
        expect(policy.setFixedIp).toHaveBeenCalledWith(ORG, true, {
            actorUserId: 'user-1',
        });
    });

    it('refuses a session without an organization', async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy).execute({
                organizationId: undefined,
                enabled: false,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });

    it('answers 403 with the plan message when the plan does not include it', async () => {
        const policy = policyWith({
            setFixedIp: jest.fn(async () => {
                throw new FixedEgressIpPlanRequiredError();
            }),
        });
        const error = await new SetFixedEgressIpUseCase(policy)
            .execute({ organizationId: ORG, enabled: true })
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
            .execute({ organizationId: ORG, enabled: true })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.message).toContain('Try again');
    });

    it('refuses a value that is not true or false', async () => {
        const policy = policyWith();
        await expect(
            new SetFixedEgressIpUseCase(policy).execute({
                organizationId: ORG,
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
                organizationId: ORG,
                enabled: true,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(policy.setFixedIp).not.toHaveBeenCalled();
    });
});
