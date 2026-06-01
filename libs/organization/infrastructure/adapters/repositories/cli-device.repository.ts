import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CliDeviceModel } from './schemas/cli-device.model';
import { ICliDeviceRepository } from '@libs/organization/domain/cli-device/contracts/cli-device.repository.contract';
import { CliDeviceEntity } from '@libs/organization/domain/cli-device/entities/cli-device.entity';
import { ICliDevice } from '@libs/organization/domain/cli-device/interfaces/cli-device.interface';
import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class CliDeviceDatabaseRepository implements ICliDeviceRepository {
    constructor(
        @InjectRepository(CliDeviceModel)
        private readonly cliDeviceRepository: Repository<CliDeviceModel>,
    ) {}

    async findOne(
        filter: Partial<ICliDevice>,
    ): Promise<CliDeviceEntity | undefined> {
        try {
            const { organization, user, ...otherAttributes } = filter;

            const model = await this.cliDeviceRepository.findOne({
                where: {
                    ...otherAttributes,
                    organization: organization
                        ? { uuid: organization.uuid }
                        : undefined,
                    user: user ? { uuid: user.uuid } : undefined,
                },
            });

            return model
                ? mapSimpleModelToEntity(model, CliDeviceEntity)
                : undefined;
        } catch (error) {
            throw new Error('Error finding CLI device', { cause: error });
        }
    }

    async countByOrganizationId(organizationId: string): Promise<number> {
        try {
            return await this.cliDeviceRepository.count({
                where: { organization: { uuid: organizationId } },
            });
        } catch (error) {
            throw new Error('Error counting CLI devices', { cause: error });
        }
    }

    async create(
        data: Partial<ICliDevice>,
    ): Promise<CliDeviceEntity | undefined> {
        try {
            const model = this.cliDeviceRepository.create({
                deviceId: data.deviceId,
                deviceTokenHash: data.deviceTokenHash,
                organization: data.organization
                    ? ({ uuid: data.organization.uuid } as any)
                    : undefined,
                user: data.user ? ({ uuid: data.user.uuid } as any) : undefined,
                lastSeenAt: data.lastSeenAt ?? new Date(),
                userAgent: data.userAgent,
            });

            const saved = await this.cliDeviceRepository.save(model);
            return mapSimpleModelToEntity(saved, CliDeviceEntity);
        } catch (error) {
            throw new Error('Error creating CLI device', { cause: error });
        }
    }

    async updateLastSeen(uuid: string, userAgent?: string): Promise<void> {
        try {
            const updateData: any = { lastSeenAt: new Date() };
            if (userAgent) {
                updateData.userAgent = userAgent;
            }
            await this.cliDeviceRepository.update({ uuid }, updateData);
        } catch (error) {
            throw new Error('Error updating CLI device lastSeen', {
                cause: error,
            });
        }
    }

    async updateTokenHash(
        uuid: string,
        tokenHash: string,
        userAgent?: string,
    ): Promise<void> {
        try {
            const updateData: any = {
                deviceTokenHash: tokenHash,
                lastSeenAt: new Date(),
            };
            if (userAgent) {
                updateData.userAgent = userAgent;
            }
            await this.cliDeviceRepository.update({ uuid }, updateData);
        } catch (error) {
            throw new Error('Error updating CLI device token', {
                cause: error,
            });
        }
    }
}
