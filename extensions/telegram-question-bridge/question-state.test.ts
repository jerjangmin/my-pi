import { describe, expect, it } from "vitest";
import { createQuestionState, transitionQuestionState } from "./question-state.js";
import type { QuestionRequest } from "./protocol.js";

const request: QuestionRequest = {
	questions: [
		{
			id: "color",
			type: "radio",
			prompt: "Pick a color",
			options: [{ value: "blue", label: "Blue" }],
			required: true,
		},
		{
			id: "tags",
			type: "checkbox",
			prompt: "Pick tags",
			options: [
				{ value: "fast", label: "Fast" },
				{ value: "safe", label: "Safe" },
			],
			required: false,
		},
		{ id: "note", type: "text", prompt: "Leave a note", required: false, placeholder: "Optional" },
	],
};

describe("question state", () => {
	it("advances radio answers and completes after the last answer", () => {
		const initial = createQuestionState(request);
		const color = transitionQuestionState(initial, { type: "select-radio", value: "custom raw value" }).state;
		expect(color).toMatchObject({ status: "active", currentQuestionIndex: 1, answers: { color: "custom raw value" } });

		const toggled = transitionQuestionState(color, { type: "toggle-checkbox", value: "fast" }).state;
		expect(toggled).toMatchObject({ status: "active", currentQuestionIndex: 1, checkboxValues: ["fast"] });
		expect(toggled.answers).toEqual({ color: "custom raw value" });

		const tags = transitionQuestionState(toggled, { type: "submit-checkbox" }).state;
		expect(tags).toMatchObject({
			status: "active",
			currentQuestionIndex: 2,
			answers: { color: "custom raw value", tags: ["fast"] },
		});
		const complete = transitionQuestionState(tags, { type: "submit-text", value: "raw text" }).state;
		expect(complete).toMatchObject({
			status: "answered",
			currentQuestionIndex: 3,
			answers: { color: "custom raw value", tags: ["fast"], note: "raw text" },
			checkboxValues: [],
		});
	});

	it("requires explicit checkbox submission and permits toggling selections", () => {
		let state = transitionQuestionState(createQuestionState(request), { type: "select-radio", value: "blue" }).state;
		state = transitionQuestionState(state, { type: "toggle-checkbox", value: "fast" }).state;
		state = transitionQuestionState(state, { type: "toggle-checkbox", value: "safe" }).state;
		state = transitionQuestionState(state, { type: "toggle-checkbox", value: "fast" }).state;

		expect(state).toMatchObject({ status: "active", currentQuestionIndex: 1, checkboxValues: ["safe"] });
		expect(transitionQuestionState(state, { type: "submit-checkbox" }).state.answers).toEqual({
			color: "blue",
			tags: ["safe"],
		});
	});

	it("rejects skipping required questions and records optional skips", () => {
		const initial = createQuestionState(request);
		expect(transitionQuestionState(initial, { type: "skip" })).toEqual({
			state: initial,
			error: "Question is required",
		});

		let state = transitionQuestionState(initial, { type: "select-radio", value: "blue" }).state;
		state = transitionQuestionState(state, { type: "skip" }).state;
		expect(state).toMatchObject({ status: "active", currentQuestionIndex: 2, answers: { color: "blue" } });
		expect(transitionQuestionState(state, { type: "skip" }).state).toMatchObject({
			status: "answered",
			answers: { color: "blue" },
		});
	});

	it("allows cancelling and expiring from active state", () => {
		expect(transitionQuestionState(createQuestionState(request), { type: "cancel" }).state.status).toBe("cancelled");
		expect(transitionQuestionState(createQuestionState(request), { type: "expire" }).state.status).toBe("expired");
	});

	it("does not change terminal states", () => {
		const answered = transitionQuestionState(createQuestionState({ questions: [request.questions[0]] }), {
			type: "select-radio",
			value: "blue",
		}).state;
		const result = transitionQuestionState(answered, { type: "cancel" });
		expect(result).toEqual({ state: answered, error: "Question is already answered" });
	});

	it("does not mutate the supplied question request", () => {
		const input = structuredClone(request);
		const state = createQuestionState(input);
		transitionQuestionState(state, { type: "select-radio", value: "blue" });
		expect(input).toEqual(request);
	});
});
