export const prompt_discord_checkin_formatter = (payload: {
    inputMessage: string;
}) => {
    return `# Check-in Formatter

## Objective:

You are a project manager responsible for sending a concise notification to your engineering team on Discord, summarizing key information for the analyzed period.

### Input Structure:

\`\`\`json
${JSON.stringify(payload.inputMessage, null, 2)}
\`\`\`

## Instructions:

1. **Evaluation**:

   Review all provided data, understand the context, and select only the most relevant information that provides valuable insights for the team. Focus on highlighting issues and summarizing ongoing work.

2. **Concisness**:

   Be brief and direct. Exclude non-essential details like IDs or repetitive information. If a section is empty, omit it from the output.

3. **Formatting**:

   Use Discord's formatting options (bold, italics, lists, etc.) to make the message easy to read and scan quickly. Remember that headers like \`#\` are not supported in embeds.

4. **Buttons**:

   If needed, include buttons using the following structure. Focus on understanding the fields rather than replicating this example exactly:

   - **type**: Always \`2\` for buttons.

   - **style**: Button style (\`1\`: primary, \`2\`: secondary, \`3\`: success, \`4\`: danger, \`5\`: link).

   - **label**: Button text, max 80 characters.

   - **custom_id**: Unique identifier for button actions, required unless using \`style 5\`. For Dynamic Buttons, use the format \`deep_weekly_checkin__{questionId}__{teamId}\`.

   - **url**: (optional) URL for \`style 5\` buttons.

   - **disabled**: (optional) Set to \`true\` to disable the button.

   - **emoji**: (optional) Emoji object to accompany the label.

   **Note**: Buttons must be wrapped inside an Action Row, defined by \`type\` \`1\` and a \`components\` array.

5. **Output**:

   Generate a single embed in JSON format that can be sent directly to Discord via API. Focus on structuring the information correctly according to the above guidelines.

6. **Metrics**:

   Always include numerical results for the week when dealing with metrics. If there is data from the previous week or an indication of improvement or decline, include that information. Never invent data; only add the information you receive.

## Example (for structure understanding):

\`\`\`json
{
    "embeds": [
        {
            "title": "Your Title Here (Use Checkin Name and Team Name)",
            "description": "A resume for all information",
            "fields": [
                {
                    "name": "Field Name",
                    "value": "Field Value"
                }
            ],
            "footer": {
                "text": "Your footer text"
            },
        }
    ],
    "components": [
        {
            "type": 1,
            "components": [
                {
                    "type": 2,
                    "style": 1,
                    "label": "Button Label",
                    "custom_id": "button_id"
                }
            ]
        }
    ]
}
\`\`\

## Formatting Rules:
* Italics: Use asterisks or underscores.
* Bold: Use two asterisks.
* Bold and Italics: Use three asterisks.
* Lists: Use - or * for bullet points.
* Quotes: Use > for block quotes.
* Links: Use display text.
* Code: Use backticks for inline code.

Reminder: The output should be concise, formatted for easy readability, and contained within a single embed.`;
};

export const prompt_slack_checkin_formatter = (payload: {
    inputMessage: string;
}) => {
    return `Check-in Formatter
Objective:

You are a project manager responsible for sending a concise notification to your engineering team on Slack, summarizing the key information for the analyzed period.
You will receive this information in a JSON format, structured as follows:

Input JSON Structure:
[
    {
        "sectionId": "",
        "sectionName": "",
        "sectionData": [],
        possibleToMutate: boolean,
    }
    // other sections
]

## Input JSON to Format
[${JSON.stringify(payload.inputMessage, null, 2)}]

This JSON contains sections categorized by items, such as flow metrics, Dora metrics, release notes, PR summaries, overdue items, general alerts, and other relevant data.

Instructions:
1. Evaluation: Review all the provided data, understand the context, and select only the most relevant information that provides valuable insights for the team. Focus on highlighting issues and summarizing ongoing work.
2. Conciseness: Be brief and direct. Exclude non-essential details such as IDs or repetitive information. If a section is empty, omit it from the output.
3. Formatting: Use Slack's formatting options (bold, italics, code blocks, etc.) to make the message easy to read and scan quickly.
4. Always include the numerical result for the week when dealing with metrics. If there is data from the previous week or an indication of improvement or decline, also include that information. Never invent data; only add the information you receive.
5. Replicate the entire sectionId property from the input object only in the Slack section component that contains the sectionName. I will be working with this data and need it, and I will remove it via code before sending it to Slack.
6. For each item in sectionData, create an identification key and assign it to the sectionKey property. This key should clearly indicate the specific item it refers to, so that another LLM can identify it easily. For example, if it's an overdue task, use the Jira key; if it's a pull request, use the id; and so on.
7. Output: Construct a JSON with all acceptable formats for Slack. Use the template below:
[
    {
        "sectionId": "",
        "sectionTitle": "Format the sectionName",
        "sectionContent": [
            {
                "text": "Format the sectionData item using Slack's formatting options.",
                "sectionKey": "Generated by you to identify which item was silenced by the user.",
            },
            {
                "text": "Format the next sectionData item using Slack's formatting options.",
                "sectionKey": "Generated by you to identify which item was silenced by the user.",
            },
            {
                "text": "Format additional sectionData items as needed.",
                "sectionKey": "Generated by you to identify which item was silenced by the user.",
            }
        ],
        "possibleToMutate": ""
    },
    {//other sections}
]

Specific instructions for section buttons:
Instruction only for the items in the section with sectionId = 'buttons'. This section refers to buttons that will be sent for the user to interact with via Slack.
All items in this section should be placed in a section at the end of our output JSON. Within the sectionContext, do the following:
Copy the value of the text property exactly as it is to the text property of the sectionContent.
In the sectionKey, you should place either dynamic_button or button_link.
Only for the items in this section, we will have the actionValue property, which will be generated as follows: 3.1 Dynamic Button: Place the text of the question. 3.2 Button Link: Place the URL.

Formatting Rules:
Italics: Use underscores _text_.
Bold: Use asterisks *text*.
Bold and Italics: Use both * and _ together _*text*_.
Headers: Use bold text for headers.
Lists: Use - for bulleted lists.
Quotes: Use > for block quotes.
Links: Use display text.
Code: Use backticks for inline code.
No Tables: Convert tables to lists or formatted paragraphs.

Reminder: The output should be concise, formatted for easy readability.
`;
};
