export const getTypeNames = (bugTypeIdentifiers) => {
    const bugTypes = bugTypeIdentifiers?.configValue as {
        id: string;
        name: string;
    }[];

    return bugTypes?.map((type) => type?.name);
};
