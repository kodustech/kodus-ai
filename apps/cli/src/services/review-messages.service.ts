import { reviewMessagesApi } from './api/review-messages.api.js';
import {
    reviewSettingsService,
    type SettingsScope,
    type SettingsTarget,
} from './review-settings.service.js';
import {
    userContextService,
    type UserContext,
} from './user-context.service.js';
import type { CentralizedPrMetadata } from '../types/config.js';
import type {
    FormattedPullRequestMessages,
    MessagesGlobalSettings,
    PullRequestMessageStatus,
    ReviewMessage,
    ReviewMessageType,
    SavePullRequestMessagesRequest,
} from '../types/review-messages.js';
import type {
    FormattedConfigLeaf,
    FormattedConfigLevel,
} from '../types/review-settings.js';
import { CommandError } from '../utils/command-errors.js';

const FEATURE = 'Custom messages';

/** What the Custom Messages page lets you pick for the start and end messages. */
export const MESSAGE_STATUSES: PullRequestMessageStatus[] = [
    'every_push',
    'only_when_opened',
    'off',
];

export type MessageField =
    | 'start.content'
    | 'start.status'
    | 'end.content'
    | 'end.status'
    | 'error.content'
    | 'hideComments'
    | 'suggestionCopyPrompt';

type FieldDefinition = {
    field: MessageField;
    type: 'text' | 'status' | 'boolean';
    description: string;
};

export const MESSAGE_FIELDS: FieldDefinition[] = [
    {
        field: 'start.content',
        type: 'text',
        description:
            'Comment Kody posts when a review starts (Markdown, supports the page placeholders).',
    },
    {
        field: 'start.status',
        type: 'status',
        description:
            'When the start message is posted: every_push, only_when_opened or off.',
    },
    {
        field: 'end.content',
        type: 'text',
        description: 'Comment Kody posts when a review ends.',
    },
    {
        field: 'end.status',
        type: 'status',
        description:
            'When the end message is posted: every_push, only_when_opened or off.',
    },
    {
        field: 'error.content',
        type: 'text',
        description:
            "Text appended below Kody's default comment when a review fails. Empty posts only the default comment.",
    },
    {
        field: 'hideComments',
        type: 'boolean',
        description:
            "Visibility: post Kody's review comments collapsed, as hidden comments (GitHub only).",
    },
    {
        field: 'suggestionCopyPrompt',
        type: 'boolean',
        description:
            'Visibility: add a prompt to each suggestion the developer can paste into an AI assistant (on Bitbucket it is a reply in the thread).',
    },
];

const MESSAGE_KEYS: Record<'start' | 'end' | 'error', ReviewMessageType> = {
    start: 'startReviewMessage',
    end: 'endReviewMessage',
    error: 'errorReviewMessage',
};

const FIELD_ALIASES: Record<string, MessageField> = {
    'start': 'start.content',
    'end': 'end.content',
    'error': 'error.content',
    'visibility.hidecomments': 'hideComments',
    'visibility.suggestioncopyprompt': 'suggestionCopyPrompt',
    'globalsettings.hidecomments': 'hideComments',
    'globalsettings.suggestioncopyprompt': 'suggestionCopyPrompt',
};

export type ResolvedMessageField = {
    field: MessageField;
    value: unknown;
    level: FormattedConfigLevel;
    overriddenValue?: unknown;
    overriddenLevel?: FormattedConfigLevel;
};

export type MessagesShowResult = {
    team: string;
    scope: SettingsScope;
    fields: ResolvedMessageField[];
};

export type MessagesMutationResult = {
    team: string;
    scope: SettingsScope;
    field: MessageField;
    value: unknown;
    changed: boolean;
    centralized?: CentralizedPrMetadata & { mode: 'centralized-pr' };
};

export function resolveMessageField(input: string): MessageField {
    const normalized = input.trim();
    const lower = normalized.toLowerCase();
    const direct = MESSAGE_FIELDS.find(
        (definition) => definition.field.toLowerCase() === lower,
    );
    if (direct) {
        return direct.field;
    }
    const alias =
        FIELD_ALIASES[lower] ??
        FIELD_ALIASES[lower.replace(/reviewmessage/, '')];
    if (alias) {
        return alias;
    }
    if (lower === 'error.status') {
        throw new CommandError(
            'INVALID_INPUT',
            'The error message has no status: setting error.content turns it on, an empty error.content turns it off.',
        );
    }
    throw new CommandError(
        'INVALID_INPUT',
        `Unknown message field '${input}'. Fields: ${MESSAGE_FIELDS.map((definition) => definition.field).join(', ')}.`,
    );
}

export function parseMessageValue(field: MessageField, raw: string): unknown {
    const definition = MESSAGE_FIELDS.find((entry) => entry.field === field);
    if (definition?.type === 'boolean') {
        const lower = raw.trim().toLowerCase();
        if (['true', 'on', 'yes', '1'].includes(lower)) {
            return true;
        }
        if (['false', 'off', 'no', '0'].includes(lower)) {
            return false;
        }
        throw new CommandError(
            'INVALID_INPUT',
            `${field} takes true or false, got '${raw}'.`,
        );
    }
    if (definition?.type === 'status') {
        const lower = raw.trim().toLowerCase().replace(/-/g, '_');
        if (!MESSAGE_STATUSES.includes(lower as PullRequestMessageStatus)) {
            throw new CommandError(
                'INVALID_INPUT',
                `${field} takes ${MESSAGE_STATUSES.join(', ')}, got '${raw}'.`,
            );
        }
        return lower;
    }
    return raw;
}

function leafFor(
    messages: FormattedPullRequestMessages,
    field: MessageField,
): FormattedConfigLeaf | undefined {
    if (field === 'hideComments' || field === 'suggestionCopyPrompt') {
        return messages.globalSettings?.[field];
    }
    const [type, property] = field.split('.') as [
        'start' | 'end' | 'error',
        'content' | 'status',
    ];
    return messages[MESSAGE_KEYS[type]]?.[property];
}

function valueOf<T>(leaf: FormattedConfigLeaf | undefined, fallback: T): T {
    return leaf?.value === undefined || leaf.value === null
        ? fallback
        : (leaf.value as T);
}

/** The whole state the page saves, read back from the formatted config. */
export function currentMessagesState(messages: FormattedPullRequestMessages): {
    startReviewMessage: ReviewMessage;
    endReviewMessage: ReviewMessage;
    errorReviewMessage: ReviewMessage;
    globalSettings: MessagesGlobalSettings;
} {
    const message = (type: ReviewMessageType): ReviewMessage => ({
        content: valueOf(messages[type]?.content, ''),
        status: valueOf<PullRequestMessageStatus>(
            messages[type]?.status,
            type === 'errorReviewMessage' ? 'active' : 'every_push',
        ),
    });
    return {
        startReviewMessage: message('startReviewMessage'),
        endReviewMessage: message('endReviewMessage'),
        errorReviewMessage: message('errorReviewMessage'),
        globalSettings: {
            hideComments: valueOf(messages.globalSettings?.hideComments, false),
            suggestionCopyPrompt: valueOf(
                messages.globalSettings?.suggestionCopyPrompt,
                false,
            ),
        },
    };
}

export function applyMessageField(
    state: ReturnType<typeof currentMessagesState>,
    field: MessageField,
    value: unknown,
): ReturnType<typeof currentMessagesState> {
    if (field === 'hideComments' || field === 'suggestionCopyPrompt') {
        return {
            ...state,
            globalSettings: { ...state.globalSettings, [field]: value },
        };
    }
    const [type, property] = field.split('.') as [
        'start' | 'end' | 'error',
        'content' | 'status',
    ];
    const key = MESSAGE_KEYS[type];
    const next: ReviewMessage = { ...state[key], [property]: value };
    // The error message has no toggle: any content write persists ACTIVE so
    // the runtime append-gate (status === ACTIVE && content) passes, as the
    // page does (custom-messages/_components/tab-content.tsx).
    if (key === 'errorReviewMessage') {
        next.status = 'active';
    }
    return { ...state, [key]: next };
}

function isCentralizedPr(
    value: unknown,
): value is CentralizedPrMetadata & { mode: 'centralized-pr' } {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { mode?: unknown }).mode === 'centralized-pr'
    );
}

class ReviewMessagesService {
    private async load(target: SettingsTarget): Promise<{
        ctx: UserContext;
        scope: SettingsScope;
        messages: FormattedPullRequestMessages;
    }> {
        const ctx = await userContextService.resolve(FEATURE, {
            team: target.team,
        });
        const scope = await reviewSettingsService.resolveScope(ctx, target);
        const messages = await reviewMessagesApi.getMessages(ctx.accessToken, {
            // The page reads the global scope with the literal 'global' route id.
            repositoryId:
                scope.level === 'global'
                    ? 'global'
                    : (scope.repositoryId as string),
            directoryId: scope.directoryId,
        });
        if (!messages) {
            throw new CommandError(
                'API_REQUEST_FAILED',
                'Could not read the custom messages for this scope. Try again.',
            );
        }
        return { ctx, scope, messages };
    }

    async show(target: SettingsTarget): Promise<MessagesShowResult> {
        const { ctx, scope, messages } = await this.load(target);
        return {
            team: ctx.teamName,
            scope,
            fields: MESSAGE_FIELDS.map(({ field }) => {
                const leaf = leafFor(messages, field);
                return {
                    field,
                    value: leaf?.value,
                    level: leaf?.level ?? 'default',
                    ...(leaf?.overriddenValue !== undefined && {
                        overriddenValue: leaf.overriddenValue,
                    }),
                    ...(leaf?.overriddenLevel && {
                        overriddenLevel: leaf.overriddenLevel,
                    }),
                };
            }),
        };
    }

    private async save(
        ctx: UserContext,
        scope: SettingsScope,
        state: ReturnType<typeof currentMessagesState>,
    ) {
        // Same body the page sends (apps/web/src/lib/services/pull-request-messages/fetch.ts):
        // the full state, the level and the scope ids; the API resolves the
        // stored entity itself, so no uuid is sent.
        const body: SavePullRequestMessagesRequest = {
            teamId: ctx.teamId,
            configLevel: scope.level,
            repositoryId:
                scope.level === 'global' ? null : (scope.repositoryId ?? null),
            ...(scope.directoryId && { directoryId: scope.directoryId }),
            ...state,
        };
        return reviewMessagesApi.saveMessages(ctx.accessToken, body);
    }

    async set(
        target: SettingsTarget,
        fieldInput: string,
        rawValue: string,
    ): Promise<MessagesMutationResult> {
        const field = resolveMessageField(fieldInput);
        const value = parseMessageValue(field, rawValue);
        const { ctx, scope, messages } = await this.load(target);
        const state = applyMessageField(
            currentMessagesState(messages),
            field,
            value,
        );
        const result = await this.save(ctx, scope, state);
        return {
            team: ctx.teamName,
            scope,
            field,
            value,
            changed: true,
            ...(isCentralizedPr(result) && { centralized: result }),
        };
    }

    /** Drops this scope's override of one field: saves the parent's value, as the page's revert does. */
    async unset(
        target: SettingsTarget,
        fieldInput: string,
    ): Promise<MessagesMutationResult> {
        const field = resolveMessageField(fieldInput);
        const { ctx, scope, messages } = await this.load(target);
        const leaf = leafFor(messages, field);

        if (!leaf || leaf.level !== scope.level) {
            return {
                team: ctx.teamName,
                scope,
                field,
                value: leaf?.value,
                changed: false,
            };
        }
        if (leaf.overriddenValue === undefined) {
            throw new CommandError(
                'INVALID_INPUT',
                `'${field}' has no inherited value to go back to. Set it explicitly instead.`,
            );
        }

        const state = applyMessageField(
            currentMessagesState(messages),
            field,
            leaf.overriddenValue,
        );
        const result = await this.save(ctx, scope, state);
        return {
            team: ctx.teamName,
            scope,
            field,
            value: leaf.overriddenValue,
            changed: true,
            ...(isCentralizedPr(result) && { centralized: result }),
        };
    }
}

export const reviewMessagesService = new ReviewMessagesService();
