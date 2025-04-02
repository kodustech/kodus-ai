
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { IOrganization } from '../../organization/interfaces/organization.interface';

export interface IOrganizationParameters {
    uuid: string;
    configKey: OrganizationParametersKey;
    configValue: any;
    organization?: Partial<IOrganization>;
}
