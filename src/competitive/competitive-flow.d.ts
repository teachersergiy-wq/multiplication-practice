export function competitiveNow(serverNow: string, receivedAt: number, deviceNow?: number): number;
export function competitiveRemainingSeconds(limitMs: number, serverNow: string, receivedAt: number, deviceNow?: number): number | null;
export function formatCompetitiveDuration(durationMs: number): string;
export function qualifiedLabels(qualified?: { scope: string; rank: number }[]): { scope: string; rank: number; label: string }[];
export function publishChoices(qualified?: { scope: string; rank: number }[]): string[];
export function competitiveApiMessage(code: string): string;
export function updateQuestionClock(previous: { serverNow: string; receivedAt: number }, limitMs: number, receivedAt?: number): { serverNow: string; receivedAt: number; limitMs: number };
