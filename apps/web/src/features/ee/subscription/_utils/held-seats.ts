import type { UserWithLicense } from "../_services/billing/fetch";

/**
 * The seats a license is spending right now. Self-hosted's `/license/users`
 * also lists seats that were released (`status: "inactive"`), so counting it
 * whole kept "1 of 1 seats in use" after the seat was freed and refused the
 * next assignment. Cloud's list carries held seats only; this is a no-op there.
 */
export const heldSeats = (users: UserWithLicense[]): UserWithLicense[] =>
    users.filter((user) => user.status !== "inactive");
