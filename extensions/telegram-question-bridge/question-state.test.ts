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

	it("applies source-form defaults and submits each valid current default", () => {
		const defaults: QuestionRequest = {
			questions: [
				{ id: "radio", type: "radio", prompt: "Pick", options: [{ value: "a", label: "A" }], default: "a" },
				{ id: "check", type: "checkbox", prompt: "Pick many", default: ["a", "a", "custom"] },
				{ id: "text", type: "text", prompt: "Explain", default: " raw text " },
			],
		};
		let state = createQuestionState(defaults);
		expect(state.answers).toEqual({ radio: "a", check: ["a", "custom"], text: " raw text " });
		expect(state.checkboxValues).toEqual([]);

		state = transitionQuestionState(state, { type: "submit-default" }).state;
		expect(state).toMatchObject({
			currentQuestionIndex: 1,
			answers: { radio: "a", check: ["a", "custom"] },
			checkboxValues: ["a", "custom"],
		});
		state = transitionQuestionState(state, { type: "submit-default" }).state;
		expect(state).toMatchObject({ currentQuestionIndex: 2, checkboxValues: [] });
		state = transitionQuestionState(state, { type: "submit-default" }).state;
		expect(state).toMatchObject({
			status: "answered",
			answers: { radio: "a", check: ["a", "custom"], text: " raw text " },
		});
	});

	it("rejects invalid defaults, required empty defaults, and whitespace-only required text", () => {
		const invalidRadio = createQuestionState({
			questions: [
				{ id: "radio", type: "radio", prompt: "Pick", options: [{ value: "a", label: "A" }], default: "missing" },
			],
		});
		expect(transitionQuestionState(invalidRadio, { type: "submit-default" })).toEqual({
			state: invalidRadio,
			error: "No valid default",
		});

		const mismatchedDefault = createQuestionState({
			questions: [{ id: "text", type: "text", prompt: "Explain", default: ["not text"] }],
		});
		expect(transitionQuestionState(mismatchedDefault, { type: "submit-default" })).toEqual({
			state: mismatchedDefault,
			error: "No valid default",
		});

		const requiredText = createQuestionState({
			questions: [{ id: "text", type: "text", prompt: "Explain", required: true, default: " " }],
		});
		expect(transitionQuestionState(requiredText, { type: "submit-default" })).toEqual({
			state: requiredText,
			error: "Question is required",
		});
		expect(
			transitionQuestionState(requiredText, { type: "submit-text", value: "  raw value  " }).state.answers,
		).toEqual({ text: "  raw value  " });
		expect(transitionQuestionState(requiredText, { type: "submit-text", value: " \t " })).toEqual({
			state: requiredText,
			error: "Question is required",
		});
	});

	it("preserves optional defaults when the current question is skipped", () => {
		const state = createQuestionState({
			questions: [{ id: "text", type: "text", prompt: "Optional", required: false, default: "seed" }],
		});
		expect(transitionQuestionState(state, { type: "skip" }).state).toMatchObject({
			status: "answered",
			answers: { text: "seed" },
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
