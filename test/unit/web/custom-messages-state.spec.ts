import type { FormattedCustomMessageEntity } from '../../../apps/web/src/lib/services/pull-request-messages/types';
import {
    buildCustomMessagesEditorState,
    getCustomMessagesDirtySection,
    hasCustomMessagesPendingChanges,
} from '../../../apps/web/src/app/(app)/settings/code-review/_utils/custom-messages-state';
import { FormattedConfigLevel } from '../../../apps/web/src/app/(app)/settings/code-review/_types';
import { PullRequestMessageStatus } from '../../../apps/web/src/lib/services/pull-request-messages/types';

const buildMessages = (): FormattedCustomMessageEntity => ({
    uuid: 'message-1',
    repositoryId: 'global',
    directoryId: undefined,
    startReviewMessage: {
        content: {
            level: FormattedConfigLevel.GLOBAL,
            value: 'Start review',
        },
        status: {
            level: FormattedConfigLevel.GLOBAL,
            value: PullRequestMessageStatus.EVERY_PUSH,
        },
    },
    endReviewMessage: {
        content: {
            level: FormattedConfigLevel.GLOBAL,
            value: 'End review',
        },
        status: {
            level: FormattedConfigLevel.GLOBAL,
            value: PullRequestMessageStatus.ONLY_WHEN_OPENED,
        },
    },
    globalSettings: {
        hideComments: {
            level: FormattedConfigLevel.GLOBAL,
            value: false,
        },
        suggestionCopyPrompt: {
            level: FormattedConfigLevel.GLOBAL,
            value: true,
        },
    },
});

describe('hasCustomMessagesPendingChanges', () => {
    it('returns false when the local state matches the fetched snapshot', () => {
        const pullRequestMessages = buildMessages();

        expect(
            hasCustomMessagesPendingChanges({
                pullRequestMessages,
                messages: {
                    startReviewMessage: pullRequestMessages.startReviewMessage,
                    endReviewMessage: pullRequestMessages.endReviewMessage,
                },
                globalSettings: pullRequestMessages.globalSettings,
            }),
        ).toBe(false);
    });

    it('returns true when the start review message changes', () => {
        const pullRequestMessages = buildMessages();

        expect(
            hasCustomMessagesPendingChanges({
                pullRequestMessages,
                messages: {
                    startReviewMessage: {
                        ...pullRequestMessages.startReviewMessage,
                        content: {
                            ...pullRequestMessages.startReviewMessage.content,
                            value: 'Changed',
                        },
                    },
                    endReviewMessage: pullRequestMessages.endReviewMessage,
                },
                globalSettings: pullRequestMessages.globalSettings,
            }),
        ).toBe(true);
    });

    it('returns true when the end review status changes', () => {
        const pullRequestMessages = buildMessages();

        expect(
            hasCustomMessagesPendingChanges({
                pullRequestMessages,
                messages: {
                    startReviewMessage: pullRequestMessages.startReviewMessage,
                    endReviewMessage: {
                        ...pullRequestMessages.endReviewMessage,
                        status: {
                            ...pullRequestMessages.endReviewMessage.status,
                            value: PullRequestMessageStatus.OFF,
                        },
                    },
                },
                globalSettings: pullRequestMessages.globalSettings,
            }),
        ).toBe(true);
    });

    it('returns true when the global settings change', () => {
        const pullRequestMessages = buildMessages();

        expect(
            hasCustomMessagesPendingChanges({
                pullRequestMessages,
                messages: {
                    startReviewMessage: pullRequestMessages.startReviewMessage,
                    endReviewMessage: pullRequestMessages.endReviewMessage,
                },
                globalSettings: {
                    ...pullRequestMessages.globalSettings,
                    suggestionCopyPrompt: {
                        ...pullRequestMessages.globalSettings
                            .suggestionCopyPrompt,
                        value: false,
                    },
                },
            }),
        ).toBe(true);
    });
});

describe('buildCustomMessagesEditorState', () => {
    it('builds the local editor state from the fetched snapshot', () => {
        const pullRequestMessages = buildMessages();

        expect(buildCustomMessagesEditorState(pullRequestMessages)).toEqual({
            messages: {
                startReviewMessage: pullRequestMessages.startReviewMessage,
                endReviewMessage: pullRequestMessages.endReviewMessage,
            },
            globalSettings: pullRequestMessages.globalSettings,
        });
    });
});

describe('getCustomMessagesDirtySection', () => {
    it('returns the first dirty section in priority order', () => {
        const pullRequestMessages = buildMessages();
        const editorState = buildCustomMessagesEditorState(pullRequestMessages);

        expect(
            getCustomMessagesDirtySection({
                pullRequestMessages,
                editorState: {
                    ...editorState,
                    globalSettings: {
                        ...editorState.globalSettings,
                        hideComments: {
                            ...editorState.globalSettings.hideComments,
                            value: true,
                        },
                    },
                },
            }),
        ).toBe('globalSettings');

        expect(
            getCustomMessagesDirtySection({
                pullRequestMessages,
                editorState: {
                    ...editorState,
                    messages: {
                        ...editorState.messages,
                        startReviewMessage: {
                            ...editorState.messages.startReviewMessage,
                            content: {
                                ...editorState.messages.startReviewMessage
                                    .content,
                                value: 'Changed',
                            },
                        },
                    },
                },
            }),
        ).toBe('startReviewMessage');
    });

    it('returns null when nothing changed', () => {
        const pullRequestMessages = buildMessages();

        expect(
            getCustomMessagesDirtySection({
                pullRequestMessages,
                editorState:
                    buildCustomMessagesEditorState(pullRequestMessages),
            }),
        ).toBeNull();
    });
});
