import { PhysicalAdmissionRequestSchema, PhysicalAdmissionTicketSchema } from './admission.schema';

const UUID = 'a4fcf307-047e-4634-a607-604523f5c99c';
const identity = { organizationId: 'org', kind: 'run', key: 'run', generation: 0, ticketOwnerToken: UUID };
const request = { ...identity, executionId: 'execute', deadlineAt: '2030-01-01T00:00:00.000Z', members: [{ side: 'base', idempotencyKey: 'run:base:1' }] };
const ticket = { ...identity, ticketId: UUID, cellId: 'cell', sessionEpoch: UUID, expiresAt: request.deadlineAt, members: [{ ...request.members[0], claimId: 'claim' }] };

describe('physical admission HTTP generation contract', () => {
    // The store and PostgreSQL start at generation zero. Rejecting it at HTTP
    // left the first reservation debited without a usable ticket.
    it('accepts the initial persisted generation on request and ticket', () => {
        expect(PhysicalAdmissionRequestSchema.safeParse(request).success).toBe(true);
        expect(PhysicalAdmissionTicketSchema.safeParse(ticket).success).toBe(true);
    });
    it('retains strict identity and malformed generation rejection', () => {
        for (const generation of [-1, 0.5, '0', NaN, Infinity]) {
            expect(PhysicalAdmissionRequestSchema.safeParse({ ...request, generation }).success).toBe(false);
            expect(PhysicalAdmissionTicketSchema.safeParse({ ...ticket, generation }).success).toBe(false);
        }
        expect(PhysicalAdmissionRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
        expect(PhysicalAdmissionTicketSchema.safeParse({ ...ticket, ticketOwnerToken: '' }).success).toBe(false);
    });
});
