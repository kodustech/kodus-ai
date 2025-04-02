export function LeadTimeFormat(leadView) {
    const days = Math.floor(leadView / 24);
    let hours = Math.floor(leadView % 24);
    let minutes = Math.round((leadView % 1) * 60);

    if (minutes >= 60) {
        minutes -= 60;
        hours += 1;
    }

    let result = '';
    if (days > 0) result += `${days}d `;
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m`;

    return result.trim();
}
