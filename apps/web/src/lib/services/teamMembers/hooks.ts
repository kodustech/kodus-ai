import { useMutation } from "@tanstack/react-query";

import { deleteTeamMember } from "./fetch";

export function useDeleteTeamMember() {
    return useMutation({
        mutationFn: deleteTeamMember,
    });
}
