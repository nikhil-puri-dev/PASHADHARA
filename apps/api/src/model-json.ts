/** Accept JSON directly or exactly one complete Markdown JSON code fence. */
export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return JSON.parse(fence ? fence[1]! : trimmed);
}
