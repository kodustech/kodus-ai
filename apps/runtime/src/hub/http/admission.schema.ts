import { z } from 'zod';
import { MachineSizeSchema } from '@libs/runtime/protocol';

const Id = z.string().min(1).max(256);
const identity = {
    organizationId: Id,
    kind: z.enum(['run', 'setup']),
    key: Id,
    // The durable store and database start at generation zero.
    generation: z.number().int().min(0),
    ticketOwnerToken: z.uuid(),
};
const member = { side: z.enum(['base', 'pr', 'setup']), idempotencyKey: Id };
export const PhysicalAdmissionRequestSchema = z.strictObject({
    ...identity,
    executionId: Id,
    deadlineAt: z.iso.datetime(),
    members: z.array(z.strictObject(member)).min(1).max(2),
    size: MachineSizeSchema.optional(),
});
export const PhysicalAdmissionTicketSchema = z.strictObject({
    ...identity,
    ticketId: z.uuid(),
    cellId: Id,
    sessionEpoch: z.uuid(),
    expiresAt: z.iso.datetime(),
    members: z
        .array(z.strictObject({ ...member, claimId: Id }))
        .min(1)
        .max(2),
});
