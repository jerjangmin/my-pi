export type TelegramConfig = { botToken: string; chatId: string; userId: string };
export type QuestionOption = { value: string; label: string; description?: string };
export type Question = {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
};
export type QuestionRequest = { title?: string; description?: string; questions: Question[] };
type Fetch = typeof fetch;
type Message = {
	message_id?: number;
	text?: string;
	chat?: { id?: string | number };
	reply_to_message?: { message_id?: number };
};
type Callback = { id?: string; data?: string; from?: { id?: string | number }; message?: Message };
type Update = {
	update_id?: number;
	message?: Message & { from?: { id?: string | number } };
	callback_query?: Callback;
};
type Options = { signal?: AbortSignal; fetch?: Fetch };
type Answer = { value: unknown; offset: number };

const MAX_TEXT = 4096;
let nonceCounter = 0;

function display(value: string | undefined, limit = MAX_TEXT): string {
	return (value ?? "").slice(0, limit);
}

function key(text: string, callback_data: string) {
	return { text: text.slice(0, 64), callback_data };
}

function stringDefault(question: Question): string | undefined {
	return typeof question.default === "string" ? question.default : undefined;
}

function keyboard(question: Question, nonce: string, selected = new Set<string>()) {
	const rows = (question.options ?? []).map((option, index) => [
		key(
			question.type === "checkbox" && selected.has(option.value) ? `☑ ${option.label}` : option.label,
			`${nonce}:o:${index}`,
		),
	]);
	if (question.type === "checkbox") rows.push([key("선택 완료", `${nonce}:done`)]);
	if (question.allowOther) rows.push([key("기타 입력", `${nonce}:other`)]);
	if (!question.required) rows.push([key("건너뛰기", `${nonce}:skip`)]);
	if (stringDefault(question) !== undefined && (question.type === "radio" || question.type === "text")) {
		rows.push([key("기본값 사용", `${nonce}:default`)]);
	}
	rows.push([key("취소", `${nonce}:cancel`)]);
	return { inline_keyboard: rows };
}

function questionText(question: Question, heading: string): string {
	const label = display(question.label, 1024);
	const prompt = display(question.prompt, 2048);
	const required = [label, prompt].filter(Boolean).join("\n\n");
	const options = (question.options ?? [])
		.map((option) => `${option.label}${option.description ? ` — ${option.description}` : ""}`)
		.join("\n");
	const tailLimit = MAX_TEXT - required.length - (required ? 2 : 0);
	const optionText = display(options, tailLimit);
	const optional = [optionText, display(heading, tailLimit - optionText.length - (optionText ? 2 : 0))]
		.filter(Boolean)
		.join("\n\n");
	return [optional, required].filter(Boolean).join("\n\n");
}

export function forceReply(question: Question) {
	const placeholder = display(question.placeholder?.trim(), 64);
	return placeholder ? { force_reply: true, input_field_placeholder: placeholder } : { force_reply: true };
}

async function api(
	fetcher: Fetch,
	config: TelegramConfig,
	method: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
) {
	let response: Response;
	try {
		response = await fetcher(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	} catch {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		throw new Error(`Telegram ${method} 요청에 실패했습니다.`);
	}
	const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
	if (!response.ok || !payload.ok)
		throw new Error(`Telegram ${method} 실패: ${response.status} ${payload.description ?? ""}`.trim());
	return payload.result;
}

function authorized(update: Update, config: TelegramConfig): boolean {
	if (update.callback_query) {
		return (
			String(update.callback_query.message?.chat?.id) === config.chatId &&
			String(update.callback_query.from?.id) === config.userId
		);
	}
	return String(update.message?.chat?.id) === config.chatId && String(update.message?.from?.id) === config.userId;
}

async function updates(
	fetcher: Fetch,
	config: TelegramConfig,
	offset: number,
	signal?: AbortSignal,
): Promise<Update[]> {
	return (await api(
		fetcher,
		config,
		"getUpdates",
		{ offset, timeout: 20, allowed_updates: ["message", "callback_query"] },
		signal,
	)) as Update[];
}

async function clearKeyboard(fetcher: Fetch, config: TelegramConfig, messageId: number | undefined) {
	if (messageId === undefined) return;
	await api(
		fetcher,
		config,
		"editMessageReplyMarkup",
		{ chat_id: config.chatId, message_id: messageId, reply_markup: {} },
		AbortSignal.timeout(1500),
	).catch(() => undefined);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One sequential loop keeps direct polling state local without a state machine.
async function askOne(
	fetcher: Fetch,
	config: TelegramConfig,
	question: Question,
	heading: string,
	offset: number,
	signal?: AbortSignal,
): Promise<Answer> {
	const nonce = (++nonceCounter).toString(36);
	const selected = new Set(
		question.type === "checkbox" && Array.isArray(question.default)
			? question.default.filter((value): value is string => typeof value === "string")
			: [],
	);
	const message = (await api(
		fetcher,
		config,
		"sendMessage",
		{
			chat_id: config.chatId,
			text: questionText(question, heading),
			reply_markup: question.type === "text" ? forceReply(question) : keyboard(question, nonce, selected),
		},
		signal,
	)) as Message;
	let replyMessageId = question.type === "text" ? message.message_id : undefined;
	let keyboardMessageId = message.message_id;
	let callbackMessageId = message.message_id;
	if (question.type === "text") {
		const controls = (await api(
			fetcher,
			config,
			"sendMessage",
			{
				chat_id: config.chatId,
				text: "입력을 취소하거나 기본값을 선택할 수 있습니다.",
				reply_markup: keyboard(question, nonce, selected),
			},
			signal,
		)) as Message;
		keyboardMessageId = controls.message_id;
		callbackMessageId = controls.message_id;
	}
	let nextOffset = offset;
	const finish = (value: unknown): Answer => ({ value, offset: nextOffset });

	try {
		while (!signal?.aborted) {
			const batch = await updates(fetcher, config, nextOffset, signal);
			for (const update of batch) {
				if (typeof update.update_id === "number") nextOffset = Math.max(nextOffset, update.update_id + 1);
				if (!authorized(update, config)) continue;
				const callback = update.callback_query;
				if (callback) {
					const action = callback.data?.startsWith(`${nonce}:`) ? callback.data.slice(nonce.length + 1) : "";
					if (callback.message?.message_id !== callbackMessageId || !action) {
						await api(
							fetcher,
							config,
							"answerCallbackQuery",
							{ callback_query_id: callback.id, text: "만료된 질문입니다." },
							signal,
						);
						continue;
					}
					if (action === "done" && question.type === "checkbox" && question.required && selected.size === 0) {
						await api(
							fetcher,
							config,
							"answerCallbackQuery",
							{ callback_query_id: callback.id, text: "하나 이상 선택해 주세요." },
							signal,
						);
						continue;
					}
					await api(fetcher, config, "answerCallbackQuery", { callback_query_id: callback.id }, signal);
					if (action === "cancel") return finish(undefined);
					if (action === "skip") return finish(question.type === "checkbox" ? [] : "");
					if (action === "default") return finish(stringDefault(question));
					if (action === "done") return finish([...selected]);
					if (action === "other") {
						await clearKeyboard(fetcher, config, keyboardMessageId);
						keyboardMessageId = undefined;
						const custom = (await api(
							fetcher,
							config,
							"sendMessage",
							{
								chat_id: config.chatId,
								text: "기타 답변을 입력해 주세요.",
								reply_markup: { force_reply: true },
							},
							signal,
						)) as Message;
						replyMessageId = custom.message_id;
						callbackMessageId = undefined;
						continue;
					}
					const match = /^o:(\d+)$/.exec(action);
					const option = match ? question.options?.[Number(match[1])] : undefined;
					if (!option) continue;
					if (question.type !== "checkbox") return finish(option.value);
					if (selected.has(option.value)) selected.delete(option.value);
					else selected.add(option.value);
					await api(
						fetcher,
						config,
						"editMessageReplyMarkup",
						{
							chat_id: config.chatId,
							message_id: callbackMessageId,
							reply_markup: keyboard(question, nonce, selected),
						},
						signal,
					);
					continue;
				}
				const incoming = update.message;
				if (incoming?.text === "/cancel") return finish(undefined);
				if (
					incoming &&
					replyMessageId !== undefined &&
					incoming.reply_to_message?.message_id === replyMessageId &&
					typeof incoming.text === "string"
				) {
					const value = incoming.text.trim();
					if (question.required && !value) {
						const retry = (await api(
							fetcher,
							config,
							"sendMessage",
							{ chat_id: config.chatId, text: "답변을 입력해 주세요.", reply_markup: forceReply(question) },
							signal,
						)) as Message;
						replyMessageId = retry.message_id;
						continue;
					}
					if (question.type === "checkbox") return finish(value ? [...selected, value] : [...selected]);
					return finish(value);
				}
			}
		}
		return finish(undefined);
	} finally {
		await clearKeyboard(fetcher, config, keyboardMessageId);
	}
}

export async function askViaTelegram(
	config: TelegramConfig,
	request: QuestionRequest,
	{ signal, fetch: fetcher = fetch }: Options = {},
): Promise<Record<string, unknown> | undefined> {
	try {
		if (signal?.aborted) return undefined;
		const stale = (await api(fetcher, config, "getUpdates", { offset: -1, timeout: 0 }, signal)) as Update[];
		let offset = stale.reduce(
			(current, update) => (typeof update.update_id === "number" ? Math.max(current, update.update_id + 1) : current),
			0,
		);
		const result: Record<string, unknown> = Object.create(null);
		const heading = display([request.title, request.description].filter(Boolean).join("\n\n"));
		for (const question of request.questions) {
			const answer = await askOne(fetcher, config, question, heading, offset, signal);
			offset = answer.offset;
			if (answer.value === undefined) return undefined;
			Object.defineProperty(result, question.id, {
				value: answer.value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return result;
	} catch (error) {
		if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return undefined;
		throw error;
	}
}
