import { authorizedFetch } from "@services/fetch";

import { getOrganizationMembers } from "./fetch";

jest.mock("@services/fetch", () => ({ authorizedFetch: jest.fn() }));
jest.mock("@services/organizations/fetch", () => ({
    getOrganizationId: jest.fn(),
}));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => path,
}));
jest.mock("src/core/utils/self-hosted", () => ({ isSelfHosted: false }));
jest.mock("./utils", () => ({
    billingFetch: jest.fn(),
    billingRequest: jest.fn(),
}));

const fetchMock = authorizedFetch as jest.Mock;
const members = [{ id: 1, name: "Alice" }];

describe("getOrganizationMembers", () => {
    it("keeps complete from the API", async () => {
        fetchMock.mockResolvedValue({ status: "ok", complete: true, members });

        await expect(getOrganizationMembers({ teamId: "t" })).resolves.toEqual({
            status: "ok",
            complete: true,
            members,
        });
    });

    it("keeps the seat holders the API confirmed absent", async () => {
        fetchMock.mockResolvedValue({
            status: "ok",
            complete: true,
            members,
            absentSeatHolderIds: ["77"],
        });

        await expect(getOrganizationMembers({ teamId: "t" })).resolves.toEqual({
            status: "ok",
            complete: true,
            members,
            absentSeatHolderIds: ["77"],
        });
    });

    it("reads a response without complete as incomplete", async () => {
        fetchMock.mockResolvedValue({ status: "ok", members });

        await expect(getOrganizationMembers({ teamId: "t" })).resolves.toEqual({
            status: "ok",
            complete: false,
            members,
        });
    });

    it("reads the legacy array shape as incomplete", async () => {
        fetchMock.mockResolvedValue(members);

        await expect(getOrganizationMembers({ teamId: "t" })).resolves.toEqual({
            status: "ok",
            complete: false,
            members,
        });
    });
});
