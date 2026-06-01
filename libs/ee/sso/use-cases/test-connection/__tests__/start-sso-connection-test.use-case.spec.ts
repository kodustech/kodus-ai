import {
    BadRequestException,
    InternalServerErrorException,
} from '@nestjs/common';

import {
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../../../domain/interfaces/ssoConfig.interface';
import { StartSSOConnectionTestUseCase } from '../start-sso-connection-test.use-case';

describe('StartSSOConnectionTestUseCase', () => {
    const validProviderConfig: SSOProtocolConfigMap[SSOProtocol.SAML] = {
        idpIssuer: 'idp-issuer',
        entryPoint: 'https://idp.example.com/sso',
        cert: 'certificate',
        issuer: 'kodus-orchestrator',
    };

    const makeSut = () => {
        const ssoTestSessionService = {
            createSession: jest.fn().mockResolvedValue({
                sessionId: 'session-1',
                configFingerprint: 'fingerprint-1',
            }),
        };

        const useCase = new StartSSOConnectionTestUseCase(
            ssoTestSessionService as any,
        );

        return {
            useCase,
            ssoTestSessionService,
        };
    };

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.API_URL;
    });

    it('starts a test session and returns redirect URL', async () => {
        process.env.API_URL = 'https://api.example.com';
        const { useCase, ssoTestSessionService } = makeSut();

        const result = await useCase.execute({
            organizationId: 'org-1',
            protocol: SSOProtocol.SAML,
            providerConfig: validProviderConfig,
            domains: ['acme.com'],
            userId: 'user-1',
        });

        expect(ssoTestSessionService.createSession).toHaveBeenCalledWith({
            organizationId: 'org-1',
            protocol: SSOProtocol.SAML,
            providerConfig: validProviderConfig,
            domains: ['acme.com'],
            createdBy: 'user-1',
        });

        expect(result).toEqual({
            sessionId: 'session-1',
            configFingerprint: 'fingerprint-1',
            redirectUrl:
                'https://api.example.com/auth/sso/login/org-1?RelayState=session-1',
        });
    });

    it('throws bad request when required SAML fields are missing', async () => {
        process.env.API_URL = 'https://api.example.com';
        const { useCase } = makeSut();

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                protocol: SSOProtocol.SAML,
                providerConfig: {
                    ...validProviderConfig,
                    cert: '',
                },
                domains: ['acme.com'],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws internal server error when API_URL is missing', async () => {
        const { useCase } = makeSut();

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                protocol: SSOProtocol.SAML,
                providerConfig: validProviderConfig,
                domains: ['acme.com'],
            }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('strips trailing slash from API_URL so the redirect is not double-slashed', async () => {
        // Regression: a trailing slash on API_URL produced
        // "http://host//auth/sso/login/..." — Keycloak still served
        // the login page at the doubled path so the bug looked
        // cosmetic, but it breaks any IdP that does strict path
        // matching.
        process.env.API_URL = 'https://api.example.com/';
        const { useCase } = makeSut();

        const result = await useCase.execute({
            organizationId: 'org-1',
            protocol: SSOProtocol.SAML,
            providerConfig: validProviderConfig,
            domains: ['acme.com'],
        });

        expect(result.redirectUrl).toBe(
            'https://api.example.com/auth/sso/login/org-1?RelayState=session-1',
        );
    });
});
