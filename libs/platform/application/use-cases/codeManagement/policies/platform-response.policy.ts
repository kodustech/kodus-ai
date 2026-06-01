import { GitHubReaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

const ACKNOWLEDGMENT_MESSAGES = {
    DEFAULT: 'Analyzing your request...',
    MARKDOWN_SUFFIX: '<!-- kody-codereview -->\n&#8203;',
} as const;

interface IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean;
    usesReaction(): boolean;
    getAcknowledgmentReaction(): GitHubReaction;
    getAcknowledgmentBody(): string;
}

class GitHubResponsePolicy implements IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean {
        return false;
    }

    usesReaction(): boolean {
        return true;
    }

    getAcknowledgmentReaction(): GitHubReaction {
        return GitHubReaction.ROCKET;
    }

    getAcknowledgmentBody(): string {
        throw new Error(
            'GitHubResponsePolicy does not use acknowledgment body. Use reactions instead.',
        );
    }
}

class GitLabResponsePolicy implements IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean {
        return false;
    }

    usesReaction(): boolean {
        return true;
    }

    getAcknowledgmentReaction(): GitHubReaction {
        return GitHubReaction.ROCKET;
    }

    getAcknowledgmentBody(): string {
        throw new Error(
            'GitLabResponsePolicy does not use acknowledgment body. Use reactions instead.',
        );
    }
}

class BitbucketResponsePolicy implements IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean {
        return true;
    }

    usesReaction(): boolean {
        return false;
    }

    getAcknowledgmentBody(): string {
        return ACKNOWLEDGMENT_MESSAGES.DEFAULT.trim();
    }

    getAcknowledgmentReaction(): GitHubReaction {
        throw new Error(
            'BitbucketResponsePolicy does not use reactions. Use acknowledgment body instead.',
        );
    }
}

class AzureReposResponsePolicy implements IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean {
        return true;
    }

    usesReaction(): boolean {
        return false;
    }

    getAcknowledgmentBody(): string {
        return `${ACKNOWLEDGMENT_MESSAGES.DEFAULT}${ACKNOWLEDGMENT_MESSAGES.MARKDOWN_SUFFIX}`.trim();
    }

    getAcknowledgmentReaction(): GitHubReaction {
        throw new Error(
            'AzureReposResponsePolicy does not use reactions. Use acknowledgment body instead.',
        );
    }
}

class ForgejoResponsePolicy implements IPlatformResponsePolicy {
    requiresAcknowledgment(): boolean {
        return false;
    }

    usesReaction(): boolean {
        return true;
    }

    getAcknowledgmentReaction(): GitHubReaction {
        return GitHubReaction.ROCKET;
    }

    getAcknowledgmentBody(): string {
        throw new Error(
            'ForgejoResponsePolicy does not use acknowledgment body. Use reactions instead.',
        );
    }
}

export class PlatformResponsePolicyFactory {
    static create(platformType: PlatformType): IPlatformResponsePolicy {
        switch (platformType) {
            case PlatformType.GITHUB:
                return new GitHubResponsePolicy();
            case PlatformType.GITLAB:
                return new GitLabResponsePolicy();
            case PlatformType.BITBUCKET:
                return new BitbucketResponsePolicy();
            case PlatformType.AZURE_REPOS:
                return new AzureReposResponsePolicy();
            case PlatformType.FORGEJO:
                return new ForgejoResponsePolicy();
            default:
                return new GitLabResponsePolicy();
        }
    }
}
