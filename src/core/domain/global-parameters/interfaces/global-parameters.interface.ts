import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';

export interface IGlobalParameters {
    uuid: string;
    configKey: GlobalParametersKey;
    configValue: any;
}
