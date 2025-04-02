export type KodyNotification = {
    title: string;
    message: string;
    buttons?: {
        text: string;
        url: string;
    }[];
};
