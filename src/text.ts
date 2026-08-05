const discordMessageLimit = 2_000;

export type PlayerInputBlock = {
  type: "narration" | "dialogue";
  text: string;
};

export function stripBotMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${escapeRegex(botUserId)}>`, "g"), "").trim();
}

export function splitDiscordMessage(text: string, limit = 1_900): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > discordMessageLimit) {
    throw new Error(`limit must be between 1 and ${discordMessageLimit}`);
  }

  const normalized = text.trim();
  if (!normalized) return ["…"];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function parsePlayerMessage(content: string): PlayerInputBlock[] {
  const blocks: PlayerInputBlock[] = [];
  let cursor = 0;
  let index = 0;

  while (index < content.length) {
    if (!isSingleStarDelimiter(content, index)) {
      index += 1;
      continue;
    }

    const closing = findClosingStar(content, index + 1);
    if (closing === -1) {
      index += 1;
      continue;
    }

    pushBlock(blocks, "dialogue", content.slice(cursor, index));
    pushBlock(blocks, "narration", content.slice(index + 1, closing));
    cursor = closing + 1;
    index = cursor;
  }

  pushBlock(blocks, "dialogue", content.slice(cursor));
  return blocks;
}

function findClosingStar(content: string, from: number): number {
  for (let index = from; index < content.length; index += 1) {
    if (isSingleStarDelimiter(content, index)) return index;
  }
  return -1;
}

function isSingleStarDelimiter(content: string, index: number): boolean {
  if (content[index] !== "*" || isEscaped(content, index)) return false;
  return content[index - 1] !== "*" && content[index + 1] !== "*";
}

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function pushBlock(
  blocks: PlayerInputBlock[],
  type: PlayerInputBlock["type"],
  raw: string,
): void {
  const text = raw.trim().replace(/\\([\\*])/g, "$1");
  if (text) blocks.push({ type, text });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
