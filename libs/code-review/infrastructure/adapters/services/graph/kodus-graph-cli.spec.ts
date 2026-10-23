import { KODUS_GRAPH_VERSION } from './kodus-graph-cli';

describe('KODUS_GRAPH_VERSION', () => {
    it('pins the graph release that emits direct callee context', () => {
        expect(KODUS_GRAPH_VERSION).toBe('0.3.3');
    });
});
