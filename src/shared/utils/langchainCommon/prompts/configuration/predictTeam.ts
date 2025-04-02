export const prompt_correlateTeamMembers = (payload: any) => {
    return `
        You will receive two arrays of users, one from a communication tool and another from a project management tool.

        Compare the two arrays to find possible matches, where a user might be the same person in both tools.
        Use the provided data, such as name, email, or any other unique identifier to make the comparison.

        Return only the matches found in the following json format:

{members: [{communication: {id: XX}, projectManagement: {id: YY}, codeManagement: {id: ZZ}]}

If no matches are found, return an empty array.

The two arrays of users are provided below:

Communication tool array:
[
  { "id": "C1", "name": "Alice"},
  { "id": "C2", "name": "Bob"},
  ...
]

Project management tool array:
[
  { "id": "P1", "name": "Alice", "email": "alice@example.com" },
  { "id": "P2", "name": "Charlie", "email": "charlie@example.com" },
  ...
]

Code management tool array:
[
  { "id": "P1", "name": "Alice"},
  { "id": "P2", "name": "Charlie"},
  ...
]


Identify and return the matches.


Input:
${JSON.stringify(payload.members)}`;
};
