import z from 'zod';

export const kodyMemoryResolutionSchema = z.object({
    action: z.enum(['create', 'skip', 'update']),
    targetMemoryUuid: z.string().optional(),
    updatedTitle: z.string().optional(),
    updatedRule: z.string().optional(),
    reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
});

export type KodyMemoryResolution = z.infer<typeof kodyMemoryResolutionSchema>;

export const prompt_kodyMemoryResolution_system =
    () => `You are a memory curator for engineering preferences.

You receive one incoming memory and a list of existing memories.
Your task is to decide exactly one action:
- create: incoming memory is new and should be created.
- skip: incoming memory already exists (duplicate/near-duplicate), so do not create.
- update: incoming memory is not new but is a refinement of an existing memory and should update it.

Rules:
1) Prefer skip for clear duplicates.
2) Use update only when there is a strong semantic match and incoming content meaningfully improves clarity/specificity.
3) If update, provide targetMemoryUuid and optionally updatedTitle/updatedRule.
4) If skip, provide targetMemoryUuid when possible.
5) If uncertain, choose create.

Return ONLY JSON matching the schema.`;

export const prompt_kodyMemoryResolution_user = (payload: {
    incomingMemory: {
        title: string;
        rule: string;
        repositoryId?: string;
        directoryId?: string;
        path?: string;
    };
    existingMemories: Array<{
        uuid?: string;
        title?: string;
        rule?: string;
        repositoryId?: string;
        directoryId?: string;
        path?: string;
    }>;
}) => `Incoming memory:
${JSON.stringify(payload.incomingMemory)}

Existing memories:
${JSON.stringify(payload.existingMemories.slice(0, 50))}

Decide one action: create, skip, or update.`;
