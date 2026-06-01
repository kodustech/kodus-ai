import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    BaseLogParams,
    ChangedDataToExport,
} from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/unifiedLog.handler';

export function createMockUnifiedLogHandler() {
    return {
        saveLogEntry: jest.fn().mockResolvedValue(undefined),
        logAction: jest.fn().mockResolvedValue(undefined),
    };
}

export function createBaseParams(
    overrides: Partial<BaseLogParams> = {},
): BaseLogParams {
    return {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        userInfo: {
            userId: 'user-1',
            userEmail: 'user@test.com',
        },
        actionType: ActionType.EDIT,
        ...overrides,
    } as BaseLogParams;
}

export function extractChangedData(
    mock: jest.Mock,
    callIndex = 0,
): ChangedDataToExport[] {
    return mock.mock.calls[callIndex]?.[0]?.changedData ?? [];
}
