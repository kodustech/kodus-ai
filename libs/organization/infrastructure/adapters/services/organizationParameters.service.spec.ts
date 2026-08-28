import { decrypt, encrypt } from '@libs/common/utils/crypto';
import type { BYOKConfig } from '@libs/llm/byok-config';
import { setCodexCredentialStore } from '@libs/llm/codex-subscription-model';
import type { IOrganizationParametersRepository } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersService } from './organizationParameters.service';

function storedConfig(accessToken: string, refreshToken: string): BYOKConfig {
    return {
        version: 2,
        credentials: [
            {
                id: 'credential-id',
                provider: 'chatgpt_subscription',
                settings: {
                    codexAccessToken: encrypt(accessToken),
                    codexRefreshToken: encrypt(refreshToken),
                    accountId: 'account-id',
                    unrelated: 'preserved',
                },
            },
        ],
        models: [
            {
                id: 'model-id',
                credentialId: 'credential-id',
                model: 'gpt-5.6-luna',
            },
        ],
    };
}

function parameter(configValue: BYOKConfig): OrganizationParametersEntity {
    return new OrganizationParametersEntity({
        uuid: 'parameter-id',
        configKey: OrganizationParametersKey.BYOK_CONFIG,
        configValue,
        organization: { uuid: 'organization-id' },
    });
}

describe('OrganizationParametersService Codex token rotation', () => {
    afterEach(() => setCodexCredentialStore(undefined));

    it('encrypts rotation at rest and atomically compares the current config', async () => {
        const current = storedConfig('old-access', 'old-refresh');
        const repository = {
            findByKeyAndValue: jest
                .fn()
                .mockResolvedValue([parameter(current)]),
            compareAndSwapConfigValue: jest.fn().mockResolvedValue(true),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );

        await expect(
            service.rotateCodexTokens({
                credentialId: 'credential-id',
                organizationId: 'organization-id',
                expectedRefreshToken: 'old-refresh',
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                accountId: 'account-id',
            }),
        ).resolves.toEqual({
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            accountId: 'account-id',
        });

        expect(repository.findByKeyAndValue).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'organization-id',
                },
            }),
        );
        const [uuid, expected, replacement] =
            repository.compareAndSwapConfigValue.mock.calls[0];
        expect(uuid).toBe('parameter-id');
        expect(expected).toBe(current);
        const settings = replacement.credentials[0].settings;
        expect(settings.unrelated).toBe('preserved');
        expect(settings.codexAccessToken).not.toBe('new-access');
        expect(settings.codexRefreshToken).not.toBe('new-refresh');
        expect(decrypt(settings.codexAccessToken)).toBe('new-access');
        expect(decrypt(settings.codexRefreshToken)).toBe('new-refresh');
    });

    it('uses the CAS winner tokens after a concurrent rotation', async () => {
        const current = storedConfig('old-access', 'old-refresh');
        const winner = storedConfig('winner-access', 'winner-refresh');
        const repository = {
            findByKeyAndValue: jest
                .fn()
                .mockResolvedValueOnce([parameter(current)])
                .mockResolvedValueOnce([parameter(winner)]),
            compareAndSwapConfigValue: jest.fn().mockResolvedValue(false),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );

        await expect(
            service.rotateCodexTokens({
                credentialId: 'credential-id',
                organizationId: 'organization-id',
                expectedRefreshToken: 'old-refresh',
                accessToken: 'loser-access',
                refreshToken: 'loser-refresh',
                accountId: 'account-id',
            }),
        ).resolves.toEqual({
            accessToken: 'winner-access',
            refreshToken: 'winner-refresh',
            accountId: 'account-id',
        });
        expect(repository.compareAndSwapConfigValue).toHaveBeenCalledTimes(1);
        expect(repository.findByKeyAndValue).toHaveBeenCalledTimes(2);
    });
});
