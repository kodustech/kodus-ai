import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { createLogger } from '@kodus/flow';

import {
    ICliDeviceRepository,
    CLI_DEVICE_REPOSITORY_TOKEN,
} from '@libs/organization/domain/cli-device/contracts/cli-device.repository.contract';
import {
    ICliDeviceService,
    DeviceValidationResult,
} from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';

@Injectable()
export class CliDeviceService implements ICliDeviceService {
    private readonly logger = createLogger(CliDeviceService.name);
    private readonly deviceLimit: number;

    constructor(
        @Inject(CLI_DEVICE_REPOSITORY_TOKEN)
        private readonly cliDeviceRepository: ICliDeviceRepository,
        private readonly configService: ConfigService,
    ) {
        const limitStr = this.configService.get<string>(
            'CLI_DEVICE_LIMIT',
            '0',
        );
        const limitNum = parseInt(limitStr, 10);
        this.deviceLimit = !isNaN(limitNum) ? limitNum : 0;
    }

    async validateOrRegisterDevice(params: {
        deviceId: string;
        deviceToken?: string;
        organizationId: string;
        userId?: string;
        userAgent?: string;
    }): Promise<DeviceValidationResult> {
        const { deviceId, deviceToken, organizationId, userId, userAgent } =
            params;

        const existing = await this.cliDeviceRepository.findOne({
            deviceId,
            organization: { uuid: organizationId },
        });

        // Known device
        if (existing) {
            // Token valid → just update lastSeen
            if (deviceToken) {
                const tokenHash = crypto
                    .createHash('sha256')
                    .update(deviceToken)
                    .digest('hex');

                if (tokenHash === existing.deviceTokenHash) {
                    this.cliDeviceRepository
                        .updateLastSeen(existing.uuid, userAgent)
                        .catch((err) => {
                            this.logger.error({
                                message: 'Error updating device lastSeen',
                                error: err,
                                context: CliDeviceService.name,
                            });
                        });

                    return {};
                }
            }

            // Token missing or invalid → reissue for self-healing
            const newToken = crypto.randomUUID();
            const newTokenHash = crypto
                .createHash('sha256')
                .update(newToken)
                .digest('hex');

            await this.cliDeviceRepository.updateTokenHash(
                existing.uuid,
                newTokenHash,
                userAgent,
            );

            return { deviceToken: newToken };
        }

        // New device → check limit (only truly new devices count)
        if (this.deviceLimit > 0) {
            const count =
                await this.cliDeviceRepository.countByOrganizationId(
                    organizationId,
                );

            if (count >= this.deviceLimit) {
                throw new UnauthorizedException({
                    message: `Device limit reached (${this.deviceLimit}). Remove an existing device or increase the limit.`,
                    code: 'DEVICE_LIMIT_REACHED',
                    details: {
                        limit: this.deviceLimit,
                        current: count,
                    },
                });
            }
        }

        // Register new device
        const rawToken = crypto.randomUUID();
        const tokenHash = crypto
            .createHash('sha256')
            .update(rawToken)
            .digest('hex');

        try {
            await this.cliDeviceRepository.create({
                deviceId,
                deviceTokenHash: tokenHash,
                organization: { uuid: organizationId },
                user: userId ? { uuid: userId } : undefined,
                lastSeenAt: new Date(),
                userAgent,
            });
        } catch (error) {
            // Race condition: another request registered this device concurrently
            // → find it and reissue token instead of failing
            const raced = await this.cliDeviceRepository.findOne({
                deviceId,
                organization: { uuid: organizationId },
            });

            if (raced) {
                const reissueToken = crypto.randomUUID();
                const reissueHash = crypto
                    .createHash('sha256')
                    .update(reissueToken)
                    .digest('hex');

                await this.cliDeviceRepository.updateTokenHash(
                    raced.uuid,
                    reissueHash,
                    userAgent,
                );

                return { deviceToken: reissueToken };
            }

            throw error;
        }

        return { deviceToken: rawToken };
    }
}
