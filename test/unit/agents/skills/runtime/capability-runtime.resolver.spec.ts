import { createCapabilityToolRuntime } from '@libs/agents/skills/runtime/capability-runtime.resolver';

describe('capability-runtime.resolver', () => {
    it('resolves concrete tool names from capabilities + policy', () => {
        const runtime = createCapabilityToolRuntime({
            config: {
                capabilities: ['pr.metadata.read', 'pr.diff.read'],
                allowedTools: [
                    'KODUS_GET_PULL_REQUEST',
                    'KODUS_GET_PULL_REQUEST_DIFF',
                ],
                fetcherPolicy: {
                    toolMode: 'all',
                    allowWithoutTools: false,
                },
            },
            registeredTools: [
                'KODUS_GET_PULL_REQUEST',
                'KODUS_GET_PULL_REQUEST_DIFF',
            ],
        });

        expect(runtime.getToolName('pr.metadata.read')).toBe(
            'KODUS_GET_PULL_REQUEST',
        );
        expect(runtime.getToolName('pr.diff.read')).toBe(
            'KODUS_GET_PULL_REQUEST_DIFF',
        );
        expect(runtime.missingCapabilities).toEqual([]);
        expect(runtime.hasRequiredTools).toBe(true);
    });

    it('marks missing capabilities when required tools are unavailable', () => {
        const runtime = createCapabilityToolRuntime({
            config: {
                capabilities: ['pr.metadata.read', 'pr.diff.read'],
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
                fetcherPolicy: {
                    toolMode: 'all',
                    allowWithoutTools: false,
                },
            },
            registeredTools: ['KODUS_GET_PULL_REQUEST'],
        });

        expect(runtime.getToolName('pr.metadata.read')).toBe(
            'KODUS_GET_PULL_REQUEST',
        );
        expect(runtime.getToolName('pr.diff.read')).toBeUndefined();
        expect(runtime.missingCapabilities).toEqual(['pr.diff.read']);
        expect(runtime.hasRequiredTools).toBe(false);
    });

    it('supports dynamic fixed capability mapping from skill metadata', () => {
        const runtime = createCapabilityToolRuntime({
            config: {
                capabilities: ['task.external.read'],
                capabilityToolMap: {
                    'task.external.read': ['getExternalTask'],
                },
                allowedTools: ['getExternalTask'],
                fetcherPolicy: {
                    toolMode: 'all',
                    allowWithoutTools: false,
                },
            },
            registeredTools: ['getExternalTask'],
        });

        expect(runtime.getToolName('task.external.read')).toBe(
            'getExternalTask',
        );
        expect(runtime.unknownCapabilities).toEqual([]);
        expect(runtime.hasRequiredTools).toBe(true);
    });
});
