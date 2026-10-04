jest.mock(
    '@libs/cli-review/application/use-cases/execute-cli-review.use-case',
    () => ({ ExecuteCliReviewUseCase: class {} }),
);
jest.mock(
    '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service',
    () => ({ AuthenticatedRateLimiterService: class {} }),
);
jest.mock(
    '@libs/cli-review/infrastructure/services/trial-rate-limiter.service',
    () => ({ TrialRateLimiterService: class {} }),
);
jest.mock(
    '@libs/cli-review/application/use-cases/ingest-session-event.use-case',
    () => ({ IngestSessionEventUseCase: class {} }),
);

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { CliReviewController } from '../cli/cli-review.controller';

const SECRET = 'test-secret';
const jwt = new JwtService();
const session = {
    email: 'dev@acme.dev',
    role: 'owner',
    status: STATUS.ACTIVE,
    organizationId: 'org-1',
};

describe('CliReviewController.getReviewJob (JWT path)', () => {
    const jobStatus = { execute: jest.fn().mockResolvedValue({ status: 'x' }) };
    const teams: Record<string, any> = {
        'team-1': { uuid: 'team-1', organization: { uuid: 'org-1' } },
        'team-other': { uuid: 'team-other', organization: { uuid: 'org-2' } },
    };
    const controller = new CliReviewController(
        {} as any,
        {} as any,
        jobStatus as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {
            findById: jest.fn(async (id: string) => teams[id] ?? null),
            findFirstCreatedTeam: jest.fn(async () => teams['team-1']),
        } as any,
        {
            validateUser: jest.fn(async ({ email }) =>
                email === session.email
                    ? { role: session.role, status: session.status }
                    : null,
            ),
        } as any,
        {} as any,
        {} as any,
        jwt,
        { get: () => ({ secret: SECRET }) } as any,
    );

    const call = (token: string, teamId?: string) =>
        controller.getReviewJob('job-1', undefined, `Bearer ${token}`, teamId);

    beforeEach(() => jobStatus.execute.mockClear());

    it('accepts a user session of the organization', async () => {
        await call(jwt.sign(session, { secret: SECRET }));
        expect(jobStatus.execute).toHaveBeenCalledWith({
            jobId: 'job-1',
            organizationId: 'org-1',
        });
    });

    it('rejects a non-session token signed with the same secret', async () => {
        const serviceToken = jwt.sign(
            { organizationId: 'org-1' },
            {
                secret: SECRET,
                issuer: 'kodus-mcp-server',
                audience: 'kodus-mcp-server',
            },
        );
        await expect(call(serviceToken)).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
        expect(jobStatus.execute).not.toHaveBeenCalled();
    });

    it('rejects a teamId of another organization', async () => {
        await expect(
            call(jwt.sign(session, { secret: SECRET }), 'team-other'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(jobStatus.execute).not.toHaveBeenCalled();
    });
});
