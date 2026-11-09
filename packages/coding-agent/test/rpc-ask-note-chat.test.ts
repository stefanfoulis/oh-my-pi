import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type PendingExtensionRequest,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
	requestRpcFormDialog,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { TempDir } from "@oh-my-pi/pi-utils";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
}

/**
 * Collects the frames omp writes and hands out the first one. A form's pictures
 * load before its request goes out, so the frame is awaited rather than read.
 */
function createOutput(): { output: (frame: object) => void; firstFrame: Promise<Record<string, unknown>> } {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	return {
		output: frame => resolve(frame as Record<string, unknown>),
		firstFrame: promise,
	};
}

function respond(pendingRequests: Map<string, PendingExtensionRequest>, id: string, payload: object): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, ...payload } as RpcExtensionUIResponse);
}

const dbQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
	recommended: 1,
};
const featuresQuestion: ExtensionAskDialogQuestion = {
	id: "features",
	question: "Which features?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
	multi: true,
};

const PLAN_FORM = `<form>
  <input type="hidden" name="ticket" value="PI-7">
  <fieldset>
    <legend>Plan</legend>
    <label><input type="radio" name="plan" value="starter" checked> Starter</label>
    <label><input type="radio" name="plan" value="pro"> Pro</label>
  </fieldset>
  <p>Which add-ons?</p>
  <label><input type="checkbox" name="addons" value="backups"> Backups</label>
  <label><input type="checkbox" name="addons" value="support"> Support</label>
  <label>Seats <input type="number" name="seats" value="3" min="1"></label>
</form>`;

/** 1×1 PNG, the smallest picture `loadFormImage` accepts. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "ask.notify": "off" }),
		...overrides,
		canPromptUser: overrides.canPromptUser ?? overrides.hasUI ?? true,
	};
}

/** The `ask` tool over the RPC form dialog: `ui.formDialog` is the real `form` request/response path. */
function createRpcFormContext(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: (frame: object) => void,
	cwd = "/tmp/test",
) {
	return {
		hasUI: true,
		ui: {
			formDialog: (html: string, dialogOptions?: ExtensionUIDialogOptions) =>
				requestRpcFormDialog(pendingRequests, output, html, cwd, dialogOptions),
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected a text tool result");
	return first.text;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("RPC ask dialog: note and chat", () => {
	it("trims a note and attaches it to the answered question", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		respond(pendingRequests, request.id, {
			answers: [{ id: "db", selectedOptions: ["Postgres"], note: "  Use managed Postgres  " }],
		});

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
					note: "Use managed Postgres",
				},
			],
		});
	});

	it("drops a blank note", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		respond(pendingRequests, request.id, {
			answers: [{ id: "db", selectedOptions: ["Postgres"], note: "   " }],
		});

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
					note: undefined,
				},
			],
		});
	});

	it("drops a note when the answer carries no selection and no custom input", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		respond(pendingRequests, request.id, {
			answers: [{ id: "features", selectedOptions: [], note: "Skip these for now" }],
		});

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: [],
					customInput: undefined,
					note: undefined,
				},
			],
		});
	});

	it("rejects a non-string note", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		respond(pendingRequests, request.id, {
			answers: [{ id: "db", selectedOptions: ["Postgres"], note: 42 }],
		});

		await expect(result).rejects.toThrow(/note must be a string/);
		expect(pendingRequests.size).toBe(0);
	});

	it("resolves a chat reply as kind chat", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		respond(pendingRequests, request.id, { chat: true });

		expect(await result).toEqual({ kind: "chat" });
	});
});

describe("RPC form dialog request", () => {
	it("sends the parsed form with a question per named field", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const pending = requestRpcFormDialog(pendingRequests, output, PLAN_FORM, "/tmp/test", { timeout: 5_000 });
		const frame = (await firstFrame) as {
			method: string;
			timeout?: number;
			questions: Record<string, string>;
			form: { fields: Array<{ name: string }>; hidden: [string, string][] };
		};

		expect(frame.method).toBe("form");
		expect(frame.timeout).toBe(5_000);
		expect(frame.questions).toEqual({ plan: "Plan", addons: "Which add-ons?", seats: "Seats" });
		expect(frame.form.fields.map(field => field.name)).toEqual(["plan", "addons", "seats"]);
		expect(frame.form.hidden).toEqual([["ticket", "PI-7"]]);

		respond(pendingRequests, requireRequest(frame).id, { data: { plan: "pro" } });
		await pending;
	});

	it("inlines a picture as a data URL and blanks one it cannot read", async () => {
		await using dir = await TempDir.create("rpc-form-image");
		await Bun.write(dir.join("shot.png"), Buffer.from(PNG_BASE64, "base64"));
		const html = `<form>
			<img src="shot.png" alt="A screenshot">
			<img src="missing.png" alt="Gone">
			<label>Notes <input type="text" name="notes"></label>
		</form>`;
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const pending = requestRpcFormDialog(pendingRequests, output, html, dir.path());
		const frame = (await firstFrame) as {
			form: { sections: Array<{ blocks: Array<{ kind: string; src?: string; alt?: string }> }> };
		};

		const images = frame.form.sections.flatMap(section => section.blocks.filter(block => block.kind === "image"));
		expect(images[0]?.src).toBe(`data:image/png;base64,${PNG_BASE64}`);
		expect(images[1]).toEqual({ kind: "image", src: "", alt: "Gone" });

		respond(pendingRequests, requireRequest(frame).id, { data: {} });
		await pending;
	});

	it("submits the form's own values when the host reports its deadline", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const result = requestRpcFormDialog(pendingRequests, output, PLAN_FORM, "/tmp/test");
		const request = requireRequest(await firstFrame);

		respond(pendingRequests, request.id, { cancelled: true, timedOut: true });

		expect(await result).toEqual({
			data: { ticket: "PI-7", plan: "starter", addons: [], seats: 3 },
			timedOut: true,
		});
	});

	it("resolves undefined when the host dismisses the form", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const result = requestRpcFormDialog(pendingRequests, output, PLAN_FORM, "/tmp/test");
		const request = requireRequest(await firstFrame);

		respond(pendingRequests, request.id, { cancelled: true });

		expect(await result).toBeUndefined();
	});

	it("rejects a reply without data", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const result = requestRpcFormDialog(pendingRequests, output, PLAN_FORM, "/tmp/test");
		const request = requireRequest(await firstFrame);

		respond(pendingRequests, request.id, { answers: [] });

		await expect(result).rejects.toThrow(/must carry a data object/);
		expect(pendingRequests.size).toBe(0);
	});
});

describe("AskTool over the RPC form dialog wire protocol", () => {
	it("carries notes through to the ask tool response text and details", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const tool = new AskTool(createSession());
		const context = createRpcFormContext(pendingRequests, output);

		const execution = tool.execute("call-note", { html: PLAN_FORM }, undefined, undefined, context);

		const request = requireRequest(await firstFrame);
		respond(pendingRequests, request.id, {
			data: { plan: "pro", addons: ["backups"], seats: 5 },
			notes: { plan: "  Billed monthly  ", addons: "Nightly\nis enough", seats: "   " },
		});

		const result = await execution;
		expect(resultText(result)).toBe(
			[
				"User answers:",
				JSON.stringify({ ticket: "PI-7", plan: "pro", addons: ["backups"], seats: 5 }, null, 2),
				"",
				"User notes:",
				"- Plan: Billed monthly",
				"- Which add-ons?: Nightly",
				"  is enough",
			].join("\n"),
		);
		expect(result.details).toEqual({
			answers: [
				{ name: "plan", question: "Plan", answer: "Pro", note: "Billed monthly" },
				{ name: "addons", question: "Which add-ons?", answer: "Backups", note: "Nightly\nis enough" },
				{ name: "seats", question: "Seats", answer: "5" },
			],
		});
	});

	it("returns a chat redirect when the host replies chat: true", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const tool = new AskTool(createSession());
		const context = createRpcFormContext(pendingRequests, output);

		const execution = tool.execute("call-chat", { html: PLAN_FORM }, undefined, undefined, context);

		const request = requireRequest(await firstFrame);
		respond(pendingRequests, request.id, { chat: true });

		const result = await execution;
		expect(result.details).toEqual({ answers: [], chatRedirect: true });
		expect(resultText(result)).toBe(
			"User chose to chat about this instead of answering.\n\nQuestions asked:\nPlan\nWhich add-ons?\nSeats",
		);
	});

	it("keeps only values the form offers and merges its hidden inputs", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const tool = new AskTool(createSession());
		const context = createRpcFormContext(pendingRequests, output);
		const html = `<form>
			<input type="hidden" name="ticket" value="PI-7">
			<label>Region <select name="region"><option value="eu">EU</option><option value="us">US</option></select></label>
			<fieldset>
				<legend>Plan</legend>
				<label><input type="radio" name="plan" value="starter"> Starter</label>
				<label><input type="radio" name="plan" value="pro"> Pro</label>
			</fieldset>
		</form>`;

		const execution = tool.execute("call-sanitize", { html }, undefined, undefined, context);

		const request = requireRequest(await firstFrame);
		respond(pendingRequests, request.id, {
			// A `<select>` offers no "Other", so `apac` is dropped; the radio group does,
			// so `enterprise` is the user's own answer. `colour` is no field of this form,
			// and the host cannot overwrite the hidden `ticket`.
			data: { region: "apac", plan: "enterprise", ticket: "PI-9", colour: "red" },
			notes: { region: "Prefer Asia", colour: "Unknown field" },
		});

		const result = await execution;
		expect(resultText(result)).toBe(
			`User answers:\n${JSON.stringify({ ticket: "PI-7", plan: "enterprise" }, null, 2)}`,
		);
		expect(result.details).toEqual({
			answers: [
				{ name: "region", question: "Region", answer: "" },
				{ name: "plan", question: "Plan", answer: "Other: enterprise" },
			],
		});
	});

	it("fails the call when an answer breaks the form's own rules", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const { output, firstFrame } = createOutput();
		const tool = new AskTool(createSession());
		const context = createRpcFormContext(pendingRequests, output);
		const html = `<form><label>Seats <input type="number" name="seats" min="1" required></label></form>`;

		const execution = tool.execute("call-invalid", { html }, undefined, undefined, context);

		const request = requireRequest(await firstFrame);
		respond(pendingRequests, request.id, { data: { seats: 0 } });

		await expect(execution).rejects.toThrow(/"seats" is not acceptable: Must be at least 1/);
	});
});
