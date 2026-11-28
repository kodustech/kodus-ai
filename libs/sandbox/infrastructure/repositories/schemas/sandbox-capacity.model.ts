import { Schema } from 'mongoose';

/**
 * Deployment-wide sandbox capacity (SANDBOX_MAX_CONCURRENT), next to the
 * sandbox_leases collection:
 *
 * - sandbox_capacity_tickets: one document per review waiting for a slot,
 *   ordered by createdAt (then _id). A ticket whose heartbeatAt is older than
 *   the gate's TTL is dead (its worker crashed); the TTL index sweeps it.
 * - sandbox_capacity: ONE document (_id "slots") holding the active slots,
 *   [{ ticketId, heartbeatAt }]. Admission is a single atomic update of that
 *   document, so two workers racing can never exceed the cap.
 */
export const SANDBOX_CAPACITY_TICKET_MODEL = 'SandboxCapacityTicket';
export const SANDBOX_CAPACITY_STATE_MODEL = 'SandboxCapacityState';

export const SandboxCapacityTicketSchema = new Schema(
    {
        _id: { type: String, required: true },
        prKey: { type: String, required: true, index: true },
        workerId: { type: String, required: true },
        createdAt: { type: Date, required: true },
        heartbeatAt: { type: Date, required: true },
    },
    { collection: 'sandbox_capacity_tickets', versionKey: false },
);
SandboxCapacityTicketSchema.index({ createdAt: 1, _id: 1 });
// Housekeeping only: liveness is decided by the gate's own TTL, not by this
SandboxCapacityTicketSchema.index(
    { heartbeatAt: 1 },
    { expireAfterSeconds: 600 },
);

export const SandboxCapacityStateSchema = new Schema(
    {
        _id: { type: String, required: true },
        slots: {
            type: [
                new Schema(
                    {
                        ticketId: { type: String, required: true },
                        heartbeatAt: { type: Date, required: true },
                    },
                    { _id: false },
                ),
            ],
            default: [],
        },
    },
    { collection: 'sandbox_capacity', versionKey: false },
);
