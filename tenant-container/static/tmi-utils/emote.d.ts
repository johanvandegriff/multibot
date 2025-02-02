export type EmoteTheme = 'light' | 'dark';
export type EmoteScale = '1.0' | '2.0' | '3.0';
export interface MessagePart {
    type: 'text' | 'emote';
    raw?: string;
    value: string;
}
export declare function getEmoteAsUrl(id: string, theme?: EmoteTheme, scale?: EmoteScale): string;
export declare function parseEmotesInMessage(emotes: Record<string, string[]>, msg: string): MessagePart[];
