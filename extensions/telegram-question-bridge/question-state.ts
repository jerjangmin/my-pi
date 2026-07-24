import type { AnswerValue, NormalizedQuestion, QuestionRequest } from "./protocol.js";

export type QuestionStatus = "active" | "answered" | "cancelled" | "expired";

export interface QuestionState {
	status: QuestionStatus;
	questions: NormalizedQuestion[];
	currentQuestionIndex: number;
	answers: Record<string, AnswerValue>;
	checkboxValues: string[];
}

export type QuestionAction =
	| { type: "select-radio"; value: string }
	| { type: "toggle-checkbox"; value: string }
	| { type: "submit-checkbox" }
	| { type: "submit-text"; value: string }
	| { type: "submit-default" }
	| { type: "skip" }
	| { type: "cancel" }
	| { type: "expire" };

export interface QuestionTransition {
	state: QuestionState;
	error?: string;
}

function cloneQuestion(question: NormalizedQuestion): NormalizedQuestion {
	return {
		...question,
		options: question.options?.map((option) => ({ ...option })),
		default: Array.isArray(question.default) ? [...question.default] : question.default,
	};
}

function defaultForQuestion(question: NormalizedQuestion): AnswerValue | undefined {
	if (question.type === "checkbox" && Array.isArray(question.default)) {
		return [...new Set(question.default)];
	}
	if (question.type === "text" && typeof question.default === "string") return question.default;
	if (
		question.type === "radio" &&
		typeof question.default === "string" &&
		question.options?.some((option) => option.value === question.default)
	) {
		return question.default;
	}
	return undefined;
}

function cloneAnswerValue(value: AnswerValue): AnswerValue {
	return Array.isArray(value) ? [...value] : value;
}

function defineAnswer(answers: Record<string, AnswerValue>, id: string, value: AnswerValue): void {
	Object.defineProperty(answers, id, {
		value: cloneAnswerValue(value),
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function createAnswerMap(entries?: Record<string, AnswerValue>): Record<string, AnswerValue> {
	const answers = Object.create(null) as Record<string, AnswerValue>;
	if (!entries) return answers;
	for (const [id, value] of Object.entries(entries)) defineAnswer(answers, id, value);
	return answers;
}

function withAnswer(answers: Record<string, AnswerValue>, id: string, value: AnswerValue): Record<string, AnswerValue> {
	const next = createAnswerMap(answers);
	defineAnswer(next, id, value);
	return next;
}

function initialAnswers(questions: NormalizedQuestion[]): Record<string, AnswerValue> {
	const answers = createAnswerMap();
	for (const question of questions) {
		const defaultValue = defaultForQuestion(question);
		if (defaultValue !== undefined) defineAnswer(answers, question.id, defaultValue);
	}
	return answers;
}

function checkboxValuesFor(
	questions: NormalizedQuestion[],
	currentQuestionIndex: number,
	answers: Record<string, AnswerValue>,
): string[] {
	const question = questions[currentQuestionIndex];
	const answer = question?.type === "checkbox" ? answers[question.id] : undefined;
	return Array.isArray(answer) ? [...answer] : [];
}

export function createQuestionState(request: QuestionRequest): QuestionState {
	const questions = request.questions.map(cloneQuestion);
	const answers = initialAnswers(questions);
	return {
		status: questions.length === 0 ? "answered" : "active",
		questions,
		currentQuestionIndex: 0,
		answers,
		checkboxValues: checkboxValuesFor(questions, 0, answers),
	};
}

function terminalError(status: Exclude<QuestionStatus, "active">): string {
	return `Question is already ${status}`;
}

function completeOrAdvance(state: QuestionState, answers: Record<string, AnswerValue>): QuestionState {
	const currentQuestionIndex = state.currentQuestionIndex + 1;
	return {
		...state,
		status: currentQuestionIndex === state.questions.length ? "answered" : "active",
		currentQuestionIndex,
		answers,
		checkboxValues: checkboxValuesFor(state.questions, currentQuestionIndex, answers),
	};
}

function answerCurrent(state: QuestionState, value: AnswerValue): QuestionState {
	const question = state.questions[state.currentQuestionIndex];
	if (!question) return state;
	return completeOrAdvance(state, withAnswer(state.answers, question.id, value));
}

function submitDefault(state: QuestionState, question: NormalizedQuestion): QuestionTransition {
	const defaultValue = defaultForQuestion(question);
	if (defaultValue === undefined) return { state, error: "No valid default" };
	if (
		question.required &&
		(typeof defaultValue === "string" ? defaultValue.trim().length === 0 : defaultValue.length === 0)
	) {
		return { state, error: "Question is required" };
	}
	return { state: answerCurrent(state, defaultValue) };
}

export function transitionQuestionState(state: QuestionState, action: QuestionAction): QuestionTransition {
	if (state.status !== "active") return { state, error: terminalError(state.status) };

	if (action.type === "cancel") return { state: { ...state, status: "cancelled", checkboxValues: [] } };
	if (action.type === "expire") return { state: { ...state, status: "expired", checkboxValues: [] } };

	const question = state.questions[state.currentQuestionIndex];
	if (!question) return { state, error: "No active question" };

	if (action.type === "skip") {
		return question.required
			? { state, error: "Question is required" }
			: { state: completeOrAdvance(state, state.answers) };
	}
	if (action.type === "submit-default") return submitDefault(state, question);

	switch (action.type) {
		case "select-radio":
			return question.type === "radio"
				? { state: answerCurrent(state, action.value) }
				: { state, error: "Active question is not radio" };
		case "toggle-checkbox": {
			if (question.type !== "checkbox") return { state, error: "Active question is not checkbox" };
			const checkboxValues = state.checkboxValues.includes(action.value)
				? state.checkboxValues.filter((value) => value !== action.value)
				: [...state.checkboxValues, action.value];
			return { state: { ...state, checkboxValues } };
		}
		case "submit-checkbox":
			if (question.type !== "checkbox") return { state, error: "Active question is not checkbox" };
			if (question.required && state.checkboxValues.length === 0) return { state, error: "Question is required" };
			return { state: answerCurrent(state, state.checkboxValues) };
		case "submit-text":
			if (question.type !== "text") return { state, error: "Active question is not text" };
			if (question.required && action.value.trim().length === 0) return { state, error: "Question is required" };
			return { state: answerCurrent(state, action.value) };
	}
}
