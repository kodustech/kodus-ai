import { PlatformType } from "@/shared/domain/enums/platform-type.enum";

export type Channel = {
    id: string;
    name: string;
    selected: boolean;
    isPrivate?: boolean;
    type?: PlatformType;
};
