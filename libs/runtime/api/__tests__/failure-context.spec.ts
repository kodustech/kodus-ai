import { BadGatewayException } from '@nestjs/common';

import { withFailureContext } from '../application/failure-context';

// The global jest setup mocks the logger module; this spec needs the real serializer.
const { boundErrorForLog } = jest.requireActual('@libs/core/log/logger') as typeof import('@libs/core/log/logger');

// boundErrorForLog is the serializer the API's exception filter applies to the
// exception it logs: what it keeps is what the one log line about a failure says.
describe('a failure carried to the API exception filter', () => {
    it("keeps the use case's ids and the cause's message and stack on the filter's line", () => {
        const cause = new Error('provider exploded');
        const line = boundErrorForLog(
            withFailureContext(new BadGatewayException({ code: 'llm_unavailable', message: 'The LLM provider call failed' }), { runId: 'run-1', organizationId: 'org-1', round: 2 }, cause),
        );
        expect(line).toMatchObject({ runId: 'run-1', organizationId: 'org-1', round: 2 });
        expect(String(line.message)).toContain('provider exploded');
        expect(String(line.stack)).toContain('provider exploded');
    });

    it("never puts the cause's own payload on the line, only its message and stack", () => {
        const cause = Object.assign(new Error('provider exploded'), { requestBodyValues: { prompt: 'the secret prompt' }, responseBody: 'the raw body' });
        const line = boundErrorForLog(withFailureContext(new BadGatewayException('The LLM provider call failed'), { runId: 'run-1' }, cause));
        expect(JSON.stringify(line)).not.toContain('the secret prompt');
        expect(JSON.stringify(line)).not.toContain('the raw body');
    });

    it('leaves out a field it was given as undefined, and returns the same exception', () => {
        const exception = new BadGatewayException('x');
        expect(withFailureContext(exception, { runId: undefined, organizationId: 'org-1' })).toBe(exception);
        expect(Object.keys(exception)).not.toContain('runId');
    });
});
