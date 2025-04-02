export interface IKodyRules {
    uuid?: string;
    organizationId: string;
    rules: Partial<IKodyRule>[];
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IKodyRule {
    uuid?: string;
    title: string;
    rule: string;
    path?: string;
    status: KodyRulesStatus;
    severity: string;
    label?: string;
    type?: string;
    extendedContext?: IKodyRulesExtendedContext;
    examples?: IKodyRulesExample[];
    repositoryId: string;
    origin?: KodyRulesOrigin;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IKodyRulesExtendedContext {
    todo: string;
}

export interface IKodyRulesExample {
    snippet: string;
    isCorrect: boolean;
}

export enum KodyRulesOrigin {
    USER = 'user',
    LIBRARY = 'library',
    GENERATED = 'generated',
}

export enum KodyRulesStatus {
    ACTIVE = 'active',
    REJECTED = 'rejected',
    PENDING = 'pending',
    DELETED = 'deleted',
}
