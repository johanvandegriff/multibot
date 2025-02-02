export function getEmoteAsUrl(id, theme = 'light', scale = '2.0') {
    return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/${theme}/${scale}`;
}
export function parseEmotesInMessage(emotes, msg) {
    if (!emotes)
        return [{ type: 'text', value: msg }];
    const msgArray = Array.from(msg);
    const emotePositions = Object.entries(emotes)
        .reduce((ranges, [id, stringRanges]) => {
        stringRanges.forEach(stringRange => {
            const [start, end] = stringRange.split('-').map(Number);
            ranges.push({ id, start, end });
        });
        return ranges;
    }, [])
        .sort((a, b) => a.start - b.start);
    const result = [];
    let cursor = 0;
    for (const { id, start, end } of emotePositions) {
        if (start > cursor) {
            result.push({
                type: 'text',
                value: msgArray.slice(cursor, start).join('')
            });
        }
        result.push({
            type: 'emote',
            raw: msgArray.slice(start, end + 1).join(''),
            value: `${id}`
        });
        cursor = end + 1;
    }
    if (cursor < msgArray.length) {
        result.push({
            type: 'text',
            value: msgArray.slice(cursor).join('')
        });
    }
    return result;
}
//# sourceMappingURL=emote.js.map