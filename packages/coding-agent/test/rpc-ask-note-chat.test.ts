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
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
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

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
		canPromptUser: overrides.canPromptUser ?? overrides.hasUI ?? true,
	};
}

/** Wires `context.ui.askDialog` straight through `requestRpcAskDialog`, so tests exercise the real wire protocol. */
function createRpcContext(pendingRequests: Map<string, PendingExtensionRequest>, output: (frame: object) => void) {
	return {
		hasUI: true,
		ui: {
			askDialog: (questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) =>
				requestRpcAskDialog(pendingRequests, output, questions, dialogOptions),
		},
		abort: () => {},
	} as unknown as AgentToolContext;
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

describe("AskTool over the RPC ask dialog wire protocol", () => {
	it("carries a note through to the ask tool response text and details", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const tool = new AskTool(createSession());
		const context = createRpcContext(pendingRequests, output);

		const execution = tool.execute(
			"call-note",
			{ questions: [{ id: "q1", question: "Which plan?", options: [{ label: "Starter" }] }] },
			undefined,
			undefined,
			context,
		);

		const request = requireRequest(output.mock.calls[0]?.[0]);
		respond(pendingRequests, request.id, {
			answers: [{ id: "q1", selectedOptions: ["Starter"], note: "  Billed monthly  " }],
		});

		const result = await execution;
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("User added note: Billed monthly");
		expect(result.details).toMatchObject({ note: "Billed monthly" });
	});

	it("returns a chat redirect when the host replies chat: true", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const tool = new AskTool(createSession());
		const context = createRpcContext(pendingRequests, output);

		const execution = tool.execute(
			"call-chat",
			{ questions: [{ id: "q1", question: "Which plan?", options: [{ label: "Starter" }] }] },
			undefined,
			undefined,
			context,
		);

		const request = requireRequest(output.mock.calls[0]?.[0]);
		respond(pendingRequests, request.id, { chat: true });

		const result = await execution;
		expect(result.details).toEqual({ chatRedirect: true, questions: ["Which plan?"] });
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("chat about this");
	});
});
