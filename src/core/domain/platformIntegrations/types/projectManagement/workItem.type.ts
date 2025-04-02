import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

export type WorkItem = {
    columnId: string;
    columnName: string;
    workItems: Item[];
};

export type Item = {
    id: string;
    key: string;
    name: string;
    description: { content: [] };
    changelog: Changelog[];
    workItemCreatedAt: string;
    workItemDeliveredAt?: string;
    columnName: string;
    assignee: Assignee;
    workItemType: WorkItemType;
    status: Status;
    metrics?: any;
    priority?: string;
    flagged?: boolean;
    created?: string;
    customfield_10021?: { value: string }[];
    rank?: number;
};

export type WeekTasks = {
    key: string;
    id: string;
    title: string;
    issueType: string;
    workItemType: WorkItemType;
    workItemCreatedAt: string;
    workItemDeliveredAt?: string;
    changelog: Changelog[];
    description: { content: [] };
    priority?: string;
    responsible: string;
    status?: Status;
    flagged?: boolean;
};

export type Assignee = {
    accountId: string;
    userEmail: string;
    userName: string;
};

export type Changelog = {
    id: string;
    createdAt: string;
    movements: Movement[];
};

export type Movement = {
    field: string;
    fromColumnId: string;
    fromColumnName: string;
    toColumnId: string;
    toColumnName: string;
};

export type WorkItemType = {
    name: string;
    id: string;
    description: string;
    subtask: boolean;
};

export type Status = {
    name: string;
    id: string;
    statusCategory: StatusCategory;
    lastChangedDate?: string;
};

export type StatusCategory = {
    name: string;
    id: number;
};

export type VerifyConnectionType = {
    isSetupComplete: boolean;
    hasConnection: boolean;
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};

export type EstimationMetrics = {
    estimationDate: string;
    isLate?: boolean;
    daysLateDelivery?: number;
    noteAboutEstimation?: string;
};

export type WorkItemEstimation = {
    id: string;
    key: string;
    title: string;
    actualStatus: string;
    assignedTo: string;
    startDate?: string;
    aging?: number;
    p50?: EstimationMetrics;
    p75?: EstimationMetrics;
    p95?: EstimationMetrics;
    message?: string;
    rank?: number;
};

export type WorkItemAging = {
    key: string;
    startDate: string;
    aging: number;
    noteAboutAgingCard?: string;
};

export type WorkItemWithChangelog = {
    key: string;
    changelog: Changelog[];
};

export type ItemWithDeliveryStatus = {
    id: string;
    key: string;
    title: string;
    actualStatus: string;
    assignedTo: string;
    leadTimeToEnd?: number;
    leadTimeUsed?: number;
    percentageLeadTimeAlreadyUsed?: number;
    isLate: boolean;
    onTrackFlag: string;
    estimatedDeliveryDate: Date;
    daysLateDelivery?: number;
    noteAboutEstimation?: string;
    rank?: number;
};
