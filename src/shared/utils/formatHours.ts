export function formatHours(hours: number) {
    // If it's not a number or if it's less than 0, return an empty string or another string indicating an error
    if (isNaN(hours)) return '';

    if (hours < 0) {
        hours = hours * -1;
    }

    // Calculate the total number of minutes
    let totalMinutes = hours * 60;

    // Calculate the number of days, hours, and minutes
    const days = Math.floor(totalMinutes / (60 * 24));
    totalMinutes -= days * 60 * 24;

    const hr = Math.floor(totalMinutes / 60);
    totalMinutes -= hr * 60;

    const min = Math.round(totalMinutes);

    // Build the output string
    let result = '';
    if (days > 0) result += `${days}d `;
    if (hr > 0) result += `${hr}h `;
    if (min > 0 && days <= 0) result += `${min}m`;

    return result.trim(); // Remove extra spaces at the beginning/end of the string
}

export function convertToUTC(timeBR: string): string {
    if (!/^\d{2}:\d{2}$/.test(timeBR)) {
        throw new Error('Invalid time format. Use HH:MM');
    }

    const [hours, minutes] = timeBR.split(':').map(Number);

    if (hours >= 24 || minutes >= 60) {
        throw new Error('Invalid time format. Use HH:MM');
    }

    // Create a UTC date
    const dateUTC = new Date(Date.UTC(1970, 0, 1, hours, minutes));

    // Add 3 hours to convert from BRT to UTC
    dateUTC.setUTCHours(dateUTC.getUTCHours() + 3);

    const hoursUTC = String(dateUTC.getUTCHours()).padStart(2, '0');
    const minutesUTC = String(dateUTC.getUTCMinutes()).padStart(2, '0');

    return `${hoursUTC}:${minutesUTC}`;
}

export function convertToBRT(timeUTC: string): string {
    if (!/^\d{2}:\d{2}$/.test(timeUTC)) {
        throw new Error('Invalid time format. Use HH:MM');
    }

    const [hours, minutes] = timeUTC.split(':').map(Number);

    if (hours >= 24 || minutes >= 60) {
        throw new Error('Invalid time format. Use HH:MM');
    }

    const dateUTC = new Date(Date.UTC(1970, 0, 1, hours, minutes));

    // Subtracting 3 hours to convert from UTC to BRT
    dateUTC.setUTCHours(dateUTC.getUTCHours() - 3);

    const hoursBRT = String(dateUTC.getUTCHours()).padStart(2, '0');
    const minutesBRT = String(dateUTC.getUTCMinutes()).padStart(2, '0');

    return `${hoursBRT}:${minutesBRT}`;
}
