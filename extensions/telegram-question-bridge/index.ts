import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askViaTelegram, type QuestionRequest, type TelegramConfig } from "./telegram.ts";

type Bridge = (
	request: QuestionRequest,
	options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown> | undefined>;
type BridgeUI = ExtensionContext["ui"] & { askUserQuestion?: Bridge; ask_user_question?: Bridge };
type SavedBridge = { ui: BridgeUI; camel?: Bridge; snake?: Bridge };

const CONFIG_PATH = join(homedir(), ".pi", "agent", "subagent-telegram-notify.json");
const channels = new Map<string, "local" | "telegram">();
const bridges = new Map<string, SavedBridge>();
let activeQuestion = false;

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || "default";
}

export function resolveTelegramConfig(env = process.env, path = CONFIG_PATH): TelegramConfig {
	let file: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			throw new Error(`Telegram 질문 설정 파일을 읽을 수 없습니다: ${path}`);
		}
	}
	const botToken =
		env.TELEGRAM_NOTIFY_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN ?? (typeof file.botToken === "string" ? file.botToken : "");
	const chatId =
		env.TELEGRAM_NOTIFY_CHAT_ID ?? env.TELEGRAM_CHAT_ID ?? (typeof file.chatId === "string" ? file.chatId : "");
	const userId = env.TELEGRAM_QUESTION_USER_ID ?? (typeof file.userId === "string" ? file.userId : chatId);
	if (!botToken.trim() || !chatId.trim() || !userId.trim()) {
		throw new Error("Telegram 질문 설정이 없습니다. botToken, chatId와 userId를 설정하세요.");
	}
	return { botToken: botToken.trim(), chatId: chatId.trim(), userId: userId.trim() };
}

function restore(id: string): void {
	const saved = bridges.get(id);
	if (!saved) return;
	if (saved.camel) saved.ui.askUserQuestion = saved.camel;
	else Reflect.deleteProperty(saved.ui, "askUserQuestion");
	if (saved.snake) saved.ui.ask_user_question = saved.snake;
	else Reflect.deleteProperty(saved.ui, "ask_user_question");
	bridges.delete(id);
}

function install(ctx: ExtensionContext): void {
	const id = sessionId(ctx);
	if (bridges.has(id)) return;
	const ui = ctx.ui as BridgeUI;
	const saved = { ui, camel: ui.askUserQuestion, snake: ui.ask_user_question };
	const bridge: Bridge = async (request, options) => {
		if (activeQuestion) throw new Error("Telegram 질문은 한 번에 하나만 기다릴 수 있습니다.");
		activeQuestion = true;
		try {
			return await askViaTelegram(resolveTelegramConfig(), request, options);
		} finally {
			activeQuestion = false;
		}
	};
	ui.askUserQuestion = bridge;
	ui.ask_user_question = bridge;
	bridges.set(id, saved);
}

function setChannel(ctx: ExtensionContext, channel: "local" | "telegram"): void {
	const id = sessionId(ctx);
	if (channel === "telegram") install(ctx);
	else restore(id);
	channels.set(id, channel);
}

function status(ctx: ExtensionContext): string {
	const channel = channels.get(sessionId(ctx)) ?? "local";
	return `질문 채널: ${channel}${channel === "telegram" ? " (현재 Pi 프로세스가 Telegram polling)" : ""}`;
}

export default function telegramQuestionBridge(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question_channel",
		label: "Question Channel",
		description: "Switch this session's ask_user_question form between local UI and Telegram.",
		promptSnippet: "텔레그램으로 질문해/거기서 답할게면 telegram, 여기서 물어봐/터미널에서면 local로 전환한다.",
		promptGuidelines: [
			"사용자가 ‘텔레그램으로 질문해’ 또는 ‘거기서 답할게’라고 하면 question_channel({ channel: 'telegram' })을 사용한다.",
			"사용자가 ‘여기서 물어봐’ 또는 ‘터미널에서’라고 하면 question_channel({ channel: 'local' })을 사용한다.",
		],
		parameters: Type.Object({ channel: Type.Union([Type.Literal("local"), Type.Literal("telegram")]) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setChannel(ctx, params.channel);
			return { content: [{ type: "text" as const, text: status(ctx) }], details: { channel: params.channel } };
		},
	});

	pi.registerCommand("question-channel", {
		description: "Question channel: /question-channel local|telegram|status",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "local" || command === "telegram") {
				setChannel(ctx, command);
				ctx.ui.notify(status(ctx), "info");
				return;
			}
			ctx.ui.notify(command === "status" ? status(ctx) : "사용법: /question-channel local|telegram|status", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		for (const id of bridges.keys()) restore(id);
		channels.clear();
	});
}
