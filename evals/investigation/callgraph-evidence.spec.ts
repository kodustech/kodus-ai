const {
    auditCallGraphEvidence,
    auditCallGraphCases,
    evaluateCallGraphExpectations,
} = require('./callgraph-evidence');

describe('call graph evidence audit', () => {
    const graph = `
<CallGraph>
  <ChangedFunction name="saveBooking" file="src/booking/service.ts" lines="10-30" tested="false" status="modified">
    <Callers count="2" untestedCount="1">
      <Caller name="saveBooking" file="src/booking/service.spec.ts" line="40" confidence="0.85" tier="same-file" />
      <Caller name="createBooking" file="src/booking/controller.ts" line="80" confidence="0.70" tier="import" />
    </Callers>
    <Callees count="1">
      <Callee name="bookingClient.create" file="src/booking/client.ts" signature="create -&gt; Booking" confidence="0.70" tier="import" />
    </Callees>
  </ChangedFunction>
</CallGraph>`;

    it('preserves direct evidence and reports test callers that displace production callers', () => {
        expect(auditCallGraphEvidence(graph)).toEqual({
            available: true,
            changedFunctions: [
                {
                    name: 'saveBooking',
                    file: 'src/booking/service.ts',
                    callers: [
                        {
                            name: 'saveBooking',
                            file: 'src/booking/service.spec.ts',
                            line: 40,
                            confidence: 0.85,
                            isTest: true,
                        },
                        {
                            name: 'createBooking',
                            file: 'src/booking/controller.ts',
                            line: 80,
                            confidence: 0.7,
                            isTest: false,
                        },
                    ],
                    callees: [
                        {
                            name: 'bookingClient.create',
                            file: 'src/booking/client.ts',
                            confidence: 0.7,
                        },
                    ],
                },
            ],
            orderingViolations: [
                {
                    changedFunction: {
                        name: 'saveBooking',
                        file: 'src/booking/service.ts',
                    },
                    firstTestCaller: {
                        name: 'saveBooking',
                        file: 'src/booking/service.spec.ts',
                    },
                    firstProductionCaller: {
                        name: 'createBooking',
                        file: 'src/booking/controller.ts',
                    },
                },
            ],
        });
    });

    it('reports a production caller that follows an interleaved test caller', () => {
        const interleavedGraph = `
<CallGraph>
  <ChangedFunction name="saveBooking" file="src/booking/service.ts">
    <Callers count="3">
      <Caller name="firstProduction" file="src/booking/controller.ts" />
      <Caller name="saveBooking" file="src/booking/service.spec.ts" />
      <Caller name="laterProduction" file="src/booking/fallback.ts" />
    </Callers>
  </ChangedFunction>
</CallGraph>`;

        expect(
            auditCallGraphEvidence(interleavedGraph).orderingViolations,
        ).toEqual([
            {
                changedFunction: {
                    name: 'saveBooking',
                    file: 'src/booking/service.ts',
                },
                firstTestCaller: {
                    name: 'saveBooking',
                    file: 'src/booking/service.spec.ts',
                },
                firstProductionCaller: {
                    name: 'laterProduction',
                    file: 'src/booking/fallback.ts',
                },
            },
        ]);
    });

    it('measures exact required direct dependencies from a private expectation manifest', () => {
        expect(
            evaluateCallGraphExpectations(
                graph,
                {
                    version: 1,
                    cases: {
                        'booking-client-miss': {
                            required: [
                                {
                                    source: {
                                        name: 'saveBooking',
                                        file: 'src/booking/service.ts',
                                    },
                                    relation: 'callee',
                                    target: {
                                        name: 'bookingClient.create',
                                        file: 'src/booking/client.ts',
                                    },
                                },
                            ],
                        },
                    },
                },
                'booking-client-miss',
            ),
        ).toEqual({
            available: true,
            required: 1,
            matched: 1,
            missing: [],
            orderingViolations: [
                expect.objectContaining({
                    changedFunction: {
                        name: 'saveBooking',
                        file: 'src/booking/service.ts',
                    },
                }),
            ],
        });
    });

    it('reports missing direct evidence without treating it as a passing treatment', () => {
        const result = evaluateCallGraphExpectations(
            graph,
            {
                version: 1,
                cases: {
                    'booking-config-miss': {
                        required: [
                            {
                                source: {
                                    name: 'saveBooking',
                                    file: 'src/booking/service.ts',
                                },
                                relation: 'callee',
                                target: {
                                    name: 'getBookingTimeout',
                                    file: 'src/config/booking.ts',
                                },
                            },
                        ],
                    },
                },
            },
            'booking-config-miss',
        );

        expect(result.matched).toBe(0);
        expect(result.missing).toEqual([
            expect.objectContaining({
                relation: 'callee',
                target: {
                    name: 'getBookingTimeout',
                    file: 'src/config/booking.ts',
                },
            }),
        ]);
    });

    it('rejects malformed manifests before a model run', () => {
        expect(() =>
            evaluateCallGraphExpectations(
                graph,
                { version: 1, cases: [] },
                'case-a',
            ),
        ).toThrow('call graph expectation manifest cases must be an object');
    });

    it('summarizes captured coverage for selected cases before the agent runs', () => {
        expect(
            auditCallGraphCases(
                [
                    {
                        vars: {
                            caseId: 'booking-client-miss',
                            callGraph: graph,
                        },
                    },
                    {
                        vars: {
                            caseId: 'booking-config-miss',
                        },
                    },
                ],
                {
                    version: 1,
                    cases: {
                        'booking-client-miss': {
                            required: [
                                {
                                    source: {
                                        name: 'saveBooking',
                                        file: 'src/booking/service.ts',
                                    },
                                    relation: 'callee',
                                    target: {
                                        name: 'bookingClient.create',
                                        file: 'src/booking/client.ts',
                                    },
                                },
                            ],
                        },
                        'booking-config-miss': {
                            required: [
                                {
                                    source: {
                                        name: 'saveBooking',
                                        file: 'src/booking/service.ts',
                                    },
                                    relation: 'callee',
                                    target: {
                                        name: 'getBookingTimeout',
                                        file: 'src/config/booking.ts',
                                    },
                                },
                            ],
                        },
                    },
                },
            ),
        ).toEqual({
            cases: 2,
            availableCases: 1,
            unavailableCases: 1,
            required: 2,
            matched: 1,
            missing: 1,
            orderingViolations: 1,
            rows: [
                expect.objectContaining({
                    caseId: 'booking-client-miss',
                    available: true,
                    required: 1,
                    matched: 1,
                }),
                expect.objectContaining({
                    caseId: 'booking-config-miss',
                    available: false,
                    required: 1,
                    matched: 0,
                }),
            ],
        });
    });
});
