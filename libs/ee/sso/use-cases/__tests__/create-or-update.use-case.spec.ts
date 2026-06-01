import { BadRequestException } from '@nestjs/common';

import {
    SSOConnectionTestStatus,
    SSOProtocol,
} from '../../domain/interfaces/ssoConfig.interface';
import { CreateOrUpdateSSOConfigUseCase } from '../create-or-update.use-case';

describe('CreateOrUpdateSSOConfigUseCase', () => {
    const validProviderConfig = {
        idpIssuer: 'idp-issuer',
        entryPoint: 'https://idp.example.com/sso',
        cert: 'certificate',
        issuer: 'kodus-orchestrator',
    };

    const makeSut = () => {
        const ssoConfigService = {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };

        const ssoTestSessionService = {
            getSession: jest.fn(),
            toConnectionTestMetadata: jest.fn(),
        };

        const ssoDomainVerificationService = {
            getDomainVerificationStatus: jest.fn(),
        };

        const useCase = new CreateOrUpdateSSOConfigUseCase(
            ssoConfigService as any,
            ssoTestSessionService as any,
            ssoDomainVerificationService as any,
        );

        return {
            useCase,
            ssoConfigService,
            ssoTestSessionService,
            ssoDomainVerificationService,
        };
    };

    it('requires successful test when creating an active SSO config', async () => {
        const { useCase } = makeSut();

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                protocol: SSOProtocol.SAML,
                providerConfig: validProviderConfig,
                active: true,
                domains: ['acme.com'],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows creating inactive SSO config without test session', async () => {
        const { useCase, ssoConfigService } = makeSut();

        ssoConfigService.create.mockResolvedValue({
            uuid: 'cfg-1',
            toJson: () => ({ uuid: 'cfg-1' }),
        });

        const result = await useCase.execute({
            organizationId: 'org-1',
            protocol: SSOProtocol.SAML,
            providerConfig: validProviderConfig,
            active: false,
            domains: ['ACME.com'],
        });

        expect(ssoConfigService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                active: false,
                domains: ['acme.com'],
                connectionTest: undefined,
            }),
        );
        expect(result).toEqual({ uuid: 'cfg-1' });
    });

    it('allows enabling with matching persisted successful fingerprint', async () => {
        const { useCase, ssoConfigService } = makeSut();

        ssoConfigService.findOne.mockResolvedValue({
            uuid: 'cfg-1',
            protocol: SSOProtocol.SAML,
            providerConfig: validProviderConfig,
            domains: ['acme.com'],
            active: false,
            domainVerification: {
                verifiedDomains: [
                    {
                        domain: 'acme.com',
                        verifiedAt: new Date('2026-04-20T00:00:00.000Z'),
                        verifiedByEmail: 'admin@acme.com',
                    },
                ],
            },
            connectionTest: {
                status: SSOConnectionTestStatus.SUCCESS,
                configFingerprint: JSON.stringify({
                    domains: ['acme.com'],
                    protocol: SSOProtocol.SAML,
                    providerConfig: {
                        cert: 'certificate',
                        entryPoint: 'https://idp.example.com/sso',
                        idpIssuer: 'idp-issuer',
                        issuer: 'kodus-orchestrator',
                    },
                }),
            },
        });

        ssoConfigService.update.mockResolvedValue({
            uuid: 'cfg-1',
            toJson: () => ({ uuid: 'cfg-1', active: true }),
        });

        const result = await useCase.execute({
            organizationId: 'org-1',
            uuid: 'cfg-1',
            active: true,
        });

        expect(ssoConfigService.update).toHaveBeenCalledWith(
            'cfg-1',
            expect.objectContaining({
                active: true,
            }),
        );
        expect(result).toEqual({ uuid: 'cfg-1', active: true });
    });
});
