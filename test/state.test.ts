import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { StateStore, type PendingMessage, type StoryCheckpoint } from "../src/state.js";

const pendingMessage = (id: string): PendingMessage => ({
  id,
  authorId: "user",
  discordDisplayName: "친구",
  content: `입력 ${id}`,
  createdAt: "2026-08-06T00:00:00.000Z",
});

const checkpoint = (id: string, inputMessages: PendingMessage[]): StoryCheckpoint => ({
  id,
  inputMessages,
  turns: inputMessages.map((message) => ({
    authorId: message.authorId,
    name: message.discordDisplayName,
    blocks: [{ type: "dialogue", text: message.content }],
    createdAt: message.createdAt,
  })),
  assistantResponse: `**“응답 ${id}”**`,
  requestedBy: "친구",
  createdAt: "2026-08-06T00:00:01.000Z",
});

test("state persists profiles, character presets, sessions, and pending input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "character-bot-state-"));
  try {
    const file = path.join(directory, "state.json");
    const state = new StateStore(file);
    await state.load();

    await state.setProfile("guild:user", {
      nickname: "친구1",
      description: "침착한 탐정",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    await state.setCharacter("guild:channel", {
      name: "리아",
      situation: "비 오는 밤의 저택",
      updatedAt: "2026-08-06T00:00:00.000Z",
      updatedBy: "user",
    });
    await state.setSession("guild:channel", { threadId: "thread-1", characterHash: "hash" });
    await state.appendPending("guild:channel", {
      id: "message-1",
      authorId: "user",
      discordDisplayName: "Discord 이름",
      content: "*문을 연다.*",
      createdAt: "2026-08-06T00:00:00.000Z",
    });

    const reloaded = new StateStore(file);
    await reloaded.load();
    assert.equal(reloaded.getProfile("guild:user")?.nickname, "친구1");
    assert.equal(reloaded.getCharacter("guild:channel")?.name, "리아");
    assert.equal(reloaded.getSession("guild:channel")?.threadId, "thread-1");
    assert.equal(reloaded.pendingCount("guild:channel"), 1);

    const persisted = JSON.parse(await readFile(file, "utf8")) as { version: number };
    assert.equal(persisted.version, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completing a run checkpoints its turn and preserves messages queued later", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "character-bot-state-"));
  try {
    const state = new StateStore(path.join(directory, "state.json"));
    await state.load();

    await state.appendPending("story", pendingMessage("old"));
    const snapshot = state.getPending("story");
    await state.appendPending("story", pendingMessage("new"));
    await state.completeRun("story", checkpoint("turn-1", snapshot));

    assert.deepEqual(
      state.getPending("story").map((message) => message.id),
      ["new"],
    );
    assert.equal(state.historyCount("story"), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rewind removes checkpoints, restores their inputs, and starts a fresh thread", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "character-bot-state-"));
  try {
    const state = new StateStore(path.join(directory, "state.json"));
    await state.load();

    const first = pendingMessage("first");
    await state.appendPending("story", first);
    await state.completeRun("story", checkpoint("turn-1", [first]));

    const second = pendingMessage("second");
    await state.appendPending("story", second);
    await state.completeRun("story", checkpoint("turn-2", [second]));

    await state.appendPending("story", pendingMessage("current"));
    await state.setSession("story", { threadId: "latest-thread", characterHash: "hash" });

    const result = await state.rewindStory("story", 1);
    assert.deepEqual(result, { rewoundTurns: 1, restoredMessages: 1, remainingTurns: 1 });
    assert.equal(state.getSession("story"), undefined);
    assert.deepEqual(
      state.getPending("story").map((message) => message.id),
      ["second", "current"],
    );
    assert.deepEqual(
      state.getHistory("story").map((turn) => turn.id),
      ["turn-1"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("story reset preserves profiles and character preset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "character-bot-state-"));
  try {
    const state = new StateStore(path.join(directory, "state.json"));
    await state.load();
    await state.setProfile("profile", { nickname: "친구", updatedAt: "now" });
    await state.setCharacter("story", { name: "리아", updatedAt: "now", updatedBy: "user" });
    await state.setSession("story", { threadId: "thread", characterHash: "hash" });
    const message = pendingMessage("message");
    await state.appendPending("story", message);
    await state.completeRun("story", checkpoint("turn", [message]));
    await state.appendPending("story", pendingMessage("waiting"));

    const result = await state.resetStory("story");
    assert.deepEqual(result, { hadSession: true, discardedMessages: 1, discardedTurns: 1 });
    assert.equal(state.getSession("story"), undefined);
    assert.equal(state.pendingCount("story"), 0);
    assert.equal(state.historyCount("story"), 0);
    assert.equal(state.getProfile("profile")?.nickname, "친구");
    assert.equal(state.getCharacter("story")?.name, "리아");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
