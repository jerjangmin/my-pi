import { describe, expect, it, vi } from "vitest";
import { askViaTelegram, type QuestionRequest, type TelegramConfig } from "./telegram.ts";

const config: TelegramConfig = { botToken: "secret-token", chatId: "10", userId: "20" };
const request = (question: QuestionRequest["questions"][number]): QuestionRequest => ({
	title: "Title",
	questions: [question],
});

function response(result: unknown, status = 200): Response {
	return new Response(JSON.stringify({ ok: status < 400, result, description: "bad request" }), { status });
}

function mockTelegram(updates: () => unknown[]) {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let messageId = 100;
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const method = url.split("/").pop() ?? "";
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ method, body });
		if (method === "getUpdates") return response(updates());
		if (method === "sendMessage") return response({ message_id: messageId++ });
		return response(true);
	});
	return { calls, fetch };
}

function callback(calls: Array<{ method: string; body: Record<string, unknown> }>, suffix: string) {
	const sent = calls.filter((call) => call.method === "sendMessage").at(-1);
	const rows =
		(sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> }).inline_keyboard ?? [];
	return rows.flat().find((button) => button.callback_data.endsWith(suffix))?.callback_data ?? "missing";
}

describe("askViaTelegram", () => {
	it("returns radio values and acknowledges callbacks", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			if (poll++ === 0) return [];
			return [
				{
					update_id: 2,
					callback_query: { id: "ack", data: callback(calls, ":o:0"), from: { id: 20 }, message: { chat: { id: 10 } } },
				},
			];
		});
		calls = mock.calls;
		await expect(
			askViaTelegram(
				config,
				request({ id: "choice", type: "radio", prompt: "Choose", options: [{ value: "a", label: "A" }] }),
				{ fetch: mock.fetch as any },
			),
		).resolves.toEqual({ choice: "a" });
		expect(mock.calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
	});

	it("toggles checkbox options then submits", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			const suffix = poll === 2 ? ":o:1" : ":done";
			return [
				{
					update_id: poll,
					callback_query: {
						id: `${poll}`,
						data: callback(calls, suffix),
						from: { id: 20 },
						message: { chat: { id: 10 } },
					},
				},
			];
		});
		calls = mock.calls;
		const question = {
			id: "checks",
			type: "checkbox" as const,
			prompt: "Pick",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		};
		await expect(askViaTelegram(config, request(question), { fetch: mock.fetch as any })).resolves.toEqual({
			checks: ["b"],
		});
		expect(mock.calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
	});

	it("accepts only an authorized reply to the question message", async () => {
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			return [
				{
					update_id: 2,
					message: { text: "ignore", from: { id: 99 }, chat: { id: 10 }, reply_to_message: { message_id: 100 } },
				},
				{
					update_id: 3,
					message: { text: "answer", from: { id: 20 }, chat: { id: 10 }, reply_to_message: { message_id: 100 } },
				},
			];
		});
		await expect(
			askViaTelegram(config, request({ id: "text", type: "text", prompt: "Why?" }), { fetch: mock.fetch as any }),
		).resolves.toEqual({ text: "answer" });
	});

	it("collects allowOther text and handles cancellation or abort", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			if (poll === 2)
				return [
					{
						update_id: 2,
						callback_query: {
							id: "other",
							data: callback(calls, ":other"),
							from: { id: 20 },
							message: { chat: { id: 10 } },
						},
					},
				];
			return [
				{
					update_id: 3,
					message: { text: "custom", from: { id: 20 }, chat: { id: 10 }, reply_to_message: { message_id: 101 } },
				},
			];
		});
		calls = mock.calls;
		const radio = {
			id: "r",
			type: "radio" as const,
			prompt: "Pick",
			allowOther: true,
			options: [{ value: "a", label: "A" }],
		};
		await expect(askViaTelegram(config, request(radio), { fetch: mock.fetch as any })).resolves.toEqual({
			r: "custom",
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			askViaTelegram(config, request(radio), { fetch: mock.fetch as any, signal: controller.signal }),
		).resolves.toBeUndefined();
	});

	it("returns undefined when the user presses cancel", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			return [
				{
					update_id: 2,
					callback_query: {
						id: "cancel",
						data: callback(calls, ":cancel"),
						from: { id: 20 },
						message: { chat: { id: 10 } },
					},
				},
			];
		});
		calls = mock.calls;
		await expect(
			askViaTelegram(config, request({ id: "x", type: "text", prompt: "x" }), { fetch: mock.fetch as any }),
		).resolves.toBeUndefined();
	});

	it("does not expose tokens in API errors", async () => {
		const fetch = vi.fn(async () => response({}, 500));
		await expect(
			askViaTelegram(config, request({ id: "x", type: "text", prompt: "x" }), { fetch: fetch as any }),
		).rejects.not.toThrow("secret-token");
	});
});
