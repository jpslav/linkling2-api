// The team key every test app is built with, and the headers that carry it (ADR-0005).
export const TEST_KEY = "correct-horse-battery-staple";

export const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

export const basic = (user: string, key: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`,
});
