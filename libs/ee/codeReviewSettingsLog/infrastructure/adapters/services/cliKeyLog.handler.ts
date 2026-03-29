import { Injectable } from '@nestjs/common';
import {
    BaseLogParams,
    ChangedDataToExport,
    UnifiedLogHandler,
} from './unifiedLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

export interface CliKeyLogParams extends BaseLogParams {
    keyName: string;
}

@Injectable()
export class CliKeyLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logCliKeyAction(params: CliKeyLogParams): Promise<void> {
        const changedData = this.generateChangedData(params);

        if (changedData.length === 0) {
            return;
        }

        await this.unifiedLogHandler.saveLogEntry({
            ...params,
            configLevel: ConfigLevel.GLOBAL,
            repository: undefined,
            changedData,
        });
    }

    private generateChangedData(
        params: CliKeyLogParams,
    ): ChangedDataToExport[] {
        const { actionType, keyName, userInfo } = params;

        if (actionType === ActionType.CREATE) {
            return [
                {
                    actionDescription: 'CLI Key Created',
                    previousValue: null,
                    currentValue: { name: keyName },
                    description: `User ${userInfo.userEmail} created CLI key "${keyName}"`,
                },
            ];
        }

        if (actionType === ActionType.DELETE) {
            return [
                {
                    actionDescription: 'CLI Key Revoked',
                    previousValue: { name: keyName },
                    currentValue: null,
                    description: `User ${userInfo.userEmail} revoked CLI key "${keyName}"`,
                },
            ];
        }

        return [];
    }
}
