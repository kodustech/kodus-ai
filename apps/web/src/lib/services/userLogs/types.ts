export interface UserLog {
    _uuid: string;
    _organizationId: string;
    _teamId: string;
    _action: "create" | "edit" | "delete";
    _userInfo: {
        userId: string;
        userEmail: string;
    };
    _configLevel: "global" | "repository";
    _changedData: Array<{
        actionDescription: string;
        previousValue: any;
        currentValue: any;
        description: string;
    }>;
    _createdAt: string;
    _updatedAt: string;
}

export interface UserLogsResponse {
    logs: UserLog[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}
