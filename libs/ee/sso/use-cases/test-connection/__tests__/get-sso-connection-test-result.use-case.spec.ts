import { NotFoundException } from '@nestjs/common';

import { SSOConnectionTestSessionStatus } from '../../../domain/interfaces/ssoConfig.interface';
import { GetSSOConnectionTestResultUseCase } from '../get-sso-connection-test-result.use-case';

describe('GetSSOConnectionTestResultUseCase', () => {
    const makeSut = () => {
        const ssoTestSessionService = {
            getSession: jest.fn(),
        };

        const useCase = new GetSSOConnectionTestResultUseCase(
            ssoTestSessionService as any,
        );

        return {
            useCase,
            ssoTestSessionService,
        };
    };

    it('returns mapped session result', async () => {
        const { useCase, ssoTestSessionService } = makeSut();

        ssoTestSessionService.getSession.mockResolvedValue({
            sessionId: 'session-1',
            status: SSOConnectionTestSessionStatus.SUCCESS,
            configFingerprint: 'fingerprint-1',
            testedAt: '2026-04-20T10:00:00.000Z',
            failureCode: undefined,
            failureMessage: undefined,
        });

        await expect(useCase.execute('session-1')).resolves.toEqual({
            sessionId: 'session-1',
            status: SSOConnectionTestSessionStatus.SUCCESS,
            configFingerprint: 'fingerprint-1',
            testedAt: '2026-04-20T10:00:00.000Z',
            failureCode: undefined,
            failureMessage: undefined,
        });
    });

    it('throws not found when session does not exist', async () => {
        const { useCase, ssoTestSessionService } = makeSut();

        ssoTestSessionService.getSession.mockResolvedValue(null);

        await expect(useCase.execute('missing')).rejects.toBeInstanceOf(
            NotFoundException,
        );

        try {
            await useCase.execute('missing');
        } catch (error: any) {
            expect(error.getResponse()).toMatchObject({
                code: 'SSO_TEST_SESSION_NOT_FOUND',
            });
        }
    });
});
