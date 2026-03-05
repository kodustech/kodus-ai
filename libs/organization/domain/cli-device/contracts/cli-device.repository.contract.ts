import { CliDeviceEntity } from '../entities/cli-device.entity';
import { ICliDevice } from '../interfaces/cli-device.interface';

export const CLI_DEVICE_REPOSITORY_TOKEN = Symbol.for('CliDeviceRepository');

export interface ICliDeviceRepository {
    findOne(filter: Partial<ICliDevice>): Promise<CliDeviceEntity | undefined>;
    countByOrganizationId(organizationId: string): Promise<number>;
    create(data: Partial<ICliDevice>): Promise<CliDeviceEntity | undefined>;
    updateLastSeen(uuid: string, userAgent?: string): Promise<void>;
    updateTokenHash(
        uuid: string,
        tokenHash: string,
        userAgent?: string,
    ): Promise<void>;
}
