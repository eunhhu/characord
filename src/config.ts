import path from "node:path";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type AppConfig = {
  discordToken: string;
  guildId: string;
  channelId: string;
  allowedUserIds: ReadonlySet<string>;
  requireMention: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  responseTimeoutMs: number;
  characterFile: string;
  stateFile: string;
  codexWorkingDirectory: string;
};

const reasoningEfforts = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function loadConfig(cwd = process.cwd()): AppConfig {
  const reasoningEffort = (process.env.CODEX_REASONING_EFFORT ?? "low") as ReasoningEffort;
  if (!reasoningEfforts.has(reasoningEffort)) {
    throw new Error(
      "CODEX_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh",
    );
  }

  return {
    discordToken: required("DISCORD_TOKEN"),
    guildId: required("DISCORD_GUILD_ID"),
    channelId: required("DISCORD_CHANNEL_ID"),
    allowedUserIds: new Set(csv(process.env.DISCORD_ALLOWED_USER_IDS)),
    requireMention: booleanValue("DISCORD_REQUIRE_MENTION", false),
    model: process.env.CODEX_MODEL?.trim() || "gpt-5.6-terra",
    reasoningEffort,
    responseTimeoutMs: positiveInteger("RESPONSE_TIMEOUT_MS", 180_000),
    characterFile: path.resolve(cwd, process.env.CHARACTER_FILE ?? "character.md"),
    stateFile: path.resolve(cwd, process.env.STATE_FILE ?? "data/state.json"),
    codexWorkingDirectory: path.resolve(
      cwd,
      process.env.CODEX_WORKING_DIRECTORY ?? "runtime",
    ),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
