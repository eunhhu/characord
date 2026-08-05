import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionRecord = {
  threadId: string;
  characterHash: string;
};

export type UserProfile = {
  nickname?: string;
  description?: string;
  updatedAt: string;
};

export type CharacterPreset = {
  name?: string;
  personality?: string;
  background?: string;
  situation?: string;
  notes?: string;
  updatedAt: string;
  updatedBy: string;
};

export type PendingMessage = {
  id: string;
  authorId: string;
  discordDisplayName: string;
  content: string;
  createdAt: string;
};

type StateFile = {
  version: 3;
  sessions: Record<string, SessionRecord>;
  profiles: Record<string, UserProfile>;
  characters: Record<string, CharacterPreset>;
  pending: Record<string, PendingMessage[]>;
};

type LegacyStateFileV2 = Omit<StateFile, "version" | "characters"> & { version: 2 };
type LegacyStateFileV1 = {
  version: 1;
  sessions: Record<string, SessionRecord>;
};

const emptyState = (): StateFile => ({
  version: 3,
  sessions: {},
  profiles: {},
  characters: {},
  pending: {},
});

export class StateStore {
  readonly #file: string;
  #state: StateFile = emptyState();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
      if (isStateFile(parsed)) {
        this.#state = parsed;
        return;
      }
      if (isLegacyStateFileV2(parsed)) {
        this.#state = { ...parsed, version: 3, characters: {} };
        await this.#persist();
        return;
      }
      if (isLegacyStateFileV1(parsed)) {
        this.#state = { ...emptyState(), sessions: parsed.sessions };
        await this.#persist();
        return;
      }
      throw new Error("Unsupported state file format");
    } catch (error) {
      if (isMissingFile(error)) {
        this.#state = emptyState();
        return;
      }
      throw error;
    }
  }

  getSession(key: string): SessionRecord | undefined {
    return this.#state.sessions[key];
  }

  async setSession(key: string, session: SessionRecord): Promise<void> {
    this.#state.sessions[key] = session;
    await this.#persist();
  }

  async deleteSession(key: string): Promise<boolean> {
    const existed = key in this.#state.sessions;
    delete this.#state.sessions[key];
    if (existed) await this.#persist();
    return existed;
  }

  getProfile(key: string): UserProfile | undefined {
    return this.#state.profiles[key];
  }

  async setProfile(key: string, profile: UserProfile): Promise<void> {
    this.#state.profiles[key] = profile;
    await this.#persist();
  }

  async deleteProfile(key: string): Promise<boolean> {
    const existed = key in this.#state.profiles;
    delete this.#state.profiles[key];
    if (existed) await this.#persist();
    return existed;
  }

  getCharacter(sessionKey: string): CharacterPreset | undefined {
    return this.#state.characters[sessionKey];
  }

  async setCharacter(sessionKey: string, character: CharacterPreset): Promise<void> {
    this.#state.characters[sessionKey] = character;
    await this.#persist();
  }

  async deleteCharacter(sessionKey: string): Promise<boolean> {
    const existed = sessionKey in this.#state.characters;
    delete this.#state.characters[sessionKey];
    if (existed) await this.#persist();
    return existed;
  }

  getPending(sessionKey: string): PendingMessage[] {
    return [...(this.#state.pending[sessionKey] ?? [])];
  }

  pendingCount(sessionKey: string): number {
    return this.#state.pending[sessionKey]?.length ?? 0;
  }

  async appendPending(
    sessionKey: string,
    message: PendingMessage,
    maximum = 200,
  ): Promise<number> {
    const messages = this.#state.pending[sessionKey] ?? [];
    if (messages.length >= maximum) {
      throw new Error(`Story input queue is full (${maximum} messages)`);
    }
    messages.push(message);
    this.#state.pending[sessionKey] = messages;
    await this.#persist();
    return messages.length;
  }

  async consumePending(sessionKey: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const consumed = new Set(messageIds);
    const current = this.#state.pending[sessionKey] ?? [];
    const remaining = current.filter((message) => !consumed.has(message.id));
    if (remaining.length === current.length) return;
    if (remaining.length === 0) delete this.#state.pending[sessionKey];
    else this.#state.pending[sessionKey] = remaining;
    await this.#persist();
  }

  async resetStory(sessionKey: string): Promise<{ hadSession: boolean; discardedMessages: number }> {
    const hadSession = sessionKey in this.#state.sessions;
    const discardedMessages = this.#state.pending[sessionKey]?.length ?? 0;
    delete this.#state.sessions[sessionKey];
    delete this.#state.pending[sessionKey];
    if (hadSession || discardedMessages > 0) await this.#persist();
    return { hadSession, discardedMessages };
  }

  async #persist(): Promise<void> {
    this.#writeChain = this.#writeChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    });
    await this.#writeChain;
  }
}

function isStateFile(value: unknown): value is StateFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StateFile>;
  return (
    candidate.version === 3 &&
    isRecord(candidate.sessions) &&
    isRecord(candidate.profiles) &&
    isRecord(candidate.characters) &&
    isRecord(candidate.pending)
  );
}

function isLegacyStateFileV2(value: unknown): value is LegacyStateFileV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStateFileV2>;
  return (
    candidate.version === 2 &&
    isRecord(candidate.sessions) &&
    isRecord(candidate.profiles) &&
    isRecord(candidate.pending)
  );
}

function isLegacyStateFileV1(value: unknown): value is LegacyStateFileV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStateFileV1>;
  return candidate.version === 1 && isRecord(candidate.sessions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
