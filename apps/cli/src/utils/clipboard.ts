import clipboard from 'clipboardy';

export async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
        await clipboard.write(text);
        return true;
    } catch {
        return false;
    }
}
