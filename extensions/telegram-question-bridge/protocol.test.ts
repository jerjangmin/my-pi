import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_FRAME_BYTES,
	FrameTooLargeError,
	PROTOCOL_VERSION,
	createFrameDecoder,
	encodeFrame,
	parseBrokerMessage,
	parseClientMessage,
	type BrokerMessage,
	type ClientMessage,
} from "./protocol.js";

const question = {
	id: "color",
	type: "radio" as const,
	prompt: "Pick a color",
	options: [{ value: "blue", label: "Blue", description: "Cool" }],
	required: true,
};

const ask: ClientMessage = {
	type: "ask",
	protocolVersion: PROTOCOL_VERSION,
	requestId: "request-1",
	clientId: "client-1",
	sessionId: "session-1",
	sessionName: "Work",
	expiresAt: Date.now() + 60_000,
	request: { title: "Preferences", description: "One question", questions: [question] },
};

describe("telegram question bridge protocol", () => {
	it("encodes newline-delimited JSON and decodes multiple frames in one chunk", () => {
		const decoder = createFrameDecoder(parseClientMessage);
		const chunk = `${encodeFrame(ask)}${encodeFrame({
			type: "ping",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client-1",
		} satisfies ClientMessage)}`;

		expect(decoder.push(chunk)).toEqual([
			ask,
			{ type: "ping", protocolVersion: PROTOCOL_VERSION, clientId: "client-1" },
		]);
	});

	it("buffers split frames and ignores blank lines", () => {
		const decoder = createFrameDecoder(parseBrokerMessage);
		const frame = encodeFrame({ type: "accepted", requestId: "request-1" } satisfies BrokerMessage);

		expect(decoder.push(`\n${frame.slice(0, 10)}`)).toEqual([]);
		expect(decoder.push(`${frame.slice(10)}\n\r\n`)).toEqual([{ type: "accepted", requestId: "request-1" }]);
	});

	it("rejects frames above the UTF-8 byte limit without losing frame boundaries", () => {
		const decoder = createFrameDecoder(parseBrokerMessage, 4);
		expect(() => decoder.push('{"x":')).toThrow(FrameTooLargeError);

		const utf8Decoder = createFrameDecoder(parseBrokerMessage, 6);
		expect(utf8Decoder.push("한")).toEqual([]);
		expect(() => utf8Decoder.push("글한")).toThrow(FrameTooLargeError);

		const multiFrameDecoder = createFrameDecoder(parseBrokerMessage, 20);
		expect(multiFrameDecoder.push('{"type":"pong"}\n')).toEqual([{ type: "pong" }]);
		expect(() => multiFrameDecoder.push(`${"x".repeat(21)}\n`)).toThrow(FrameTooLargeError);
		expect(() => createFrameDecoder(parseBrokerMessage, 0)).toThrow(RangeError);
		expect(() => createFrameDecoder(parseBrokerMessage, 1.5)).toThrow(RangeError);
		expect(() => createFrameDecoder(parseBrokerMessage, Number.POSITIVE_INFINITY)).toThrow(RangeError);
		expect(DEFAULT_MAX_FRAME_BYTES).toBe(256 * 1024);
	});

	it("rejects malformed JSON and messages that do not satisfy the protocol", () => {
		const decoder = createFrameDecoder(parseClientMessage);
		expect(decoder.push('{"type":"ping"}\nnot-json\n')).toEqual([]);
		expect(parseClientMessage({ type: "ping", protocolVersion: 2, clientId: "client-1" })).toBeUndefined();
		expect(
			parseClientMessage({
				type: "ask",
				protocolVersion: 1,
				requestId: "",
				clientId: "c",
				sessionId: "s",
				expiresAt: 1,
				request: { questions: [] },
			}),
		).toBeUndefined();
		expect(
			parseClientMessage({
				type: "ask",
				protocolVersion: 1,
				requestId: "r",
				clientId: "c",
				sessionId: "s",
				expiresAt: Number.POSITIVE_INFINITY,
				request: { questions: [] },
			}),
		).toBeUndefined();
	});

	it("validates questions and answer values from untrusted input", () => {
		expect(parseClientMessage(ask)).toEqual(ask);
		expect(parseClientMessage({ ...ask, request: { questions: [] } })).toBeUndefined();
		expect(
			parseClientMessage({ ...ask, request: { questions: [question, { ...question, prompt: "Duplicate" }] } }),
		).toBeUndefined();
		expect(parseClientMessage({ ...ask, request: { questions: [{ ...question, type: "invalid" }] } })).toBeUndefined();
		expect(
			parseBrokerMessage({ type: "answer", requestId: "request-1", values: { color: ["blue", "green"] } }),
		).toEqual({
			type: "answer",
			requestId: "request-1",
			values: { color: ["blue", "green"] },
		});
		expect(parseBrokerMessage({ type: "answer", requestId: "request-1", values: { color: 3 } })).toBeUndefined();
	});

	it("validates every client and broker message shape", () => {
		expect(
			parseClientMessage({ type: "cancel", protocolVersion: 1, requestId: "r", clientId: "c", reason: "aborted" }),
		).toEqual({
			type: "cancel",
			protocolVersion: 1,
			requestId: "r",
			clientId: "c",
			reason: "aborted",
		});
		expect(parseBrokerMessage({ type: "cancelled", requestId: "r", reason: "user" })).toEqual({
			type: "cancelled",
			requestId: "r",
			reason: "user",
		});
		expect(parseBrokerMessage({ type: "expired", requestId: "r" })).toEqual({ type: "expired", requestId: "r" });
		expect(parseBrokerMessage({ type: "error", code: "unavailable", message: "Broker unavailable" })).toEqual({
			type: "error",
			code: "unavailable",
			message: "Broker unavailable",
		});
		expect(
			parseBrokerMessage({ type: "error", requestId: "", code: "unavailable", message: "Broker unavailable" }),
		).toBeUndefined();
		expect(parseBrokerMessage({ type: "pong" })).toEqual({ type: "pong" });
	});
});
