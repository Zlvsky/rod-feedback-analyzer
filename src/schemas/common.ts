import { z } from 'zod';

export const snowflake = z.string().regex(/^[1-9]\d{16,19}$/, 'Expected a Discord snowflake string');
export const trelloId = z.string().regex(/^[a-f0-9]{24}$/, 'Expected full 24-character Trello ID');
export const utc = z.iso.datetime();
export const taskId = z.string().regex(/^rod-[a-z0-9][a-z0-9-]{5,99}$/);
// Reject controls, invisible direction changes, and forged automation markers.
export const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v), 'Unsafe control characters')
  .refine(v => !/rod-(?:task|source|op):/i.test(v), 'Reserved automation marker');
export const discordUrl = z.string().regex(/^https:\/\/discord\.com\/channels\/[1-9]\d{16,19}\/[1-9]\d{16,19}\/[1-9]\d{16,19}$/);
export const unique = <T>(items: T[]) => [...new Set(items)];
