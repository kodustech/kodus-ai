import { z } from 'zod';
import { filePatternListSchema } from './file-pattern-schema';

const logins = z.array(z.string().trim().min(1).max(200)).max(50);

export const approvalPolicySchema = z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    labels: logins.optional(),
    /** Provider usernames, including bot logins. This describes the PR opener. */
    authors: logins.optional(),
    authorTeams: logins.optional(),
    includedFiles: filePatternListSchema.optional(),
    excludedFiles: filePatternListSchema.optional(),
    maxChangedLines: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    lineCountExcludedFiles: filePatternListSchema.optional(),
    instruction: z.string().trim().max(4000).optional(),
});

export type NamedApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const approvalPoliciesSchema = z
    .array(approvalPolicySchema)
    .max(50)
    .superRefine((policies, ctx) => {
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const [index, policy] of policies.entries()) {
            const name = policy.name.toLocaleLowerCase('en-US');
            if (ids.has(policy.id))
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: 'Policy IDs must be unique.',
                });
            if (names.has(name))
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'name'],
                    message: 'Choose a distinct policy name.',
                });
            ids.add(policy.id);
            names.add(name);
        }
    });
