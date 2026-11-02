import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/review-messages.api.js', () => ({
    reviewMessagesApi: {
        getMessages: vi.fn(),
        saveMessages: vi.fn(),
        getLanguage: vi.fn(),
        setLanguage: vi.fn(),
    },
}));

vi.mock('../api/index.js', () => ({
    api: { config: { getTeams: vi.fn() } },
}));

vi.mock('../auth.service.js', () => ({
    authService: { getValidToken: vi.fn() },
}));

vi.mock('../review-settings.service.js', () => ({
    reviewSettingsService: { resolveScope: vi.fn() },
}));

import type { FormattedPullRequestMessages } from '../../types/review-messages.js';
import { ApiError } from '../../types/errors.js';
import { api } from '../api/index.js';
import { reviewMessagesApi } from '../api/review-messages.api.js';
import { authService } from '../auth.service.js';
import {
    resolveLanguage,
    reviewLanguageService,
} from '../review-language.service.js';
import {
    parseMessageValue,
    resolveMessageField,
    reviewMessagesService,
} from '../review-messages.service.js';
import { reviewSettingsService } from '../review-settings.service.js';

const messagesApi = vi.mocked(reviewMessagesApi);
const resolveScope = vi.mocked(reviewSettingsService.resolveScope);

function jwtFor(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

const USER_TOKEN = jwtFor({ sub: 'user-1', organizationId: 'org-1' });

const leaf = (value: unknown, level: string, overriddenValue?: unknown) => ({
    value,
    level: level as 'default',
    ...(overriddenValue !== undefined && {
        overriddenValue,
        overriddenLevel: 'global' as const,
    }),
});

function messages(): FormattedPullRequestMessages {
    return {
        uuid: 'msg-global',
        startReviewMessage: {
            content: leaf('Reviewing now', 'repository', 'Starting'),
            status: leaf('every_push', 'global'),
        },
        endReviewMessage: {
            content: leaf('', 'default'),
            status: leaf('off', 'default'),
        },
        errorReviewMessage: {
            content: leaf('', 'default'),
            status: leaf('active', 'default'),
        },
        globalSettings: {
            hideComments: leaf(false, 'default'),
            suggestionCopyPrompt: leaf(true, 'global'),
        },
    };
}

describe('reviewMessagesService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authService.getValidToken).mockResolvedValue(USER_TOKEN);
        vi.mocked(api.config.getTeams).mockResolvedValue([
            { uuid: 'team-1', name: 'Core', status: 'active' },
        ]);
        resolveScope.mockResolvedValue({
            level: 'repository',
            repositoryId: 'repo-1',
            repositoryName: 'kodustech/kodus-ai',
        });
        messagesApi.getMessages.mockResolvedValue(messages());
        messagesApi.saveMessages.mockResolvedValue(undefined);
    });

    it('rejects a team key with the login hint', async () => {
        vi.mocked(authService.getValidToken).mockResolvedValue('kodus_key');

        await expect(
            reviewMessagesService.show({ repository: '.' }),
        ).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
            message: expect.stringContaining('kodus auth login'),
        });
        expect(messagesApi.getMessages).not.toHaveBeenCalled();
    });

    it('shows every field with the level it comes from', async () => {
        const result = await reviewMessagesService.show({ repository: '.' });

        expect(messagesApi.getMessages).toHaveBeenCalledWith(USER_TOKEN, {
            repositoryId: 'repo-1',
            directoryId: undefined,
        });
        expect(result.fields.find((f) => f.field === 'start.content')).toEqual({
            field: 'start.content',
            value: 'Reviewing now',
            level: 'repository',
            overriddenValue: 'Starting',
            overriddenLevel: 'global',
        });
        expect(result.fields).toHaveLength(7);
    });

    it('reads the global scope with the literal global id, as the page does', async () => {
        resolveScope.mockResolvedValue({ level: 'global' });

        await reviewMessagesService.show({ repository: 'global' });

        expect(messagesApi.getMessages).toHaveBeenCalledWith(USER_TOKEN, {
            repositoryId: 'global',
            directoryId: undefined,
        });
    });

    it('saves the full state with one field changed, at the scope level', async () => {
        await reviewMessagesService.set(
            { repository: '.' },
            'end.status',
            'only-when-opened',
        );

        expect(messagesApi.saveMessages).toHaveBeenCalledWith(USER_TOKEN, {
            teamId: 'team-1',
            configLevel: 'repository',
            repositoryId: 'repo-1',
            startReviewMessage: {
                content: 'Reviewing now',
                status: 'every_push',
            },
            endReviewMessage: { content: '', status: 'only_when_opened' },
            errorReviewMessage: { content: '', status: 'active' },
            globalSettings: { hideComments: false, suggestionCopyPrompt: true },
        });
    });

    it('saves global with a null repository and a directory with its id', async () => {
        resolveScope.mockResolvedValueOnce({ level: 'global' });
        await reviewMessagesService.set(
            { repository: 'global' },
            'hideComments',
            'true',
        );
        expect(messagesApi.saveMessages.mock.calls[0][1]).toMatchObject({
            configLevel: 'global',
            repositoryId: null,
            globalSettings: { hideComments: true },
        });
        expect(messagesApi.saveMessages.mock.calls[0][1]).not.toHaveProperty(
            'directoryId',
        );

        resolveScope.mockResolvedValueOnce({
            level: 'directory',
            repositoryId: 'repo-1',
            repositoryName: 'kodustech/kodus-ai',
            directoryId: 'dir-1',
            directoryPath: 'apps/web',
        });
        await reviewMessagesService.set(
            { repository: '.', directory: 'apps/web' },
            'start',
            'Hi',
        );
        expect(messagesApi.getMessages).toHaveBeenLastCalledWith(USER_TOKEN, {
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
        });
        expect(messagesApi.saveMessages.mock.calls[1][1]).toMatchObject({
            configLevel: 'directory',
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            startReviewMessage: { content: 'Hi' },
        });
    });

    it('turns the error message on with any content write', async () => {
        messagesApi.getMessages.mockResolvedValue({
            ...messages(),
            errorReviewMessage: {
                content: leaf('', 'default'),
                status: leaf('inactive', 'global'),
            },
        });

        await reviewMessagesService.set(
            { repository: '.' },
            'error.content',
            'Ping #oncall',
        );

        expect(
            messagesApi.saveMessages.mock.calls[0][1].errorReviewMessage,
        ).toEqual({ content: 'Ping #oncall', status: 'active' });
    });

    it('reports a centralized pull request', async () => {
        messagesApi.saveMessages.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://github.com/o/r/pull/9',
        });

        const result = await reviewMessagesService.set(
            { repository: '.' },
            'start.status',
            'off',
        );

        expect(result.centralized?.prUrl).toBe('https://github.com/o/r/pull/9');
    });

    it('unset saves the parent value, and is a no-op where the scope inherits', async () => {
        const unset = await reviewMessagesService.unset(
            { repository: '.' },
            'start.content',
        );
        expect(unset).toMatchObject({ changed: true, value: 'Starting' });
        expect(
            messagesApi.saveMessages.mock.calls[0][1].startReviewMessage
                .content,
        ).toBe('Starting');

        const inherited = await reviewMessagesService.unset(
            { repository: '.' },
            'start.status',
        );
        expect(inherited.changed).toBe(false);
        expect(messagesApi.saveMessages).toHaveBeenCalledTimes(1);
    });

    it('fails clearly when the API returns nothing', async () => {
        messagesApi.getMessages.mockResolvedValue(null);

        await expect(
            reviewMessagesService.show({ repository: '.' }),
        ).rejects.toMatchObject({ code: 'API_REQUEST_FAILED' });
    });
});

describe('message fields', () => {
    it('resolves aliases and rejects the error status', () => {
        expect(resolveMessageField('start')).toBe('start.content');
        expect(resolveMessageField('visibility.hideComments')).toBe(
            'hideComments',
        );
        expect(resolveMessageField('END.STATUS')).toBe('end.status');
        expect(() => resolveMessageField('error.status')).toThrow(/no status/);
        expect(() => resolveMessageField('nope')).toThrow(/Unknown/);
    });

    it('validates statuses and booleans', () => {
        expect(parseMessageValue('start.status', 'every-push')).toBe(
            'every_push',
        );
        expect(() => parseMessageValue('start.status', 'active')).toThrow(
            /every_push, only_when_opened, off/,
        );
        expect(parseMessageValue('hideComments', 'on')).toBe(true);
        expect(() => parseMessageValue('hideComments', 'maybe')).toThrow();
        expect(parseMessageValue('end.content', ' keep spaces ')).toBe(
            ' keep spaces ',
        );
    });
});

describe('reviewLanguageService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authService.getValidToken).mockResolvedValue(USER_TOKEN);
        vi.mocked(api.config.getTeams).mockResolvedValue([
            { uuid: 'team-1', name: 'Core', status: 'active' },
        ]);
    });

    it('shows the stored language, or English when the team never saved one', async () => {
        messagesApi.getLanguage.mockResolvedValueOnce({
            configValue: 'pt-BR',
        });
        await expect(reviewLanguageService.show()).resolves.toEqual({
            team: 'Core',
            language: 'pt-BR',
            name: 'Portuguese (Brazil)',
            isDefault: false,
        });
        expect(messagesApi.getLanguage).toHaveBeenCalledWith(
            USER_TOKEN,
            'team-1',
        );

        messagesApi.getLanguage.mockRejectedValueOnce(
            new ApiError(404, 'Not found'),
        );
        await expect(reviewLanguageService.show()).resolves.toMatchObject({
            language: 'en-US',
            isDefault: true,
        });
    });

    it('saves the team parameter by code or name', async () => {
        await reviewLanguageService.set('japanese');

        expect(messagesApi.setLanguage).toHaveBeenCalledWith(
            USER_TOKEN,
            'team-1',
            'ja-JP',
        );
        expect(resolveLanguage('PT-pt').code).toBe('pt-PT');
        expect(() => resolveLanguage('klingon')).toThrow(/Unknown language/);
    });

    it('rejects a team key', async () => {
        vi.mocked(authService.getValidToken).mockResolvedValue('kodus_key');

        await expect(reviewLanguageService.set('pt-BR')).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
        });
        expect(messagesApi.setLanguage).not.toHaveBeenCalled();
    });
});
