type ReadableLike = NodeJS.ReadStream & {
    isTTY?: boolean;
    setEncoding?(encoding: BufferEncoding): void;
    pause?(): void;
    resume?(): void;
};

interface ReadStreamPayloadOptions {
    noDataTimeoutMs?: number;
    brokenStreamTimeoutMs?: number;
}

export async function readStreamPayload(
    stream: ReadableLike,
    options: ReadStreamPayloadOptions = {},
): Promise<string> {
    if (stream.isTTY) {
        return '';
    }

    return new Promise<string>((resolve) => {
        let data = '';
        let settled = false;

        const noDataTimer = setTimeout(
            () => finish(''),
            options.noDataTimeoutMs ?? 750,
        );
        const brokenStreamTimer = setTimeout(
            () => finish(data),
            options.brokenStreamTimeoutMs ?? 5000,
        );

        const onData = (chunk: string | Buffer): void => {
            data += chunk.toString();
            clearTimeout(noDataTimer);
        };

        const onEnd = (): void => finish(data);
        const onError = (): void => finish(data);

        const finish = (value: string): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(noDataTimer);
            clearTimeout(brokenStreamTimer);
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
            stream.pause?.();
            resolve(value);
        };

        stream.setEncoding?.('utf-8');
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
        stream.resume?.();
    });
}
