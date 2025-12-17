import { IssueStatus } from '@/config/types/general/issues.type';
import {
    IContributingSuggestion,
    IRepositoryToIssues,
} from '@/core/infrastructure/adapters/services/kodyIssuesManagement/domain/kodyIssuesManagement.interface';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

export interface IIssue {
    uuid?: string;
    title: string;
    description: string;
    filePath: string;
    language: string;
    label: LabelType;
    severity: SeverityLevel;
    contributingSuggestions: IContributingSuggestion[];
    repository: IRepositoryToIssues;
    organizationId: string;
    age?: string;
    status?: IssueStatus;
    createdAt: string;
    updatedAt: string;
    prNumbers?: string[];
    owner?: {
        gitId: string;
        username: string;
    };
    reporter?: { 
        gitId: string;
        username: string;
    };
    kodyRule?: {
        number?: string;
        title?: string;
    };
}
