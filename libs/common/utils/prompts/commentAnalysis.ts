import { z } from 'zod';

import {
    categorizedCommentSchema,
    UncategorizedComment,
} from '@libs/code-review/domain/types/commentAnalysis.type';

export const commentCategorizerSchema = z.object({
    suggestions: z.array(categorizedCommentSchema.omit({ body: true })),
});

export type CommentCategorizerSchema = z.infer<typeof commentCategorizerSchema>;

export const prompt_CommentCategorizerSystem = () => `
You are a code review suggestion categorization expert, when given a list of suggestions from a code review you are able to determine which category they belong to and the severity of the suggestion.

All suggestions fall into one of the following categories:
- 'security': Address vulnerabilities and security concerns
- 'error_handling': Error/exception handling improvements
- 'refactoring': Code restructuring for better readability/maintenance
- 'performance_and_optimization': Speed/efficiency improvements
- 'maintainability': Future maintenance improvements
- 'potential_issues': Potential bugs/logical errors
- 'code_style': Coding standards adherence
- 'documentation_and_comments': Documentation improvements

All suggestions have one of the following levels of severity:
- low
- medium
- high
- critical

You will receive a list of suggestions with the following format:
[
    {
        id: string, unique identifier
        body: string, the content of the suggestion
    }
]

You must then analyze the input and categorize it according to the previous categories and severity levels.

Once you've analyzed all the suggestions you must output a json with the following structure:
{
    "suggestions": [
        {
            "id": string, unique identifier of the suggestion
            "category": string, one of the previously informed categories
            "severity": string, one of the previously informed severity levels
        }
    ]
}

Your output must only be a json, you should not output any other text other than the list.
Your output must be surrounded by \`\`\`json\`\`\` tags.
`;

export const prompt_CommentCategorizerUser = (payload: {
    comments: UncategorizedComment[];
}) => `
[
${payload.comments
    .map(
        (comment) => `
    {
        id: "${comment.id}",
        body: "${comment.body}"
    },
`,
    )
    .join('')}
]`;

export const commentIrrelevanceFilterSchema = z.object({
    ids: z.array(z.string()),
});

export const prompt_CommentIrrelevanceFilterSystem = () => `
You are a code review suggestion relevance expert, when given a list of suggestions from a code review you are able to determine which suggestions are irrelevant and should
be filtered out.

You will receive a list of suggestions with the following format:
[
    {
        id: string, unique identifier
        body: string, the content of the suggestion
    }
]

You must then analyze the input and filter out all irrelevant suggestions.
Irrelevant suggestions are those that do not provide any value to the code review process, they are suggestions that are not actionable, do not provide any useful information or are not related to the code being reviewed.
For example, simple questions, greetings, thank you messages, etc. Bot or template messages should also be filtered out.

Once you've analyzed all the suggestions you must output a list with the ids of all the suggestions that passed the filter, it must be a json with the following structure:

{
    "ids": [
        "id1",
        "id2",
        "id3"
    ]
}

Your output must only be a json, you should not output any other text other than the list.
Your output must be surrounded by \`\`\`json\`\`\` tags.
`;

export const prompt_CommentIrrelevanceFilterUser = (payload: {
    comments: UncategorizedComment[];
}) => `
[
${payload.comments
    .map(
        (comment) => `
    {
        id: "${comment.id}",
        body: "${comment.body}"
    },
`,
    )
    .join('')}
]`;
