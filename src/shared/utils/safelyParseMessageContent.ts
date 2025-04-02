export const safelyParseMessageContent = (messageContent) => {
    try {
        // Then, parse this string back into a JavaScript object
        return JSON.parse(messageContent);
    } catch (e) {
        console.error('Error handling MessageContent:', e);
        return null;
    }
};
