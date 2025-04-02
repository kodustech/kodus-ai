import OpenAI from 'openai';
import { ThreadCreateAndRunParams } from 'openai/resources/beta/threads/threads';
import { sleep } from '../helpers';

const openai = new OpenAI({
    apiKey: process.env.API_OPEN_AI_API_KEY,
});

const openAIUploadFile = async (fileStream) => {
    try {
        const file = await openai.files.create({
            file: fileStream,
            purpose: 'assistants',
        });

        return file;
    } catch (error) {
        console.log(error);
    }
};

const openAIListFiles = async (purpose = 'assistants') => {
    try {
        const list = await openai.files.list({
            purpose,
        });

        return list;
    } catch (error) {
        console.log(error);
    }
};

const openAIRetrieveFile = async (file_id: string) => {
    try {
        const file = await openai.files.retrieve(file_id);

        return file;
    } catch (error) {
        console.log(error);
    }
};

const openAIRetrieveFileContent = async (file_id: string) => {
    try {
        const file = await openai.files.content(file_id);

        return file;
    } catch (error) {
        console.log(error);
    }
};

const openAIDeleteFile = async (file_id: string) => {
    try {
        await openai.files.del(file_id);
    } catch (error) {
        console.log(error);
    }
};

const waitForRun = async (runId, threadId) => {
    let inProgress = true;
    let run: any = {};

    await sleep(4000);

    while (inProgress) {
        run = await openai.beta.threads.runs.retrieve(threadId, runId);

        inProgress = ['in_progress', 'queued'].includes(run.status);

        if (inProgress) {
            await sleep(2000);
        }
    }

    return run;
};

const getResponseRunThread = async (runId, threadId) => {
    const run = await waitForRun(runId, threadId);

    if (run.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(threadId, {
            order: 'desc',
        });

        const newMessages = messages.data.filter((msg) => msg.run_id === runId);

        return newMessages;
    } else if (run.status === 'requires_action') {
        const actions = [];

        run.required_action?.submit_tool_outputs.tool_calls.forEach((item) => {
            const functionCall = item.function;
            const args = JSON.parse(functionCall.arguments);
            actions.push({
                tool: functionCall.name,
                toolInput: args,
                toolCallId: item.id,
                log: '',
                runId,
                threadId,
            });
        });

        return actions;
    }

    const runInfo = JSON.stringify(run, null, 2);

    throw new Error(
        `Unexpected run status ${run.status}.\nFull run info:\n\n${runInfo}`,
    );
};

const createThreadAndRun = (assistantId, content, fileIds) => {
    const thread = {
        messages: [
            {
                role: 'user',
                content,
            },
        ],
        tool_resources: {
            code_interpreter: {
                file_ids: fileIds,
            },
        },
    } as ThreadCreateAndRunParams.Thread;

    const run = openai.beta.threads.createAndRun({
        thread: thread,
        assistant_id: assistantId,
    });

    return run;
};

export {
    openAIUploadFile,
    openAIListFiles,
    openAIRetrieveFile,
    openAIRetrieveFileContent,
    openAIDeleteFile,
    createThreadAndRun,
    getResponseRunThread,
};
