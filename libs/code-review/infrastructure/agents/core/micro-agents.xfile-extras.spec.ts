import {
    CROSS_FILE_AGENT_ID,
    semCrossFile,
    xfileExtraLabel,
} from './micro-agents';

describe('cross-file experiment arms', () => {
    it('labels each extra arm under the cross-file prefix', () => {
        expect(xfileExtraLabel('xfile-grafo')).toBe(
            `micro-${CROSS_FILE_AGENT_ID}-grafo`,
        );
        expect(xfileExtraLabel('xfile-b')).toBe(`micro-${CROSS_FILE_AGENT_ID}-b`);
    });

    it('keeps the cross-file agent and its extra arms out of what the simulation sees', () => {
        const todos = [
            { producedBy: 'micro-says-one-thing-does-another' },
            { producedBy: `micro-${CROSS_FILE_AGENT_ID}` },
            { producedBy: xfileExtraLabel('xfile-grafo') },
            { producedBy: xfileExtraLabel('xfile-b') },
            { producedBy: 'micro-invalid-state-and-concurrency' },
            {},
        ];

        expect(semCrossFile(todos)).toEqual([
            { producedBy: 'micro-says-one-thing-does-another' },
            { producedBy: 'micro-invalid-state-and-concurrency' },
            {},
        ]);
    });
});
