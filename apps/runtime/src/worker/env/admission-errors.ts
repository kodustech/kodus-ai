/** Raised outside an acquire checkpoint: admission capacity was lost, not an app defect. */
export class AdmissionCapacityLostError extends Error {
    readonly code = 'admission_capacity_lost';
    constructor() {
        super('Reserved capacity is no longer available; run setup again.');
        this.name = 'AdmissionCapacityLostError';
    }
}
