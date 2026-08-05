import assert from "node:assert/strict";
import test from "node:test";
import { renderStoryResponse } from "../src/codex-chat.js";
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
