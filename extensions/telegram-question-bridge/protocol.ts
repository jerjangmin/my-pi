export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

export class FrameTooLargeError extends Error {
	constructor(readonly maxFrameBytes: number) {
		super(`NDJSON frame exceeds ${maxFrameBytes} UTF-8 bytes`);
		this.name = "FrameTooLargeError";
	}
}

export type AnswerValue = string | string[];
export type QuestionType = "radio" | "checkbox" | "text";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface NormalizedQuestion {
	id: string;
	type: QuestionType;
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: AnswerValue;
}

export interface QuestionRequest {
	title?: string;
	description?: string;
	questions: NormalizedQuestion[];
}

export type ClientMessage =
	| {
			type: "ask";
			protocolVersion: typeof PROTOCOL_VERSION;
			requestId: string;
			clientId: string;
			sessionId: string;
			sessionName?: string;
			expiresAt: number;
			request: QuestionRequest;
	  }
	| {
			type: "cancel";
			protocolVersion: typeof PROTOCOL_VERSION;
			requestId: string;
			clientId: string;
			reason?: string;
	  }
	| { type: "ping"; protocolVersion: typeof PROTOCOL_VERSION; clientId: string };

export type BrokerMessage =
	| { type: "accepted"; requestId: string }
	| { type: "answer"; requestId: string; values: Record<string, AnswerValue> }
	| { type: "cancelled"; requestId: string; reason?: string }
	| { type: "expired"; requestId: string }
	| { type: "error"; requestId?: string; code: string; message: string }
	| { type: "pong" };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isAnswerValue(value: unknown): value is AnswerValue {
	return typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isQuestionOption(value: unknown): value is QuestionOption {
	return (
		isRecord(value) &&
		isNonEmptyString(value.value) &&
		isNonEmptyString(value.label) &&
		isOptionalString(value.description)
	);
}

function isNormalizedQuestion(value: unknown): value is NormalizedQuestion {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.prompt) ||
		(value.type !== "radio" && value.type !== "checkbox" && value.type !== "text") ||
		!isOptionalString(value.label) ||
		!isOptionalString(value.placeholder) ||
		(value.allowOther !== undefined && typeof value.allowOther !== "boolean") ||
		(value.required !== undefined && typeof value.required !== "boolean") ||
		(value.default !== undefined && !isAnswerValue(value.default))
	) {
		return false;
	}

	return value.options === undefined || (Array.isArray(value.options) && value.options.every(isQuestionOption));
}

function isQuestionRequest(value: unknown): value is QuestionRequest {
	if (
		!isRecord(value) ||
		!isOptionalString(value.title) ||
		!isOptionalString(value.description) ||
		!Array.isArray(value.questions) ||
		value.questions.length === 0 ||
		!value.questions.every(isNormalizedQuestion)
	) {
		return false;
	}

	const ids = new Set<string>();
	for (const question of value.questions) {
		if (ids.has(question.id)) return false;
		ids.add(question.id);
	}
	return true;
}

function hasProtocolVersion(
	value: UnknownRecord,
): value is UnknownRecord & { protocolVersion: typeof PROTOCOL_VERSION } {
	return value.protocolVersion === PROTOCOL_VERSION;
}

export function parseClientMessage(value: unknown): ClientMessage | undefined {
	if (!isRecord(value) || !hasProtocolVersion(value) || typeof value.type !== "string") return undefined;

	switch (value.type) {
		case "ask":
			if (
				isNonEmptyString(value.requestId) &&
				isNonEmptyString(value.clientId) &&
				isNonEmptyString(value.sessionId) &&
				isOptionalString(value.sessionName) &&
				typeof value.expiresAt === "number" &&
				Number.isFinite(value.expiresAt) &&
				value.expiresAt > 0 &&
				isQuestionRequest(value.request)
			) {
				return value as ClientMessage;
			}
			return undefined;
		case "cancel":
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.clientId) && isOptionalString(value.reason)
				? (value as ClientMessage)
				: undefined;
		case "ping":
			return isNonEmptyString(value.clientId) ? (value as ClientMessage) : undefined;
		default:
			return undefined;
	}
}

export function parseBrokerMessage(value: unknown): BrokerMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;

	switch (value.type) {
		case "accepted":
		case "expired":
			return isNonEmptyString(value.requestId) ? (value as BrokerMessage) : undefined;
		case "answer":
			if (!isNonEmptyString(value.requestId) || !isRecord(value.values)) return undefined;
			return Object.values(value.values).every(isAnswerValue) ? (value as BrokerMessage) : undefined;
		case "cancelled":
			return isNonEmptyString(value.requestId) && isOptionalString(value.reason) ? (value as BrokerMessage) : undefined;
		case "error":
			return (value.requestId === undefined || isNonEmptyString(value.requestId)) &&
				isNonEmptyString(value.code) &&
				isNonEmptyString(value.message)
				? (value as BrokerMessage)
				: undefined;
		case "pong":
			return Object.keys(value).length === 1 ? { type: "pong" } : undefined;
		default:
			return undefined;
	}
}

export function encodeFrame(message: ClientMessage | BrokerMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export interface FrameDecoder<T> {
	push(chunk: string | Uint8Array): T[];
}

export function createFrameDecoder<T>(
	parse: (value: unknown) => T | undefined,
	maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): FrameDecoder<T> {
	if (!Number.isFinite(maxFrameBytes) || !Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
		throw new RangeError("maxFrameBytes must be a positive finite integer");
	}

	let remainderParts: string[] = [];
	let remainderBytes = 0;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	function byteLength(segment: string): number {
		return encoder.encode(segment).byteLength;
	}

	function appendRemainder(segment: string, segmentBytes: number): void {
		if (remainderBytes + segmentBytes > maxFrameBytes) throw new FrameTooLargeError(maxFrameBytes);
		remainderParts.push(segment);
		remainderBytes += segmentBytes;
	}

	function takeRemainder(): string {
		const frame = remainderParts.join("");
		remainderParts = [];
		remainderBytes = 0;
		return frame;
	}

	function parseFrame(frame: string, messages: T[]): void {
		const trimmed = frame.trim();
		if (!trimmed) return;
		try {
			const message = parse(JSON.parse(trimmed));
			if (message !== undefined) messages.push(message);
		} catch {
			// Invalid frames are untrusted input and are ignored.
		}
	}

	return {
		push(chunk) {
			const decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			const segments = decoded.split("\n");
			const messages: T[] = [];

			appendRemainder(segments[0] ?? "", byteLength(segments[0] ?? ""));
			if (segments.length === 1) return messages;

			parseFrame(takeRemainder(), messages);

			for (let index = 1; index < segments.length - 1; index += 1) {
				const frame = segments[index] ?? "";
				if (byteLength(frame) > maxFrameBytes) throw new FrameTooLargeError(maxFrameBytes);
				parseFrame(frame, messages);
			}

			const finalSegment = segments.at(-1) ?? "";
			appendRemainder(finalSegment, byteLength(finalSegment));
			return messages;
		},
	};
}
