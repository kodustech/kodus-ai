import { Analytics } from '@segment/analytics-node';

let analytics = null;

// Initialize Analytics only if the API_SEGMENT_KEY is present
const initializeAnalytics = () => {
    const writeKey = process.env.API_SEGMENT_KEY;
    if (writeKey) {
        analytics = new Analytics({ writeKey });
    } else {
        console.warn(
            'API_SEGMENT_KEY is not defined. Analytics functionalities are disabled.',
        );
    }
};

// Function to identify the user
const identify = (userId: string, traits: any) => {
    if (!analytics) {
        console.warn('Analytics not initialized. Identify call ignored.');
        return;
    }
    analytics.identify({ userId, traits });
};

// Function to track events
const track = (userId: string, event: string, properties?: any) => {
    if (!analytics) {
        console.warn('Analytics not initialized. Track call ignored.');
        return;
    }
    analytics.track({ userId, event, properties });
};

// Initialize Analytics when the module is loaded
initializeAnalytics();

export { identify, track };
