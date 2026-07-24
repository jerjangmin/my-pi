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

export function createQuestionState(request: QuestionRequest): QuestionState {
	return {
		status: request.questions.length === 0 ? "answered" : "active",
		questions: request.questions.map(cloneQuestion),
		currentQuestionIndex: 0,
		answers: {},
		checkboxValues: [],
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
		checkboxValues: [],
	};
}

function answerCurrent(state: QuestionState, value: AnswerValue): QuestionState {
	const question = state.questions[state.currentQuestionIndex];
	if (!question) return state;
	return completeOrAdvance(state, { ...state.answers, [question.id]: Array.isArray(value) ? [...value] : value });
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
			if (question.required && action.value.length === 0) return { state, error: "Question is required" };
			return { state: answerCurrent(state, action.value) };
	}
}
