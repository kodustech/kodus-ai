import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';

export interface ISuggestionEmbedded {
    uuid?: string;
    suggestionId: string;
    suggestionEmbed: number[];
    pullRequestNumber: number;
    repositoryId: string;
    repositoryFullName: string;
    organization?: Partial<IOrganization> | null;
    label: string;
    severity: string;
    feedbackType: string;
    improvedCode: string;
    suggestionContent: string;
    language: string;
 }
