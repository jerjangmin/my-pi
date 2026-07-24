import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import telegramQuestionBridge, { resolveTelegramConfig } from "./index.ts";

function registry() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	return {
		pi: {
			registerTool: (tool: any) => tools.set(tool.name, tool),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		} as any,
		tool: (name: string) => tools.get(name),
		command: (name: string) => commands.get(name),
	};
}

function context(id: string, ui: Record<string, any> = {}) {
	return { ui: { notify: vi.fn(), ...ui }, sessionManager: { getSessionId: () => id } } as any;
}

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.TELEGRAM_NOTIFY_BOT_TOKEN = undefined;
	process.env.TELEGRAM_NOTIFY_CHAT_ID = undefined;
});

describe("telegram question bridge", () => {
	it("registers the channel tool and command with switching guidance", () => {
		const r = registry();
		telegramQuestionBridge(r.pi);
		expect(r.tool("question_channel").promptSnippet).toContain("텔레그램으로 질문해");
		expect(r.command("question-channel").description).toContain("local|telegram|status");
	});

	it("installs and precisely restores both UI bridge names", async () => {
		const r = registry();
		telegramQuestionBridge(r.pi);
		const camel = vi.fn();
		const snake = vi.fn();
		const ctx = context("one", { askUserQuestion: camel, ask_user_question: snake });
		await r.tool("question_channel").execute("x", { channel: "telegram" }, undefined, undefined, ctx);
		expect(ctx.ui.askUserQuestion).not.toBe(camel);
		expect(ctx.ui.ask_user_question).not.toBe(snake);
		await r.command("question-channel").handler("local", ctx);
		expect(ctx.ui.askUserQuestion).toBe(camel);
		expect(ctx.ui.ask_user_question).toBe(snake);
	});

	it("keeps channel state separate per session", async () => {
		const r = registry();
		telegramQuestionBridge(r.pi);
		const first = context("first");
		const second = context("second");
		await r.tool("question_channel").execute("x", { channel: "telegram" }, undefined, undefined, first);
		await r.tool("question_channel").execute("x", { channel: "local" }, undefined, undefined, second);
		expect(
			(await r.tool("question_channel").execute("x", { channel: "telegram" }, undefined, undefined, first)).details,
		).toEqual({ channel: "telegram" });
		expect(second.ui.askUserQuestion).toBeUndefined();
	});

	it("uses credentials even when notification enabled is false", async () => {
		const folder = await mkdtemp(join(tmpdir(), "telegram-question-"));
		const file = join(folder, "config.json");
		await writeFile(file, JSON.stringify({ enabled: false, botToken: "token", chatId: "123" }));
		expect(resolveTelegramConfig({}, file)).toEqual({ botToken: "token", chatId: "123", userId: "123" });
	});

	it("rejects concurrent bridge calls", async () => {
		process.env.TELEGRAM_NOTIFY_BOT_TOKEN = "token";
		process.env.TELEGRAM_NOTIFY_CHAT_ID = "10";
		let release: (() => void) | undefined;
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls++;
				if (calls <= 3) return new Response(JSON.stringify({ ok: true, result: calls === 1 ? [] : { message_id: 1 } }));
				if (calls === 4) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return new Response(JSON.stringify({ ok: true, result: [] }));
				}
				return new Response(JSON.stringify({ ok: true, result: true }));
			}),
		);
		const r = registry();
		telegramQuestionBridge(r.pi);
		const ctx = context("guard");
		await r.tool("question_channel").execute("x", { channel: "telegram" }, undefined, undefined, ctx);
		const controller = new AbortController();
		const first = ctx.ui.askUserQuestion(
			{ questions: [{ id: "x", type: "text", prompt: "x" }] },
			{ signal: controller.signal },
		);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await expect(ctx.ui.askUserQuestion({ questions: [] })).rejects.toThrow("한 번에 하나만");
		controller.abort();
		release?.();
		await expect(first).resolves.toBeUndefined();
	});
});
