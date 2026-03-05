import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

import { CliDeviceService } from '@libs/organization/infrastructure/adapters/services/cli-device.service';
import { CLI_DEVICE_REPOSITORY_TOKEN } from '@libs/organization/domain/cli-device/contracts/cli-device.repository.contract';
import { CliDeviceEntity } from '@libs/organization/domain/cli-device/entities/cli-device.entity';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

// ============================================================================
// FIXTURES
// ============================================================================

const ORG_ID = 'org-uuid-1111';
const DEVICE_ID = 'device-uuid-2222';
const DEVICE_UUID = 'entity-uuid-3333';
const USER_ID = 'user-uuid-4444';

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function makeDeviceEntity(overrides: Record<string, any> = {}) {
    return CliDeviceEntity.create({
        uuid: DEVICE_UUID,
        deviceId: DEVICE_ID,
        deviceTokenHash: hashToken('valid-token'),
        organization: { uuid: ORG_ID },
        lastSeenAt: new Date(),
        ...overrides,
    });
}

// ============================================================================
// MOCKS
// ============================================================================

const mockRepository = {
    findOne: jest.fn(),
    countByOrganizationId: jest.fn(),
    create: jest.fn(),
    updateLastSeen: jest.fn(),
    updateTokenHash: jest.fn(),
};

// ============================================================================
// SUITE
// ============================================================================

describe('CliDeviceService', () => {
    let service: CliDeviceService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CliDeviceService,
                {
                    provide: CLI_DEVICE_REPOSITORY_TOKEN,
                    useValue: mockRepository,
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string, defaultVal?: string) => {
                            if (key === 'CLI_DEVICE_LIMIT') return '0';
                            return defaultVal;
                        }),
                    },
                },
            ],
        }).compile();

        service = module.get(CliDeviceService);

        jest.clearAllMocks();
        mockRepository.findOne.mockResolvedValue(undefined);
        mockRepository.countByOrganizationId.mockResolvedValue(0);
        mockRepository.create.mockResolvedValue(makeDeviceEntity());
        mockRepository.updateLastSeen.mockResolvedValue(undefined);
        mockRepository.updateTokenHash.mockResolvedValue(undefined);
    });

    // =========================================================================
    // New device registration
    // =========================================================================

    describe('New device registration', () => {
        it('creates device and returns raw token', async () => {
            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(typeof result.deviceToken).toBe('string');
            expect(result.deviceToken.length).toBeGreaterThan(0);

            expect(mockRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    deviceId: DEVICE_ID,
                    organization: { uuid: ORG_ID },
                    deviceTokenHash: expect.any(String),
                    lastSeenAt: expect.any(Date),
                }),
            );
        });

        it('stores SHA256 hash of token, not the raw token', async () => {
            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            const createCall = mockRepository.create.mock.calls[0][0];
            const expectedHash = hashToken(result.deviceToken);

            expect(createCall.deviceTokenHash).toBe(expectedHash);
        });

        it('passes userId when provided', async () => {
            await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
                userId: USER_ID,
            });

            expect(mockRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    user: { uuid: USER_ID },
                }),
            );
        });

        it('does not pass user when userId is undefined', async () => {
            await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            expect(mockRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    user: undefined,
                }),
            );
        });

        it('passes userAgent to create', async () => {
            await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });

            expect(mockRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userAgent: 'Kodus-CLI/1.0',
                }),
            );
        });
    });

    // =========================================================================
    // Known device with valid token
    // =========================================================================

    describe('Known device with valid token', () => {
        it('returns empty result (no new token) and updates lastSeen', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                deviceToken: 'valid-token',
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/2.0',
            });

            expect(result).toEqual({});
            expect(mockRepository.updateLastSeen).toHaveBeenCalledWith(
                DEVICE_UUID,
                'Kodus-CLI/2.0',
            );
            expect(mockRepository.create).not.toHaveBeenCalled();
            expect(mockRepository.updateTokenHash).not.toHaveBeenCalled();
        });

        it('looks up device by deviceId + organization uuid', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                deviceToken: 'valid-token',
                organizationId: ORG_ID,
            });

            expect(mockRepository.findOne).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                organization: { uuid: ORG_ID },
            });
        });
    });

    // =========================================================================
    // Self-healing: known device with invalid/missing token
    // =========================================================================

    describe('Self-healing: invalid or missing token', () => {
        it('reissues token when provided token does not match hash', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                deviceToken: 'wrong-token',
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.updateTokenHash).toHaveBeenCalledWith(
                DEVICE_UUID,
                hashToken(result.deviceToken),
                undefined,
            );
        });

        it('reissues token when no token is provided (first login on existing device)', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
                // no deviceToken
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.updateTokenHash).toHaveBeenCalledWith(
                DEVICE_UUID,
                hashToken(result.deviceToken),
                undefined,
            );
        });

        it('passes userAgent when reissuing token', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                deviceToken: 'wrong-token',
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/3.0',
            });

            expect(mockRepository.updateTokenHash).toHaveBeenCalledWith(
                DEVICE_UUID,
                expect.any(String),
                'Kodus-CLI/3.0',
            );
        });
    });

    // =========================================================================
    // Race condition handling
    // =========================================================================

    describe('Race condition on concurrent registration', () => {
        it('handles unique constraint violation by finding existing and reissuing', async () => {
            mockRepository.findOne
                .mockResolvedValueOnce(undefined) // first check: not found
                .mockResolvedValueOnce(makeDeviceEntity()); // race retry: found

            mockRepository.create.mockRejectedValue(
                new Error('duplicate key value violates unique constraint'),
            );

            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.findOne).toHaveBeenCalledTimes(2);
            expect(mockRepository.updateTokenHash).toHaveBeenCalledWith(
                DEVICE_UUID,
                hashToken(result.deviceToken),
                undefined,
            );
        });

        it('rethrows error if device still not found after race retry', async () => {
            mockRepository.findOne.mockResolvedValue(undefined);
            mockRepository.create.mockRejectedValue(
                new Error('some other DB error'),
            );

            await expect(
                service.validateOrRegisterDevice({
                    deviceId: DEVICE_ID,
                    organizationId: ORG_ID,
                }),
            ).rejects.toThrow('some other DB error');
        });
    });

    // =========================================================================
    // Device limit
    // =========================================================================

    describe('Device limit', () => {
        let limitedService: CliDeviceService;

        beforeEach(async () => {
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    CliDeviceService,
                    {
                        provide: CLI_DEVICE_REPOSITORY_TOKEN,
                        useValue: mockRepository,
                    },
                    {
                        provide: ConfigService,
                        useValue: {
                            get: jest.fn((key: string, defaultVal?: string) => {
                                if (key === 'CLI_DEVICE_LIMIT') return '3';
                                return defaultVal;
                            }),
                        },
                    },
                ],
            }).compile();

            limitedService = module.get(CliDeviceService);
        });

        it('throws DEVICE_LIMIT_REACHED when count >= limit', async () => {
            mockRepository.findOne.mockResolvedValue(undefined);
            mockRepository.countByOrganizationId.mockResolvedValue(3);

            try {
                await limitedService.validateOrRegisterDevice({
                    deviceId: DEVICE_ID,
                    organizationId: ORG_ID,
                });
                fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(UnauthorizedException);
                const response = error.getResponse();
                expect(response.code).toBe('DEVICE_LIMIT_REACHED');
                expect(response.details).toEqual({
                    limit: 3,
                    current: 3,
                });
            }
        });

        it('allows registration when count < limit', async () => {
            mockRepository.findOne.mockResolvedValue(undefined);
            mockRepository.countByOrganizationId.mockResolvedValue(2);

            const result = await limitedService.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.create).toHaveBeenCalled();
        });

        it('does not check limit for known devices (self-healing)', async () => {
            mockRepository.findOne.mockResolvedValue(makeDeviceEntity());

            const result = await limitedService.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                deviceToken: 'wrong-token',
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.countByOrganizationId).not.toHaveBeenCalled();
        });
    });

    describe('Device limit = 0 (unlimited)', () => {
        it('does not check count when limit is 0', async () => {
            mockRepository.findOne.mockResolvedValue(undefined);

            const result = await service.validateOrRegisterDevice({
                deviceId: DEVICE_ID,
                organizationId: ORG_ID,
            });

            expect(result.deviceToken).toBeDefined();
            expect(mockRepository.countByOrganizationId).not.toHaveBeenCalled();
        });
    });
});
