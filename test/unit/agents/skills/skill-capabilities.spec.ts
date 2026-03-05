import {
    resolveCapabilityToolSelection,
    resolveCapabilityTools,
} from '@libs/agents/skills/skill-capabilities';

describe('skill-capabilities', () => {
    it('resolves concrete tool names from capabilities using registry and allowed-tools', () => {
        const result = resolveCapabilityToolSelection({
            capabilities: ['pr.metadata.read', 'pr.diff.read'],
            allowedTools: ['KODUS_GET_PULL_REQUEST'],
            registeredTools: [
                'KODUS_GET_PULL_REQUEST',
                'KODUS_GET_PULL_REQUEST_DIFF',
            ],
            toolMode: 'any',
        });

        expect(result.toolByCapability['pr.metadata.read']).toBe(
            'KODUS_GET_PULL_REQUEST',
        );
        expect(result.toolByCapability['pr.diff.read']).toBeUndefined();
        expect(result.missingCapabilities).toEqual(['pr.diff.read']);
        expect(result.hasRequiredTools).toBe(true);
    });

    it('requires all tool-backed capabilities when policy is all', () => {
        const result = resolveCapabilityToolSelection({
            capabilities: ['pr.metadata.read', 'pr.diff.read'],
            registeredTools: ['KODUS_GET_PULL_REQUEST'],
            toolMode: 'all',
        });

        expect(result.hasRequiredTools).toBe(false);
        expect(result.missingCapabilities).toEqual(['pr.diff.read']);
    });

    it('does not treat non-tool capabilities as missing', () => {
        const result = resolveCapabilityToolSelection({
            capabilities: ['task.context.read'],
            registeredTools: [],
            toolMode: 'all',
        });

        expect(result.hasRequiredTools).toBe(true);
        expect(result.missingCapabilities).toHaveLength(0);
        expect(result.toolByCapability['task.context.read']).toBeUndefined();
    });

    describe('capabilityToolMap dynamic resolution', () => {
        it('resolves tools from capabilityToolMap when not in built-in registry', () => {
            const result = resolveCapabilityTools(['custom.capability'], {
                'custom.capability': ['myCustomTool', 'anotherTool'],
            });

            expect(result.tools).toEqual(['myCustomTool', 'anotherTool']);
            expect(result.unknownCapabilities).toHaveLength(0);
        });

        it('prefers built-in registry over capabilityToolMap', () => {
            const result = resolveCapabilityTools(['pr.diff.read'], {
                'pr.diff.read': ['overrideTool'],
            });

            expect(result.tools).toEqual(['KODUS_GET_PULL_REQUEST_DIFF']);
            expect(result.unknownCapabilities).toHaveLength(0);
        });

        it('reports unknown when capability is not in registry or capabilityToolMap', () => {
            const result = resolveCapabilityTools(['unknown.capability'], {
                'other.capability': ['tool'],
            });

            expect(result.tools).toHaveLength(0);
            expect(result.unknownCapabilities).toEqual(['unknown.capability']);
        });

        it('resolveCapabilityToolSelection uses capabilityToolMap for dynamic capabilities', () => {
            const result = resolveCapabilityToolSelection({
                capabilities: ['custom.read'],
                capabilityToolMap: { 'custom.read': ['getCustomData'] },
                registeredTools: ['getCustomData'],
                toolMode: 'any',
            });

            expect(result.toolByCapability['custom.read']).toBe(
                'getCustomData',
            );
            expect(result.missingCapabilities).toHaveLength(0);
            expect(result.hasRequiredTools).toBe(true);
        });

        it('marks dynamic capability as missing when tool is not registered', () => {
            const result = resolveCapabilityToolSelection({
                capabilities: ['custom.read'],
                capabilityToolMap: { 'custom.read': ['getCustomData'] },
                registeredTools: [],
                toolMode: 'all',
            });

            expect(result.toolByCapability['custom.read']).toBeUndefined();
            expect(result.missingCapabilities).toEqual(['custom.read']);
            expect(result.hasRequiredTools).toBe(false);
        });

        it('supports provider_dynamic capabilities via capabilityDefinitions', () => {
            const result = resolveCapabilityTools(
                ['task.custom.read'],
                undefined,
                {
                    'task.custom.read': {
                        mode: 'provider_dynamic',
                    },
                },
            );

            expect(result.tools).toEqual([]);
            expect(result.unknownCapabilities).toEqual([]);
        });

        it('supports fixed_tools capabilities via capabilityDefinitions', () => {
            const result = resolveCapabilityToolSelection({
                capabilities: ['task.custom.read'],
                capabilityDefinitions: {
                    'task.custom.read': {
                        mode: 'fixed_tools',
                        tools: ['getCustomTask'],
                    },
                },
                registeredTools: ['getCustomTask'],
                toolMode: 'all',
            });

            expect(result.toolByCapability['task.custom.read']).toBe(
                'getCustomTask',
            );
            expect(result.missingCapabilities).toEqual([]);
            expect(result.hasRequiredTools).toBe(true);
        });
    });
});
