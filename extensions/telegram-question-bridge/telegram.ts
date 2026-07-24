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
// biome-ignore lint/suspicious/noExplicitAny: Telegram's heterogeneous update payload is intentionally narrowed at each use site.
type Update = Record<string, any>;

type Options = { signal?: AbortSignal; fetch?: Fetch };
const MAX_TEXT = 4096;
let nonceCounter = 0;

function display(value: string | undefined): string {
	return (value ?? "").slice(0, MAX_TEXT);
}

function key(text: string, callback_data: string) {
	return { text: text.slice(0, 64), callback_data };
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
	if (question.default !== undefined && (question.type === "radio" || question.type === "text")) {
		rows.push([key("기본값 사용", `${nonce}:default`)]);
	}
	rows.push([key("취소", `${nonce}:cancel`)]);
	return { inline_keyboard: rows };
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
		throw new Error(`Telegram ${method} 요청에 실패했습니다.`);
	}
	const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
	if (!response.ok || !payload.ok)
		throw new Error(`Telegram ${method} 실패: ${response.status} ${payload.description ?? ""}`.trim());
	return payload.result;
}

function authorized(update: Update, config: TelegramConfig): boolean {
	const source = update.callback_query ?? update.message;
	return (
		String(source?.message?.chat?.id ?? source?.chat?.id) === config.chatId &&
		String(source?.from?.id) === config.userId
	);
}

async function updates(fetcher: Fetch, config: TelegramConfig, offset: number, signal?: AbortSignal) {
	try {
		return (await api(
			fetcher,
			config,
			"getUpdates",
			{ offset, timeout: 20, allowed_updates: ["message", "callback_query"] },
			signal,
		)) as Update[];
	} catch (error) {
		if (signal?.aborted) return [];
		throw error;
	}
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A single sequential interaction loop keeps polling state local and avoids a state machine.
async function askOne(
	fetcher: Fetch,
	config: TelegramConfig,
	question: Question,
	heading: string,
	offset: number,
	signal?: AbortSignal,
) {
	const nonce = (++nonceCounter).toString(36);
	const selected = new Set(
		question.type === "checkbox" && Array.isArray(question.default)
			? question.default.filter((value): value is string => typeof value === "string")
			: [],
	);
	const message = (await api(fetcher, config, "sendMessage", {
		chat_id: config.chatId,
		text: display([heading, question.label, question.prompt].filter(Boolean).join("\n\n")),
		reply_markup:
			question.type === "text"
				? { force_reply: true, input_field_placeholder: display(question.placeholder) }
				: keyboard(question, nonce, selected),
	})) as { message_id?: number };
	let replyMessageId = message.message_id;
	if (question.type === "text") {
		await api(fetcher, config, "sendMessage", {
			chat_id: config.chatId,
			text: "입력을 취소하거나 기본값을 선택할 수 있습니다.",
			reply_markup: keyboard(question, nonce, selected),
		});
	}
	let nextOffset = offset;

	while (!signal?.aborted) {
		const batch = await updates(fetcher, config, nextOffset, signal);
		for (const update of batch) {
			if (typeof update.update_id === "number") nextOffset = Math.max(nextOffset, update.update_id + 1);
			if (!authorized(update, config)) continue;
			const callback = update.callback_query;
			if (callback) {
				await api(fetcher, config, "answerCallbackQuery", { callback_query_id: callback.id });
				const action = callback.data?.startsWith(`${nonce}:`) ? callback.data.slice(nonce.length + 1) : "";
				if (action === "cancel") return { value: undefined, offset: nextOffset };
				if (action === "skip") return { value: question.type === "checkbox" ? [] : "", offset: nextOffset };
				if (action === "default") return { value: question.default, offset: nextOffset };
				if (action === "done") return { value: [...selected], offset: nextOffset };
				if (action === "other") {
					const custom = (await api(fetcher, config, "sendMessage", {
						chat_id: config.chatId,
						text: "기타 답변을 입력해 주세요.",
						reply_markup: { force_reply: true },
					})) as { message_id?: number };
					replyMessageId = custom.message_id;
					continue;
				}
				const match = /^o:(\d+)$/.exec(action);
				if (!match) continue;
				const option = question.options?.[Number(match[1])];
				if (!option) continue;
				if (question.type !== "checkbox") return { value: option.value, offset: nextOffset };
				if (selected.has(option.value)) selected.delete(option.value);
				else selected.add(option.value);
				await api(fetcher, config, "editMessageReplyMarkup", {
					chat_id: config.chatId,
					message_id: message.message_id,
					reply_markup: keyboard(question, nonce, selected),
				}).catch(() => undefined);
				continue;
			}
			const incoming = update.message;
			if (incoming?.text === "/cancel") return { value: undefined, offset: nextOffset };
			if (incoming?.reply_to_message?.message_id === replyMessageId && typeof incoming.text === "string") {
				return { value: incoming.text, offset: nextOffset };
			}
		}
	}
	return { value: undefined, offset: nextOffset };
}

export async function askViaTelegram(
	config: TelegramConfig,
	request: QuestionRequest,
	{ signal, fetch: fetcher = fetch }: Options = {},
): Promise<Record<string, unknown> | undefined> {
	if (signal?.aborted) return undefined;
	const stale = (await api(fetcher, config, "getUpdates", { offset: -1, timeout: 0 })) as Update[];
	let offset = stale.reduce(
		(current, update) => (typeof update.update_id === "number" ? Math.max(current, update.update_id + 1) : current),
		0,
	);
	const result: Record<string, unknown> = {};
	const heading = display([request.title, request.description].filter(Boolean).join("\n\n"));
	for (const question of request.questions) {
		const answer = await askOne(fetcher, config, question, heading, offset, signal);
		offset = answer.offset;
		if (answer.value === undefined) return undefined;
		result[question.id] = answer.value;
	}
	return result;
}
