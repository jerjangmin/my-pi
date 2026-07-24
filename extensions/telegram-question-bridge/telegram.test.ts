import { describe, expect, it, vi } from "vitest";
import { askViaTelegram, forceReply, type QuestionRequest, type TelegramConfig } from "./telegram.ts";

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
	it("omits empty ForceReply placeholders and limits non-empty placeholders", () => {
		expect(forceReply({ id: "x", type: "text", prompt: "x" })).toEqual({ force_reply: true });
		expect(forceReply({ id: "x", type: "text", prompt: "x", placeholder: "  " })).toEqual({ force_reply: true });
		expect(
			forceReply({ id: "x", type: "text", prompt: "x", placeholder: "x".repeat(100) }).input_field_placeholder,
		).toHaveLength(64);
	});

	it("returns radio values and acknowledges callbacks", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			if (poll++ === 0) return [];
			return [
				{
					update_id: 2,
					callback_query: {
						id: "ack",
						data: callback(calls, ":o:0"),
						from: { id: 20 },
						message: { message_id: 100, chat: { id: 10 } },
					},
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
						message: { message_id: 100, chat: { id: 10 } },
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
							message: { message_id: 100, chat: { id: 10 } },
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
		expect(
			calls.some(
				(call) =>
					call.method === "editMessageReplyMarkup" &&
					call.body.message_id === 100 &&
					JSON.stringify(call.body.reply_markup) === "{}",
			),
		).toBe(true);
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
						message: { message_id: 101, chat: { id: 10 } },
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

	it("stores hostile question ids as own properties", async () => {
		let poll = 0;
		let sent = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			return [
				{
					update_id: poll,
					callback_query: {
						id: `${poll}`,
						data: callback(mock.calls, ":o:0"),
						from: { id: 20 },
						message: { message_id: 100 + sent - 1, chat: { id: 10 } },
					},
				},
			];
		});
		const original = mock.fetch.getMockImplementation();
		mock.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/sendMessage")) sent++;
			return original?.(url, init) as Promise<Response>;
		});
		const questions = ["__proto__", "constructor", "prototype"].map((id) => ({
			id,
			type: "radio" as const,
			prompt: id,
			options: [{ value: id, label: id }],
		}));
		const result = await askViaTelegram(config, { questions }, { fetch: mock.fetch as any });
		expect(Object.getPrototypeOf(result)).toBeNull();
		for (const id of ["__proto__", "constructor", "prototype"]) expect(Object.hasOwn(result ?? {}, id)).toBe(true);
	});

	it("ignores stale callback messages and clears the completed keyboard", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			const data = callback(calls, ":o:0");
			return [
				{
					update_id: 2,
					callback_query: { id: "stale", data, from: { id: 20 }, message: { message_id: 99, chat: { id: 10 } } },
				},
				{
					update_id: 3,
					callback_query: { id: "live", data, from: { id: 20 }, message: { message_id: 100, chat: { id: 10 } } },
				},
			];
		});
		calls = mock.calls;
		await expect(
			askViaTelegram(config, request({ id: "x", type: "radio", prompt: "x", options: [{ value: "v", label: "v" }] }), {
				fetch: mock.fetch as any,
			}),
		).resolves.toEqual({ x: "v" });
		expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(2);
		expect(calls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "만료된 질문입니다.")).toBe(
			true,
		);
		expect(
			calls.some((call) => call.method === "editMessageReplyMarkup" && JSON.stringify(call.body.reply_markup) === "{}"),
		).toBe(true);
	});

	it("uses safe text placeholders, defaults, option descriptions, and checkbox custom answers", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			const suffix = poll === 2 ? ":o:0" : poll === 3 ? ":other" : ":default";
			if (poll === 4)
				return [
					{
						update_id: 4,
						message: { text: "custom", from: { id: 20 }, chat: { id: 10 }, reply_to_message: { message_id: 101 } },
					},
				];
			return [
				{
					update_id: poll,
					callback_query: {
						id: `${poll}`,
						data: callback(calls, suffix),
						from: { id: 20 },
						message: { message_id: 100, chat: { id: 10 } },
					},
				},
			];
		});
		calls = mock.calls;
		const result = await askViaTelegram(
			config,
			request({
				id: "box",
				type: "checkbox",
				prompt: "Pick",
				allowOther: true,
				options: [{ value: "a", label: "A", description: "detail" }],
			}),
			{ fetch: mock.fetch as any },
		);
		expect(result).toEqual({ box: ["a", "custom"] });
		expect(String(calls.find((call) => call.method === "sendMessage")?.body.text)).toContain("A — detail");
		let textCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let textPoll = 0;
		const textMock = mockTelegram(() => {
			textPoll++;
			if (textPoll === 1) return [];
			return [
				{
					update_id: 2,
					callback_query: {
						id: "cancel",
						data: callback(textCalls, ":cancel"),
						from: { id: 20 },
						message: { message_id: 101, chat: { id: 10 } },
					},
				},
			];
		});
		textCalls = textMock.calls;
		await expect(
			askViaTelegram(
				config,
				request({ id: "text", type: "text", prompt: "x", placeholder: "x".repeat(100), default: ["bad"] }),
				{ fetch: textMock.fetch as any },
			),
		).resolves.toBeUndefined();
		const force = textCalls[1]?.body.reply_markup as { input_field_placeholder?: string };
		expect(force.input_field_placeholder).toHaveLength(64);
		expect(JSON.stringify(textCalls[2]?.body.reply_markup)).not.toContain("default");
	});

	it("uses only string defaults for radio and text controls", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			return [
				{
					update_id: 2,
					callback_query: {
						id: "default",
						data: callback(calls, ":default"),
						from: { id: 20 },
						message: { message_id: 100, chat: { id: 10 } },
					},
				},
			];
		});
		calls = mock.calls;
		await expect(
			askViaTelegram(config, request({ id: "default", type: "radio", prompt: "x", default: "fallback" }), {
				fetch: mock.fetch as any,
			}),
		).resolves.toEqual({ default: "fallback" });
	});

	it("keeps required empty checkbox open and allows optional empty selection", async () => {
		let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		let poll = 0;
		const mock = mockTelegram(() => {
			poll++;
			if (poll === 1) return [];
			const suffix = poll === 2 ? ":done" : poll === 3 ? ":o:0" : ":done";
			return [
				{
					update_id: poll,
					callback_query: {
						id: `${poll}`,
						data: callback(calls, suffix),
						from: { id: 20 },
						message: { message_id: 100, chat: { id: 10 } },
					},
				},
			];
		});
		calls = mock.calls;
		await expect(
			askViaTelegram(
				config,
				request({
					id: "required",
					type: "checkbox",
					prompt: "x",
					required: true,
					options: [{ value: "a", label: "A" }],
				}),
				{ fetch: mock.fetch as any },
			),
		).resolves.toEqual({ required: ["a"] });
		expect(
			calls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "하나 이상 선택해 주세요."),
		).toBe(true);
		let optionalPoll = 0;
		let optionalCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
		const optional = mockTelegram(() => {
			optionalPoll++;
			if (optionalPoll === 1) return [];
			return [
				{
					update_id: 2,
					callback_query: {
						id: "done",
						data: callback(optionalCalls, ":done"),
						from: { id: 20 },
						message: { message_id: 100, chat: { id: 10 } },
					},
				},
			];
		});
		optionalCalls = optional.calls;
		await expect(
			askViaTelegram(config, request({ id: "optional", type: "checkbox", prompt: "x" }), {
				fetch: optional.fetch as any,
			}),
		).resolves.toEqual({ optional: [] });
	});

	it("returns undefined when a long poll is aborted mid-flight", async () => {
		const controller = new AbortController();
		let calls = 0;
		const fetch = vi.fn((_url: string, init?: RequestInit) => {
			calls++;
			if (calls === 1) return Promise.resolve(response([]));
			if (calls === 2) return Promise.resolve(response({ message_id: 100 }));
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
			);
		});
		const pending = askViaTelegram(config, request({ id: "x", type: "radio", prompt: "x" }), {
			fetch: fetch as any,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(calls).toBe(3));
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
	});
});
