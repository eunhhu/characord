import "dotenv/config";
import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  type Message,
  Partials,
  SlashCommandBuilder,
} from "discord.js";
import { mkdir } from "node:fs/promises";
import { CharacterChat } from "./codex-chat.js";
import { loadConfig } from "./config.js";
import { KeyedQueue } from "./queue.js";
import {
  StateStore,
  type CharacterPreset,
  type PendingMessage,
  type StoryTurn,
  type UserProfile,
} from "./state.js";
import { parsePlayerMessage, splitDiscordMessage, stripBotMention } from "./text.js";

const config = loadConfig();
if (config.aiProvider === "codex") {
  await mkdir(config.codexWorkingDirectory, { recursive: true });
}

const state = new StateStore(config.stateFile);
await state.load();

const chat = new CharacterChat(config, state);
const queue = new KeyedQueue();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder()
    .setName("me")
    .setDescription("캐릭터가 기억하는 내 이름과 특징을 확인합니다."),
  new SlashCommandBuilder()
    .setName("set")
    .setDescription("캐릭터가 사용할 내 이름과 특징을 설정합니다.")
    .addStringOption((option) =>
      option
        .setName("nickname")
        .setDescription("캐릭터가 나를 부를 이름")
        .setMaxLength(80),
    )
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("외형, 성격, 관계, 말투 등 캐릭터가 알아둘 특징")
        .setMaxLength(1_000),
    )
    .addBooleanOption((option) =>
      option.setName("reset").setDescription("저장된 이름과 특징을 모두 초기화"),
    ),
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("지금까지 쌓인 채널 메시지로 다음 스토리 턴을 진행합니다."),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("스토리 기억과 아직 실행하지 않은 입력을 초기화합니다."),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("이전 /run 체크포인트로 돌아가 입력을 다시 대기열에 넣습니다.")
    .addIntegerOption((option) =>
      option
        .setName("steps")
        .setDescription("되돌릴 /run 턴 수 (기본 1)")
        .setMinValue(1)
        .setMaxValue(20),
    ),
  new SlashCommandBuilder()
    .setName("init")
    .setDescription("이 채널의 캐릭터와 상황을 상세 설정합니다.")
    .addStringOption((option) =>
      option.setName("name").setDescription("캐릭터 이름").setMaxLength(100),
    )
    .addStringOption((option) =>
      option
        .setName("personality")
        .setDescription("성격, 말투, 행동 성향")
        .setMaxLength(1_500),
    )
    .addStringOption((option) =>
      option
        .setName("background")
        .setDescription("세계관, 관계, 과거, 사전설정")
        .setMaxLength(2_000),
    )
    .addStringOption((option) =>
      option
        .setName("situation")
        .setDescription("현재 장소, 시점, 사건과 시작 상황")
        .setMaxLength(2_000),
    )
    .addStringOption((option) =>
      option
        .setName("notes")
        .setDescription("외형, 호칭 규칙, 금지사항 등 추가 상세")
        .setMaxLength(1_500),
    )
    .addBooleanOption((option) =>
      option.setName("clear").setDescription("채널 프리셋을 지우고 character.md 기본값 사용"),
    ),
  new SlashCommandBuilder()
    .setName("char")
    .setDescription("현재 적용 중인 캐릭터 사전설정을 확인합니다."),
].map((command) => command.toJSON());

client.once("ready", (readyClient) => {
  console.log(
    `[ready] ${readyClient.user.tag} | guild=${config.guildId} channel=${config.channelId} provider=${config.aiProvider} model=${config.model}/${config.reasoningEffort}`,
  );
  void registerCommands().catch((error) => console.error("[commands]", safeError(error)));
});

client.on("messageCreate", (message) => {
  if (!shouldQueueMessage(message)) return;
  void queueMessage(message).catch((error) => console.error("[message]", safeError(error)));
});

client.on("interactionCreate", (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleInteraction(interaction).catch(async (error) => {
    console.error("[interaction]", safeError(error));
    const content = "명령 처리 실패. 로컬 로그를 확인해줘.";
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content }).catch(() => undefined);
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
    }
  });
});

client.on("error", (error) => console.error("[discord]", safeError(error)));

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await client.login(config.discordToken);

async function registerCommands(): Promise<void> {
  const guild = await client.guilds.fetch(config.guildId);
  await guild.commands.set(commands);
  console.log("[commands] registered /me /set /run /rewind /reset /init /char");
}

function shouldQueueMessage(message: Message): boolean {
  if (message.author.bot || !message.guildId) return false;
  if (message.guildId !== config.guildId || message.channelId !== config.channelId) return false;
  if (!isAllowedUser(message.author.id)) return false;
  if (!config.requireMention) return true;
  return !!client.user && message.mentions.users.has(client.user.id);
}

async function queueMessage(message: Message): Promise<void> {
  const botUserId = client.user?.id;
  if (!botUserId) return;
  const content = stripBotMention(message.content, botUserId);
  if (!content) return;

  const pending: PendingMessage = {
    id: message.id,
    authorId: message.author.id,
    discordDisplayName: message.member?.displayName ?? message.author.displayName,
    content,
    createdAt: message.createdAt.toISOString(),
  };

  try {
    await state.appendPending(sessionKey(message.guildId!, message.channelId), pending);
    await message.react("📝").catch(() => undefined);
  } catch (error) {
    await message.reply({
      content: "스토리 입력 대기열이 가득 찼어. `/run`으로 먼저 진행해줘.",
      allowedMentions: { repliedUser: false },
    });
    throw error;
  }
}

async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isConfiguredChannel(interaction)) {
    await interaction.reply({
      content: "이 명령은 설정된 캐릭터챗 채널에서만 사용할 수 있어.",
      ephemeral: true,
    });
    return;
  }
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: "사용 허용 목록에 없는 사용자야.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "me") {
    await handleMe(interaction);
  } else if (interaction.commandName === "set") {
    await handleSet(interaction);
  } else if (interaction.commandName === "run") {
    await handleRun(interaction);
  } else if (interaction.commandName === "reset") {
    await handleReset(interaction);
  } else if (interaction.commandName === "rewind") {
    await handleRewind(interaction);
  } else if (interaction.commandName === "init") {
    await handleInit(interaction);
  } else if (interaction.commandName === "char") {
    await handleChar(interaction);
  }
}

async function handleMe(interaction: ChatInputCommandInteraction): Promise<void> {
  const key = profileKey(interaction.guildId!, interaction.user.id);
  const profile = state.getProfile(key);
  const fallbackName = displayName(interaction);
  const pending = state.pendingCount(sessionKey(interaction.guildId!, interaction.channelId));
  const history = state.historyCount(sessionKey(interaction.guildId!, interaction.channelId));

  await interaction.reply({
    content: [
      `**호칭:** ${profile?.nickname || fallbackName}${profile?.nickname ? "" : " (Discord 닉네임)"}`,
      `**특징:** ${profile?.description || "설정 없음"}`,
      `**대기 중인 입력:** ${pending}개`,
      `**되돌릴 수 있는 턴:** ${history}개`,
      `**모델:** ${config.aiProvider} / ${config.model} / ${config.aiProvider === "gemini" ? "thinking" : "reasoning"} ${config.reasoningEffort}`,
    ].join("\n"),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const reset = interaction.options.getBoolean("reset") ?? false;
  const nickname = interaction.options.getString("nickname")?.trim();
  const description = interaction.options.getString("description")?.trim();
  const key = profileKey(interaction.guildId!, interaction.user.id);

  if (reset) {
    await state.deleteProfile(key);
    await interaction.reply({ content: "내 이름과 특징을 초기화했어.", ephemeral: true });
    return;
  }

  if (!nickname && !description) {
    await interaction.reply({
      content: "`nickname`이나 `description` 중 하나 이상 입력해줘. 초기화는 `reset: true`.",
      ephemeral: true,
    });
    return;
  }

  const current = state.getProfile(key);
  const profile: UserProfile = {
    ...(nickname ? { nickname } : current?.nickname ? { nickname: current.nickname } : {}),
    ...(description
      ? { description }
      : current?.description
        ? { description: current.description }
        : {}),
    updatedAt: new Date().toISOString(),
  };
  await state.setProfile(key, profile);
  await interaction.reply({
    content: `저장됨. 호칭: **${profile.nickname || displayName(interaction)}**\n특징: ${profile.description || "설정 없음"}`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const key = sessionKey(interaction.guildId!, interaction.channelId);

  await queue.run(key, async () => {
    const pending = state.getPending(key);
    const turns = pending.map(resolveStoryTurn);
    const response = await chat.runStory({
      sessionKey: key,
      requestedBy: displayName(interaction),
      turns,
    });

    const chunks = splitDiscordMessage(response);
    await interaction.editReply({ content: chunks[0]!, allowedMentions: { parse: [] } });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
    }

    await state.completeRun(key, {
      id: interaction.id,
      inputMessages: pending,
      turns,
      assistantResponse: response,
      requestedBy: displayName(interaction),
      createdAt: new Date().toISOString(),
    });
  });
}

async function handleRewind(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const key = sessionKey(interaction.guildId!, interaction.channelId);
  const steps = interaction.options.getInteger("steps") ?? 1;
  const result = await queue.run(key, () => state.rewindStory(key, steps));

  if (result.rewoundTurns === 0) {
    await interaction.editReply("되돌릴 `/run` 체크포인트가 없어.");
    return;
  }

  await interaction.editReply({
    content: [
      `스토리 ${result.rewoundTurns}턴 되돌림.`,
      `해당 입력 ${result.restoredMessages}개를 \`/run\` 대기열 앞쪽에 복원했어.`,
      `남은 체크포인트: ${result.remainingTurns}개. 기존 Discord 출력은 보이지만 새 AI 컨텍스트에서는 제외됨.`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const key = sessionKey(interaction.guildId!, interaction.channelId);
  const result = await queue.run(key, () => state.resetStory(key));
  await interaction.editReply({
    content: `스토리 초기화됨. 체크포인트 ${result.discardedTurns}턴과 대기 입력 ${result.discardedMessages}개를 삭제했어. 사용자별 \`/set\` 정보와 캐릭터 \`/init\` 설정은 유지됨.`,
    allowedMentions: { parse: [] },
  });
}

async function handleInit(interaction: ChatInputCommandInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.channelId);
  const clear = interaction.options.getBoolean("clear") ?? false;

  if (clear) {
    await interaction.deferReply();
    await queue.run(key, async () => {
      await state.deleteCharacter(key);
      await state.deleteSession(key);
    });
    await interaction.editReply("채널 캐릭터 프리셋을 지웠어. 이제 `character.md` 기본값을 사용해.");
    return;
  }

  const updates = {
    name: interaction.options.getString("name")?.trim(),
    personality: interaction.options.getString("personality")?.trim(),
    background: interaction.options.getString("background")?.trim(),
    situation: interaction.options.getString("situation")?.trim(),
    notes: interaction.options.getString("notes")?.trim(),
  };
  if (!Object.values(updates).some(Boolean)) {
    await interaction.reply({
      content: "설정할 항목을 하나 이상 입력해줘. 전체 해제는 `clear: true`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  await queue.run(key, async () => {
    const current = state.getCharacter(key);
    const preset: CharacterPreset = {
      ...definedCharacterFields(current),
      ...definedCharacterFields(updates),
      updatedAt: new Date().toISOString(),
      updatedBy: interaction.user.id,
    };
    await state.setCharacter(key, preset);
    await state.deleteSession(key);
  });
  await interaction.editReply("캐릭터 프리셋 저장됨. 다음 `/run`부터 새 설정으로 시작해.");
}

async function handleChar(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const key = sessionKey(interaction.guildId!, interaction.channelId);
  const card = await chat.getCharacterCard(key);
  const chunks = splitDiscordMessage(card);
  await interaction.editReply({ content: chunks[0]!, allowedMentions: { parse: [] } });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

function resolveStoryTurn(message: PendingMessage): StoryTurn {
  const profile = state.getProfile(profileKey(config.guildId, message.authorId));
  return {
    authorId: message.authorId,
    name: profile?.nickname || message.discordDisplayName,
    ...(profile?.description ? { description: profile.description } : {}),
    blocks: parsePlayerMessage(message.content),
    createdAt: message.createdAt,
  };
}

function definedCharacterFields(
  value: Partial<Record<CharacterField, string | undefined>> | undefined,
): Partial<Pick<CharacterPreset, CharacterField>> {
  if (!value) return {};
  return {
    ...(value.name ? { name: value.name } : {}),
    ...(value.personality ? { personality: value.personality } : {}),
    ...(value.background ? { background: value.background } : {}),
    ...(value.situation ? { situation: value.situation } : {}),
    ...(value.notes ? { notes: value.notes } : {}),
  };
}

type CharacterField = "name" | "personality" | "background" | "situation" | "notes";

function isConfiguredChannel(interaction: ChatInputCommandInteraction): boolean {
  return interaction.guildId === config.guildId && interaction.channelId === config.channelId;
}

function isAllowedUser(userId: string): boolean {
  return config.allowedUserIds.size === 0 || config.allowedUserIds.has(userId);
}

function displayName(interaction: ChatInputCommandInteraction): string {
  if (interaction.member && "displayName" in interaction.member) {
    return interaction.member.displayName;
  }
  return interaction.user.displayName;
}

function sessionKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function profileKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function shutdown(): void {
  console.log("[shutdown]");
  client.destroy();
  process.exitCode = 0;
}
