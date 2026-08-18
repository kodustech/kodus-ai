import type { ToolCaller } from '../../runtime/skill-runtime.types';
import {
    resetTaskContextSiteHintsCache,
    resolveTaskContextSiteHints,
} from './site-resolution';

const logger = { warn: jest.fn() } as never;

const toolCaller = (
    tools: string[],
    callTool: ToolCaller['callTool'],
): ToolCaller =>
    ({
        callTool,
        getRegisteredTools: () => tools.map((name) => ({ name })),
    }) as ToolCaller;

const input = (over: Record<string, unknown> = {}) => ({
    organizationId: 'org-1',
    providerType: 'atlassianrovo',
    logger,
    ...over,
});

describe('resolveTaskContextSiteHints', () => {
    beforeEach(() => {
        resetTaskContextSiteHintsCache();
        jest.clearAllMocks();
    });

    it('returns empty when no resolver tool is registered', async () => {
        const callTool = jest.fn();
        const out = await resolveTaskContextSiteHints(
            input({
                toolCaller: toolCaller(['getJiraIssue'], callTool as never),
                registeredTools: ['getJiraIssue'],
            }) as never,
        );

        expect(out).toEqual({ siteIds: [], siteUrls: [] });
        expect(callTool).not.toHaveBeenCalled();
    });

    it('extracts site ids and urls from the resolver payload', async () => {
        const callTool = jest.fn().mockResolvedValue({
            result: [
                { id: 'cloud-uuid', url: 'https://acme.atlassian.net' },
                { id: 'other-uuid', url: 'https://other.atlassian.net' },
            ],
        });
        const out = await resolveTaskContextSiteHints(
            input({
                toolCaller: toolCaller(
                    ['getAccessibleAtlassianResources'],
                    callTool as never,
                ),
                registeredTools: ['getAccessibleAtlassianResources'],
            }) as never,
        );

        expect(out.siteIds).toEqual(['cloud-uuid', 'other-uuid']);
        expect(out.siteUrls).toEqual([
            'https://acme.atlassian.net',
            'https://other.atlassian.net',
        ]);
    });

    it('unwraps a JSON string payload nested in MCP content blocks', async () => {
        const callTool = jest.fn().mockResolvedValue({
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify([{ id: 'cloud-uuid' }]),
                    },
                ],
            },
        });
        const out = await resolveTaskContextSiteHints(
            input({
                toolCaller: toolCaller(
                    ['getAccessibleAtlassianResources'],
                    callTool as never,
                ),
                registeredTools: ['getAccessibleAtlassianResources'],
            }) as never,
        );

        expect(out.siteIds).toEqual(['cloud-uuid']);
    });

    it('calls the resolver once per organization', async () => {
        const callTool = jest
            .fn()
            .mockResolvedValue({ result: [{ id: 'cloud-uuid' }] });
        const args = input({
            toolCaller: toolCaller(
                ['getAccessibleAtlassianResources'],
                callTool as never,
            ),
            registeredTools: ['getAccessibleAtlassianResources'],
        }) as never;

        await resolveTaskContextSiteHints(args);
        await resolveTaskContextSiteHints(args);

        expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure, so a transient error is retried', async () => {
        const callTool = jest
            .fn()
            .mockRejectedValueOnce(new Error('mcp down'))
            .mockResolvedValue({ result: [{ id: 'cloud-uuid' }] });
        const args = input({
            toolCaller: toolCaller(
                ['getAccessibleAtlassianResources'],
                callTool as never,
            ),
            registeredTools: ['getAccessibleAtlassianResources'],
        }) as never;

        expect(await resolveTaskContextSiteHints(args)).toEqual({
            siteIds: [],
            siteUrls: [],
        });
        expect((await resolveTaskContextSiteHints(args)).siteIds).toEqual([
            'cloud-uuid',
        ]);
    });
});
