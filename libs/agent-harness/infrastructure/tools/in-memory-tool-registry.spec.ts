import type { AgentTool } from '../../domain/contracts/tool.contract';
import { InMemoryToolRegistry } from './in-memory-tool-registry';

const mk = (name: string): AgentTool => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: name }),
});

describe('InMemoryToolRegistry', () => {
    const reg = new InMemoryToolRegistry([mk('grep'), mk('readFile'), mk('getCallers')]);

    it('gets by name and lists all', () => {
        expect(reg.get('grep')?.name).toBe('grep');
        expect(reg.get('nope')).toBeUndefined();
        expect(reg.list().map((t) => t.name).sort()).toEqual([
            'getCallers',
            'grep',
            'readFile',
        ]);
    });
});
