import {
    MCPToolMetadataService,
    MCPToolMetadata,
} from './mcp-tool-metadata.service';
import { createMCPAdapter } from '../mcp-adapter';

// Mock only createMCPAdapter; keep the real normalize/mark helpers so the
// service's matching logic runs against its true implementation.
jest.mock('../mcp-adapter', () => {
    const actual = jest.requireActual('../mcp-adapter');
    return {
        ...actual,
        createMCPAdapter: jest.fn(),
    };
});

const createMCPAdapterMock = createMCPAdapter as jest.Mock;

/**
 * Build a fake MCP adapter whose registry returns the given tools.
 */
function makeAdapter(tools: unknown[]) {
    const connect = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const listAllTools = jest.fn().mockResolvedValue(tools);
    const getRegistry = jest.fn().mockReturnValue({ listAllTools });
    return { connect, disconnect, listAllTools, getRegistry };
}

describe('MCPToolMetadataService (deterministic logic)', () => {
    let service: MCPToolMetadataService;

    beforeEach(() => {
        jest.clearAllMocks();
        // Heavy constructor dep is never touched by the tested methods.
        service = new MCPToolMetadataService({} as any);
    });

    const md = (
        requiredArgs: string[],
        inputSchema?: unknown,
    ): MCPToolMetadata => ({
        requiredArgs,
        inputSchema,
    });

    describe('resolveToolMetadata', () => {
        it('returns undefined when providerId is missing', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                (service as any).resolveToolMetadata(map, undefined, 'search'),
            ).toBeUndefined();
        });

        it('returns undefined when toolName is missing', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                (service as any).resolveToolMetadata(map, 'github', undefined),
            ).toBeUndefined();
        });

        it('returns undefined when providerId is whitespace-only', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                (service as any).resolveToolMetadata(map, '   ', 'search'),
            ).toBeUndefined();
        });

        it('returns undefined when toolName is whitespace-only', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                (service as any).resolveToolMetadata(map, 'github', '   '),
            ).toBeUndefined();
        });

        it('returns a direct hit, trimming provider and tool', () => {
            const meta = md(['owner', 'repo'], { type: 'object' });
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', meta],
            ]);

            const result = (service as any).resolveToolMetadata(
                map,
                '  github  ',
                '  search  ',
            );

            expect(result).toEqual({
                providerId: 'github',
                toolName: 'search',
                metadata: meta,
            });
            // Must be the same metadata reference from the map.
            expect(result.metadata).toBe(meta);
        });

        it('falls back to a normalized-provider match and returns the CANDIDATE key parts', () => {
            const meta = md(['x']);
            // Direct lookup 'github|search' misses; loop matches candidate provider.
            const map = new Map<string, MCPToolMetadata>([
                ['GitHub-MCP|search', meta],
            ]);

            const result = (service as any).resolveToolMetadata(
                map,
                'github',
                'search',
            );

            expect(result).toEqual({
                providerId: 'GitHub-MCP',
                toolName: 'search',
                metadata: meta,
            });
        });

        it('falls back to a normalized-tool match', () => {
            const meta = md(['x']);
            const map = new Map<string, MCPToolMetadata>([
                ['github|Search_Tool', meta],
            ]);

            const result = (service as any).resolveToolMetadata(
                map,
                'github',
                'searchtool',
            );

            expect(result).toEqual({
                providerId: 'github',
                toolName: 'Search_Tool',
                metadata: meta,
            });
        });

        it('skips keys without a valid provider|tool separator', () => {
            const meta = md(['x']);
            const map = new Map<string, MCPToolMetadata>([
                ['noseparator', meta],
                ['|onlytool', meta],
            ]);

            expect(
                (service as any).resolveToolMetadata(map, 'noseparator', 'x'),
            ).toBeUndefined();
        });

        it('returns undefined when nothing matches', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                (service as any).resolveToolMetadata(map, 'gitlab', 'clone'),
            ).toBeUndefined();
        });

        it('prefers the direct hit over the loop fallback', () => {
            const direct = md(['direct']);
            const other = md(['other']);
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', direct],
                ['GitHub-MCP|search', other],
            ]);

            const result = (service as any).resolveToolMetadata(
                map,
                'github',
                'search',
            );
            expect(result.metadata).toBe(direct);
            expect(result.providerId).toBe('github');
        });
    });

    describe('getMetadataForTool', () => {
        it('returns the metadata object (not the wrapper) for a match', () => {
            const meta = md(['owner'], { type: 'object' });
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', meta],
            ]);

            const result = service.getMetadataForTool(map, 'github', 'search');
            expect(result).toBe(meta);
            expect(result).toEqual({
                requiredArgs: ['owner'],
                inputSchema: { type: 'object' },
            });
        });

        it('returns undefined when no entry resolves', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                service.getMetadataForTool(map, 'gitlab', 'clone'),
            ).toBeUndefined();
        });

        it('returns undefined when providerId is missing', () => {
            const map = new Map<string, MCPToolMetadata>([
                ['github|search', md(['q'])],
            ]);
            expect(
                service.getMetadataForTool(map, undefined, 'search'),
            ).toBeUndefined();
        });
    });

    describe('buildMetadataFromConnections', () => {
        it('returns empty result and never builds an adapter for empty connections', async () => {
            const result = await (service as any).buildMetadataFromConnections(
                [],
            );

            expect(result.metadata.size).toBe(0);
            expect(result.providersWithMetadata.size).toBe(0);
            expect(createMCPAdapterMock).not.toHaveBeenCalled();
        });

        it('maps a tool to its provider and extracts required args (deep equality)', async () => {
            const inputSchema = {
                type: 'object',
                required: ['owner', 'repo'],
                properties: { owner: {}, repo: {} },
            };
            const adapter = makeAdapter([
                { name: 'search', serverName: 'github', inputSchema },
            ]);
            createMCPAdapterMock.mockReturnValue(adapter);

            const connections = [
                { provider: 'github', name: 'GitHub', url: 'http://gh' },
            ];

            const result = await (service as any).buildMetadataFromConnections(
                connections as any,
            );

            expect(result.metadata.get('github|search')).toEqual({
                requiredArgs: ['owner', 'repo'],
                inputSchema,
            });
            expect(result.providersWithMetadata.has('github')).toBe(true);
            // The adapter lifecycle ran.
            expect(adapter.connect).toHaveBeenCalledTimes(1);
            expect(adapter.disconnect).toHaveBeenCalledTimes(1);
        });

        it('skips tools whose serverName maps to no connection provider', async () => {
            const adapter = makeAdapter([
                {
                    name: 'search',
                    serverName: 'unknown-server',
                    inputSchema: {},
                },
            ]);
            createMCPAdapterMock.mockReturnValue(adapter);

            const result = await (service as any).buildMetadataFromConnections([
                { provider: 'github' },
            ] as any);

            expect(result.metadata.size).toBe(0);
            expect(result.providersWithMetadata.size).toBe(0);
        });

        it('matches serverName case-insensitively via the lowercase index', async () => {
            const adapter = makeAdapter([
                { name: 'clone', serverName: 'GITHUB', inputSchema: {} },
            ]);
            createMCPAdapterMock.mockReturnValue(adapter);

            const result = await (service as any).buildMetadataFromConnections([
                { provider: 'github' },
            ] as any);

            expect(result.metadata.has('github|clone')).toBe(true);
        });

        it('uses metadata.connection.id as the provider id (highest precedence)', async () => {
            const adapter = makeAdapter([
                { name: 'list', serverName: 'conn-123', inputSchema: {} },
            ]);
            createMCPAdapterMock.mockReturnValue(adapter);

            const result = await (service as any).buildMetadataFromConnections([
                {
                    provider: 'github',
                    metadata: {
                        connection: { id: 'conn-123', serverName: 'srv' },
                    },
                },
            ] as any);

            // provider id resolves to 'conn-123', so the key uses it, not 'github'.
            expect(result.metadata.has('conn-123|list')).toBe(true);
            expect(result.metadata.has('github|list')).toBe(false);
        });

        it('returns partial/empty result when the adapter throws (fail-safe)', async () => {
            const connect = jest.fn().mockRejectedValue(new Error('boom'));
            const disconnect = jest.fn().mockResolvedValue(undefined);
            createMCPAdapterMock.mockReturnValue({
                connect,
                disconnect,
                getRegistry: jest.fn(),
            });

            const result = await (service as any).buildMetadataFromConnections([
                { provider: 'github' },
            ] as any);

            expect(result.metadata.size).toBe(0);
            expect(result.providersWithMetadata.size).toBe(0);
            // finally-block disconnect still runs.
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        it('treats a missing listAllTools as an empty tool list', async () => {
            createMCPAdapterMock.mockReturnValue({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                getRegistry: jest.fn().mockReturnValue({}),
            });

            const result = await (service as any).buildMetadataFromConnections([
                { provider: 'github' },
            ] as any);

            expect(result.metadata.size).toBe(0);
        });
    });

    // The following private helpers live in the target file and are exercised
    // by buildMetadataFromConnections; testing them directly pins boundaries.
    describe('extractRequiredArgs', () => {
        const call = (schema: unknown) =>
            (service as any).extractRequiredArgs(schema);

        it('returns [] for null / non-object schemas', () => {
            expect(call(null)).toEqual([]);
            expect(call(undefined)).toEqual([]);
            expect(call('string')).toEqual([]);
            expect(call(42)).toEqual([]);
        });

        it('returns trimmed, non-empty string entries from required[], filtering junk', () => {
            expect(
                call({ required: ['owner', '  repo  ', '', '   ', 5, null] }),
            ).toEqual(['owner', 'repo']);
        });

        it('falls back to properties[].required===true when required[] is empty', () => {
            expect(
                call({
                    required: [],
                    properties: {
                        a: { required: true },
                        b: { required: false },
                        c: {},
                    },
                }),
            ).toEqual(['a']);
        });

        it('infers from properties when required is absent entirely', () => {
            expect(
                call({
                    properties: {
                        x: { required: true },
                        y: { required: true },
                        z: {},
                    },
                }),
            ).toEqual(['x', 'y']);
        });

        it('prefers required[] over inferred properties', () => {
            expect(
                call({
                    required: ['fromRequired'],
                    properties: { other: { required: true } },
                }),
            ).toEqual(['fromRequired']);
        });

        it('returns [] when required is a non-array and no properties exist', () => {
            expect(call({ required: 'not-an-array' })).toEqual([]);
        });

        it('ignores non-object property values during inference', () => {
            expect(call({ properties: { x: 'str', y: null, z: 3 } })).toEqual(
                [],
            );
        });

        it('requires the flag to be exactly true (not truthy) during inference', () => {
            expect(
                call({
                    properties: { x: { required: 1 }, y: { required: 'yes' } },
                }),
            ).toEqual([]);
        });
    });

    describe('resolveConnectionProviderId', () => {
        const call = (conn: unknown) =>
            (service as any).resolveConnectionProviderId(conn);

        it('prefers metadata.connection.id, trimmed', () => {
            expect(
                call({
                    metadata: {
                        connection: { id: '  first  ', serverName: 'srv' },
                    },
                    provider: 'p',
                }),
            ).toBe('first');
        });

        it('falls to metadata.connection.serverName when id is blank', () => {
            expect(
                call({
                    metadata: { connection: { id: '   ', serverName: 'srv' } },
                    provider: 'p',
                }),
            ).toBe('srv');
        });

        it('falls to provider, then name, then url in order', () => {
            expect(call({ provider: ' prov ', name: 'nm', url: 'u' })).toBe(
                'prov',
            );
            expect(call({ name: ' nm ', url: 'u' })).toBe('nm');
            expect(call({ url: ' http://x ' })).toBe('http://x');
        });

        it('returns undefined when no candidate is a non-empty string', () => {
            expect(call({})).toBeUndefined();
            expect(call({ provider: '   ', name: '' })).toBeUndefined();
        });
    });

    describe('providersMatch', () => {
        const call = (c: string, r: string, rn?: string) =>
            (service as any).providersMatch(c, r, rn);

        it('is false for a blank candidate', () => {
            expect(call('   ', 'github', 'github')).toBe(false);
        });

        it('is true on exact trimmed equality', () => {
            expect(call('  github  ', 'github')).toBe(true);
        });

        it('is false when the candidate normalizes to nothing', () => {
            expect(call('---', 'github', 'github')).toBe(false);
        });

        it('is true when normalized candidate equals requestedNormalized', () => {
            expect(call('GitHub-MCP', 'github', 'github')).toBe(true);
        });

        it('recomputes the requested normalization as a fallback', () => {
            // requestedNormalized passed as undefined forces the fallback branch.
            expect(call('GitHub-MCP', 'GitHub', undefined)).toBe(true);
        });

        it('is false when neither exact nor normalized forms match', () => {
            expect(call('foo', 'bar', 'bar')).toBe(false);
        });
    });

    describe('toolsMatch', () => {
        const call = (c: string, r: string, rn?: string) =>
            (service as any).toolsMatch(c, r, rn);

        it('is false for a blank candidate', () => {
            expect(call('   ', 'search', 'search')).toBe(false);
        });

        it('is true on exact trimmed equality', () => {
            expect(call('  search  ', 'search')).toBe(true);
        });

        it('is false when the candidate normalizes to nothing', () => {
            expect(call('---', 'search', 'search')).toBe(false);
        });

        it('is true when normalized candidate equals requestedNormalized', () => {
            expect(call('Search_Tool', 'searchtool', 'searchtool')).toBe(true);
        });

        it('recomputes the requested normalization as a fallback', () => {
            expect(call('Search_Tool', 'Search Tool', undefined)).toBe(true);
        });

        it('is false when neither exact nor normalized forms match', () => {
            expect(call('foo', 'bar', 'bar')).toBe(false);
        });
    });

    describe('registerMetadataEntry', () => {
        it('stores the trimmed provider|tool key and marks the provider (+normalized)', () => {
            const map = new Map<string, MCPToolMetadata>();
            const set = new Set<string>();
            const meta = md(['x']);

            (service as any).registerMetadataEntry(
                map,
                set,
                ' GitHub-MCP ',
                ' search ',
                meta,
            );

            expect(map.get('GitHub-MCP|search')).toBe(meta);
            expect(set.has('GitHub-MCP')).toBe(true);
            expect(set.has('github')).toBe(true); // normalized form
        });

        it('is a no-op when provider is blank', () => {
            const map = new Map<string, MCPToolMetadata>();
            const set = new Set<string>();
            (service as any).registerMetadataEntry(
                map,
                set,
                '  ',
                'search',
                md(['x']),
            );
            expect(map.size).toBe(0);
            expect(set.size).toBe(0);
        });

        it('is a no-op when tool is blank', () => {
            const map = new Map<string, MCPToolMetadata>();
            const set = new Set<string>();
            (service as any).registerMetadataEntry(
                map,
                set,
                'github',
                '   ',
                md(['x']),
            );
            expect(map.size).toBe(0);
            expect(set.size).toBe(0);
        });
    });
});
