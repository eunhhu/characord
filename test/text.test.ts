import assert from "node:assert/strict";
import { HarmBlockThreshold, ThinkingLevel } from "@google/genai";
import { test } from "bun:test";
import {
  buildGeminiGenerationConfig,
  buildStoryPrompt,
  renderStoryResponse,
} from "../src/codex-chat.js";
import { parsePlayerMessage, splitDiscordMessage, stripBotMention } from "../src/text.js";

test("stripBotMention removes both Discord mention forms", () => {
  assert.equal(stripBotMention("<@123> 안녕 <@!123>", "123"), "안녕");
});

test("splitDiscordMessage keeps every chunk inside the limit", () => {
  const input = `${"가".repeat(60)}\n${"나".repeat(60)}`;
  const chunks = splitDiscordMessage(input, 80);
  assert.deepEqual(chunks, ["가".repeat(60), "나".repeat(60)]);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
});

test("splitDiscordMessage returns an ellipsis for blank output", () => {
  assert.deepEqual(splitDiscordMessage("   "), ["…"]);
});

test("renderStoryResponse applies deterministic Discord Markdown", () => {
  const raw = JSON.stringify({
    blocks: [
      { type: "narration", text: "비가 *세차게* 내린다." },
      { type: "dialogue", text: "“이제 왔네.”" },
      { type: "thought", text: "설마 들킨 건가?" },
    ],
  });

  assert.equal(
    renderStoryResponse(raw),
    "*비가 \\*세차게\\* 내린다.*\n\n**“이제 왔네.”**\n\n***‘설마 들킨 건가?’***",
  );
});

test("renderStoryResponse removes model-supplied duplicate Markdown wrappers", () => {
  const raw = JSON.stringify({
    blocks: [
      { type: "narration", text: "*문이 열린다.*" },
      { type: "dialogue", text: "**“들어와.”**" },
      { type: "thought", text: "***‘늦었네.’***" },
    ],
  });

  assert.equal(
    renderStoryResponse(raw),
    "*문이 열린다.*\n\n**“들어와.”**\n\n***‘늦었네.’***",
  );
});

test("parsePlayerMessage treats single-star spans as narration", () => {
  assert.deepEqual(parsePlayerMessage("안녕. *문을 닫고 돌아본다.* 왜 불렀어?"), [
    { type: "dialogue", text: "안녕." },
    { type: "narration", text: "문을 닫고 돌아본다." },
    { type: "dialogue", text: "왜 불렀어?" },
  ]);
});

test("parsePlayerMessage leaves bold and escaped stars as dialogue", () => {
  assert.deepEqual(parsePlayerMessage("**강조**와 \\*별표\\*"), [
    { type: "dialogue", text: "**강조**와 *별표*" },
  ]);
});

test("buildStoryPrompt replays retained checkpoints into a rebuilt thread", () => {
  const prompt = buildStoryPrompt(
    { sessionKey: "story", requestedBy: "친구", turns: [] },
    "캐릭터 카드",
    [
      {
        id: "turn-1",
        inputMessages: [],
        turns: [],
        assistantResponse: "**“기억할 대사”**",
        requestedBy: "친구",
        createdAt: "now",
      },
    ],
  );

  assert.match(prompt, /BEGIN RETAINED HISTORY JSON/);
  assert.match(prompt, /기억할 대사/);
  assert.match(prompt, /add no application-specific content filter/);
});

test("Gemini uses structured JSON, medium thinking, and disabled adjustable filters", () => {
  const config = buildGeminiGenerationConfig("medium");

  assert.equal(config.responseMimeType, "application/json");
  assert.equal(config.thinkingConfig?.thinkingLevel, ThinkingLevel.MEDIUM);
  assert.ok(config.responseJsonSchema);
  assert.equal(config.safetySettings?.length, 4);
  assert.ok(
    config.safetySettings?.every(
      (setting) => setting.threshold === HarmBlockThreshold.OFF,
    ),
  );
});
