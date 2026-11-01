import { buildAgentTools } from './agent-tools.factory';

/**
 * `getCallers` reads the call graph the stage passes through unchanged: the
 * XML that `kodus-graph context --format xml` writes (#2203).
 */
describe('agent tools — getCallers on the XML call graph', () => {
    const callGraph = [
        '<CallGraph>',
        '  <Summary changedFunctions="2" untestedFunctions="1" impactedCallers="1" riskLevel="low" riskScore="0.2" />',
        '',
        '  <ChangedFunction name="LedgerService.postEntry" file="src/ledger/post-entry.ts" lines="1-4" tested="false" status="modified">',
        '    <WhatChanged>params changed</WhatChanged>',
        '    <Callers count="1" untestedCount="1">',
        '      <Caller name="closeMonth" file="src/billing/close-month.ts" line="12" confidence="0.95" tier="receiver" />',
        '    </Callers>',
        '  </ChangedFunction>',
        '',
        '  <ChangedFunction name="invoice" file="src/billing/invoice.ts" lines="1-2" tested="true" status="new">',
        '    <WhatChanged>new function</WhatChanged>',
        '  </ChangedFunction>',
        '</CallGraph>',
    ].join('\n');

    const getCallers = () =>
        buildAgentTools(
            {} as any,
            undefined,
            undefined,
            undefined,
            undefined,
            callGraph,
        ).getCallers;

    it('returns the entry of a changed function, with its callers', async () => {
        const out = await getCallers().execute({ functionName: 'postEntry' });

        expect(out).toContain('name="LedgerService.postEntry"');
        expect(out).toContain(
            '<Caller name="closeMonth" file="src/billing/close-month.ts"',
        );
        expect(out).not.toContain('invoice');
    });

    it('lists the changed functions when the name is not in the graph', async () => {
        const out = await getCallers().execute({ functionName: 'missing' });

        expect(out).toBe(
            'No call-graph entry for "missing". Changed functions in the graph: LedgerService.postEntry, invoice',
        );
    });
});
