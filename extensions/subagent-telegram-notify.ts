import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EXTENSION_NAME = "telegram-notify";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "subagent-telegram-notify.json");

type TelegramConfig = {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
	message?: string;
};

function readJsonConfig(): TelegramConfig {
	if (!existsSync(CONFIG_PATH)) return { enabled: true };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TelegramConfig;
		return { ...parsed, enabled: parsed.enabled ?? true };
	} catch {
		return { enabled: true };
	}
}

function resolveConfig(): TelegramConfig {
	const fileConfig = readJsonConfig();
	const enabledEnv =
		process.env.TELEGRAM_NOTIFY_ENABLED ??
		process.env.SUBAGENT_TELEGRAM_ENABLED ??
		process.env.PI_SUBAGENT_TELEGRAM_ENABLED;
	const enabled =
		enabledEnv == null ? fileConfig.enabled !== false : !["0", "false", "no", "off"].includes(enabledEnv.toLowerCase());

	return {
		...fileConfig,
		enabled,
		botToken:
			process.env.TELEGRAM_NOTIFY_BOT_TOKEN ??
			process.env.SUBAGENT_TELEGRAM_BOT_TOKEN ??
			process.env.PI_SUBAGENT_TELEGRAM_BOT_TOKEN ??
			process.env.TELEGRAM_BOT_TOKEN ??
			fileConfig.botToken,
		chatId:
			process.env.TELEGRAM_NOTIFY_CHAT_ID ??
			process.env.SUBAGENT_TELEGRAM_CHAT_ID ??
			process.env.PI_SUBAGENT_TELEGRAM_CHAT_ID ??
			process.env.TELEGRAM_CHAT_ID ??
			fileConfig.chatId,
		message: process.env.TELEGRAM_NOTIFY_MESSAGE ?? process.env.SUBAGENT_TELEGRAM_MESSAGE ?? fileConfig.message,
	};
}

function saveConfig(config: TelegramConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	try {
		chmodSync(CONFIG_PATH, 0o600);
	} catch {
		// Best effort on non-POSIX filesystems.
	}
}

function isConfigured(config = resolveConfig()): boolean {
	return Boolean(config.enabled && config.botToken && config.chatId);
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMessage(message: string, title?: string): string {
	const body = escapeHtml(message.trim());
	const heading = title?.trim() ? `<b>${escapeHtml(title.trim())}</b>\n` : "";
	return `${heading}${body}`;
}

async function sendTelegram(message: string, title?: string, config = resolveConfig()): Promise<void> {
	if (!config.enabled) throw new Error("Telegram 알림이 꺼져 있습니다. /noti on 으로 켜세요.");
	if (!config.botToken || !config.chatId)
		throw new Error("Telegram botToken/chatId가 없습니다. /noti setup 으로 설정하세요.");

	const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			chat_id: config.chatId,
			text: formatMessage(message, title),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Telegram sendMessage 실패: ${response.status} ${body.slice(0, 300)}`);
	}
}

export default function telegramNotify(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const config = resolveConfig();
		ctx.ui.setStatus(EXTENSION_NAME, isConfigured(config) ? "noti:on" : "noti:off");
	});

	pi.registerTool({
		name: "telegram_notify",
		label: "Telegram Notify",
		description:
			"Send a Telegram notification message. Use only when the user explicitly asks for a Telegram alert, " +
			"or when a condition the user specified for an alert has been met.",
		promptSnippet:
			"Send a Telegram notification message on explicit user request or when a user-specified alert condition is met.",
		promptGuidelines: [
			"Use telegram_notify only when the user explicitly asks to send a Telegram notification, or when a condition the user previously specified for notification has been met.",
			"Do not use telegram_notify merely because subagents, commands, or tasks finished unless the user requested that exact notification condition.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Notification body to send to Telegram" }),
			title: Type.Optional(Type.String({ description: "Optional bold title shown before the message" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await sendTelegram(params.message, params.title);
				return {
					content: [{ type: "text", text: "Telegram 알림을 보냈습니다." }],
					details: { sent: true },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					details: { sent: false, error: message },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("noti", {
		description: "Telegram notifications: /noti on|off|status|test|setup",
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keeping the small command dispatcher together makes each subcommand easier to audit.
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";

			if (sub === "setup") {
				const current = resolveConfig();
				const botToken = await ctx.ui.input(
					"Telegram bot token",
					current.botToken ? "현재 값 유지: 빈칸으로 Enter" : "123456:ABC...",
				);
				const chatId = await ctx.ui.input(
					"Telegram chat id",
					current.chatId ? "현재 값 유지: 빈칸으로 Enter" : "123456789",
				);
				const message = await ctx.ui.input("기본 테스트 문구", current.message || "Pi 알림 테스트입니다.");
				saveConfig({
					...current,
					enabled: true,
					botToken: botToken?.trim() || current.botToken,
					chatId: chatId?.trim() || current.chatId,
					message: message?.trim() || current.message,
				});
				ctx.ui.setStatus(EXTENSION_NAME, "noti:on");
				ctx.ui.notify(`저장 완료: ${CONFIG_PATH}`, "info");
				return;
			}

			if (sub === "on") {
				const current = resolveConfig();
				saveConfig({ ...current, enabled: true });
				ctx.ui.setStatus(EXTENSION_NAME, isConfigured({ ...current, enabled: true }) ? "noti:on" : "noti:setup-needed");
				ctx.ui.notify("Telegram 알림 도구를 켰습니다.", "info");
				return;
			}

			if (sub === "off") {
				const current = resolveConfig();
				saveConfig({ ...current, enabled: false });
				ctx.ui.setStatus(EXTENSION_NAME, "noti:off");
				ctx.ui.notify("Telegram 알림 도구를 껐습니다.", "info");
				return;
			}

			if (sub === "test") {
				try {
					const config = resolveConfig();
					await sendTelegram(config.message || "Pi 알림 테스트입니다.", "Pi Telegram 알림 테스트", config);
					ctx.ui.notify("Telegram 테스트 메시지를 보냈습니다.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Telegram 테스트 실패", "error");
				}
				return;
			}

			if (sub === "status") {
				const config = resolveConfig();
				ctx.ui.notify(
					`Telegram notify: ${isConfigured(config) ? "ready" : "not ready"} · enabled=${config.enabled !== false} · config ${CONFIG_PATH}`,
					isConfigured(config) ? "info" : "warning",
				);
				return;
			}

			ctx.ui.notify("사용법: /noti on | /noti off | /noti status | /noti test", "info");
		},
	});
}
