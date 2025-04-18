import { AzureRepoIdentity } from './azureRepoPullRequest.type';

export interface AzureRepoLink {
    href: string;
}

export enum AzureRepoCommentType {
    /**
     * General comment not attached to specific lines of code.
     * Typically used for opening messages, summaries, or generic feedback.
     */
    TEXT = 1,

    /**
     * Code-related comment attached to a specific file and line number.
     * Used in code review to give feedback on specific parts of the diff.
     */
    CODE = 2,

    /**
     * System-generated comment.
     * Usually created by Azure DevOps itself for actions like build status, merges, etc.
     */
    SYSTEM = 3,
}

export interface AzureRepoLinks {
    self?: AzureRepoLink;
    repository?: AzureRepoLink;
    threads?: AzureRepoLink;
    pullRequests?: AzureRepoLink;
    avatar?: AzureRepoLink;
    [key: string]: AzureRepoLink | undefined;
}

export interface AzureRepoSubscriptionPublisherInputs {
    projectId: string;
    tfsSubscriptionId?: string;
    repository?: string;
    branch?: string;
    [key: string]: string;
}

export interface AzureRepoSubscriptionConsumerInputs {
    url: string;
    basicAuthUsername: string;
    basicAuthPassword: string;
    resourceDetailsToSend: string;
    messagesToSend: string;
    detailedMessagesToSend: string;
    [key: string]: string;
}

export interface AzureRepoSubscription {
    id: string;
    url: string;
    publisherId: string;
    eventType: string;
    consumerId: string;
    consumerActionId: string;
    publisherInputs: AzureRepoSubscriptionPublisherInputs;
    consumerInputs: AzureRepoSubscriptionConsumerInputs;
    createdBy: AzureRepoIdentity;
    createdDate: string;
    modifiedBy: AzureRepoIdentity;
    modifiedDate: string;
    status: string;
    _links: AzureRepoLinks;
}

export interface AzureRepoPRComment {
    id: number;
    parentCommentId?: number;
    author: AzureRepoIdentity;
    content: string;
    publishedDate: string;
    lastUpdatedDate: string;
    lastContentUpdatedDate: string;
    commentType: string;
    usersLiked?: AzureRepoIdentity[];
    _links: AzureRepoLinks;
}

export interface AzureRepoPRThreadProperty {
    $type: string;
    $value: string | number;
}

export interface AzureRepoPRThreadProperties {
    [key: string]: AzureRepoPRThreadProperty;
}

export interface AzureRepoPRThreadContext {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
    leftFileStart?: { line: number; offset: number } | null;
    leftFileEnd?: { line: number; offset: number } | null;
}

export interface AzureRepoPRThread {
    id: number;
    publishedDate: string;
    lastUpdatedDate: string;
    comments: AzureRepoPRComment[];
    status: string;
    pullRequestThreadContext: any | null;
    threadContext: AzureRepoPRThreadContext | null;
    properties: AzureRepoPRThreadProperties;
    identities: any | null;
    isDeleted: boolean;
    _links: AzureRepoLinks;
}

export interface AzureSubscriptionPayload {
    publisherId: string;
    eventType: string;
    resourceVersion: string;
    consumerId: string;
    consumerActionId: string;
    publisherInputs: {
        projectId: string;
    };
    consumerInputs: {
        url: string;
    };
}

/**
 * Representa uma iteração (snapshot) de uma Pull Request.
 */
export interface AzureRepoIteration {
    id?: number | string;
    createdDate?: string;
    lastUpdatedDate?: string;
}

/**
 * Representa uma entrada de mudança (change entry) em uma iteração de PR.
 */
export interface AzureRepoChange {
    changeTrackingId: number;
    changeId: number;
    changeType?: 'edit' | 'add' | 'delete' | 'rename' | string;
    item?: {
        objectId: string;
        originalObjectId?: string;
        path?: string;
    };
}

/**
 * Representa um commit retornado pela API.
 */
export interface AzureRepoCommit {
    commitId?: string; // SHA do commit
    author?: {
        name?: string;
        email?: string;
        date?: string;
        id?: string; // Opcional, pode não estar presente
    };
    comment?: string; // Mensagem do commit
    // Outros campos opcionais, como "committer", podem ser adicionados.
}

export interface AzureRepoFileContent {
    objectId: string; // O ID do objeto Git
    gitObjectType: string; // Tipo do objeto Git (geralmente "blob" para arquivos)
    size?: number; // Tamanho do arquivo
    content?: string; // Conteúdo do arquivo (presente apenas com includeContent=true)
    path?: string; // Caminho do arquivo
    url: string; // URL para acessar o item
    commitId?: string; // ID do commit relacionado
    _links?: {
        // Links relacionados
        self: {
            href: string;
        };
        repository: {
            href: string;
        };
    };
}

export interface AzureRepoDiffChange {
    item?: {
        path?: string;
    };
    changeType?: string;
    diff?: string;
    additions?: number;
    deletions?: number;
}
