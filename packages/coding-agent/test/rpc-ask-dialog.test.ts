import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { isRpcAskDialogEnabled, requestRpcAskDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-ask-dialog";
import type { PendingExtensionRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC ask dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC ask dialog request id to be a string");
	return { id };
}

function resolveAskResults(
	pendingRequests: Map<string, PendingExtensionRequest>,
	id: string,
	results: Array<{ id: string; selectedOptions: string[]; customInput?: string; note?: string }>,
): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC ask dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, results });
}

beforeAll(async () => {
	// AskTool's default (non-rich) rendering path reads `theme.status`, exercised by
	// the AskTool integration test below even though it never renders it.
	await initTheme(false);
});

describe("isRpcAskDialogEnabled", () => {
	const originalEnv = Bun.env.OMP_RPC_ASK_DIALOG;

	afterEach(() => {
		if (originalEnv === undefined) delete Bun.env.OMP_RPC_ASK_DIALOG;
		else Bun.env.OMP_RPC_ASK_DIALOG = originalEnv;
	});

	it("is false when unset", () => {
		delete Bun.env.OMP_RPC_ASK_DIALOG;
		expect(isRpcAskDialogEnabled()).toBe(false);
	});

	it("is true for common truthy spellings, case-insensitive and trimmed", () => {
		for (const value of ["1", "true", "YES", " on "]) {
			Bun.env.OMP_RPC_ASK_DIALOG = value;
			expect(isRpcAskDialogEnabled()).toBe(true);
		}
	});

	it("is false for other values", () => {
		Bun.env.OMP_RPC_ASK_DIALOG = "0";
		expect(isRpcAskDialogEnabled()).toBe(false);
		Bun.env.OMP_RPC_ASK_DIALOG = "nope";
		expect(isRpcAskDialogEnabled()).toBe(false);
	});
});

describe("requestRpcAskDialog", () => {
	it("emits the ask frame carrying every question field and the timeout", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Which backend?",
				header: "Storage",
				options: [
					{ label: "SQLite", description: "local file", preview: "sqlite3 preview" },
					{ label: "PostgreSQL" },
				],
				multi: true,
				recommended: 1,
			},
		];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions, { timeout: 30_000 });
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions,
			timeout: 30_000,
		});

		resolveAskResults(pendingRequests, request.id, [{ id: "q1", selectedOptions: ["SQLite"] }]);
		await resultPromise;
		expect(pendingRequests.size).toBe(0);
	});

	it("omits the timeout field from the frame when no timeout is configured", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Q1", options: [{ label: "A" }] }];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions,
		});
		resolveAskResults(pendingRequests, request.id, [{ id: "q1", selectedOptions: [] }]);
		await resultPromise;
	});

	it("maps a results reply into submit results, dropping unknown labels", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }], multi: true },
		];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		resolveAskResults(pendingRequests, request.id, [
			{ id: "q1", selectedOptions: ["A", "Ghost", "B"], customInput: "  extra  ", note: "  keep this  " },
		]);

		expect(await resultPromise).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Pick one",
					options: ["A", "B"],
					multi: true,
					selectedOptions: ["A", "B"],
					customInput: "extra",
					note: "keep this",
				},
			],
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("keeps only the first valid label for a single-select answer", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
		];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		resolveAskResults(pendingRequests, request.id, [{ id: "q1", selectedOptions: ["A", "B"] }]);

		const result = await resultPromise;
		expect(result?.kind).toBe("submit");
		expect(result?.kind === "submit" ? result.results[0]?.selectedOptions : undefined).toEqual(["A"]);
	});

	it("drops the note when nothing was selected and there is no custom input", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Pick one", options: [{ label: "A" }], multi: true },
		];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		resolveAskResults(pendingRequests, request.id, [{ id: "q1", selectedOptions: [], note: "orphaned" }]);

		expect(await resultPromise).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Pick one",
					options: ["A"],
					multi: true,
					selectedOptions: [],
					customInput: undefined,
					note: undefined,
				},
			],
		});
	});

	it("resolves chat:true replies to a chat result", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Q1", options: [{ label: "A" }] }];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		pendingRequests.get(request.id)?.resolve({ type: "extension_ui_response", id: request.id, chat: true });

		expect(await resultPromise).toEqual({ kind: "chat" });
		expect(pendingRequests.size).toBe(0);
	});

	it("resolves cancelled replies to undefined", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Q1", options: [{ label: "A" }] }];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		pendingRequests.get(request.id)?.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });

		expect(await resultPromise).toBeUndefined();
		expect(pendingRequests.size).toBe(0);
	});

	it("treats a mismatched result id order as a cancellation", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Q1", options: [{ label: "A" }] },
			{ id: "q2", question: "Q2", options: [{ label: "B" }] },
		];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		resolveAskResults(pendingRequests, request.id, [
			{ id: "q2", selectedOptions: [] },
			{ id: "q1", selectedOptions: [] },
		]);

		expect(await resultPromise).toBeUndefined();
		expect(pendingRequests.size).toBe(0);
	});

	it("emits a cancel frame and resolves undefined when the signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Q1", options: [{ label: "A" }] }];
		const resultPromise = requestRpcAskDialog(pendingRequests, output, questions, { signal: controller.signal });
		const request = requireRequest(output.mock.calls[0]?.[0]);

		controller.abort();

		expect(await resultPromise).toBeUndefined();
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("falls back to recommended/first-option answers with timedOut:true when its own timer fires", async () => {
		vi.useFakeTimers();
		try {
			const pendingRequests = new Map<string, PendingExtensionRequest>();
			const output = vi.fn<(frame: object) => void>();
			const onTimeout = vi.fn();
			const questions: ExtensionAskDialogQuestion[] = [
				{ id: "q1", question: "Q1", options: [{ label: "A" }, { label: "B" }], recommended: 1 },
				{ id: "q2", question: "Q2", options: [] },
			];
			const resultPromise = requestRpcAskDialog(pendingRequests, output, questions, {
				timeout: 1_000,
				onTimeout,
			} satisfies ExtensionUIDialogOptions);
			const request = requireRequest(output.mock.calls[0]?.[0]);

			vi.advanceTimersByTime(1_000);
			const result = await resultPromise;

			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(output).toHaveBeenNthCalledWith(2, {
				type: "extension_ui_request",
				id: expect.any(String),
				method: "cancel",
				targetId: request.id,
			});
			expect(result).toEqual({
				kind: "submit",
				results: [
					{
						id: "q1",
						question: "Q1",
						options: ["A", "B"],
						multi: false,
						selectedOptions: ["B"],
						customInput: undefined,
						timedOut: true,
					},
					{
						id: "q2",
						question: "Q2",
						options: [],
						multi: false,
						selectedOptions: [],
						customInput: undefined,
						timedOut: true,
					},
				],
			});
			expect(pendingRequests.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("AskTool + requestRpcAskDialog integration", () => {
	function createSession(): ToolSession {
		return {
			cwd: "/tmp/test",
			hasUI: true,
			canPromptUser: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
	}

	function createContext(
		askDialog: (
			questions: ExtensionAskDialogQuestion[],
			dialogOptions?: ExtensionUIDialogOptions,
		) => Promise<ExtensionAskDialogResult | undefined>,
	): AgentToolContext {
		return {
			hasUI: true,
			ui: { askDialog, editor: () => Promise.resolve(undefined) },
			abort: () => {},
		} as unknown as AgentToolContext;
	}

	it("threads a note from the RPC results reply through to the tool result", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const askDialog = (questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) =>
			requestRpcAskDialog(pendingRequests, output, questions, dialogOptions);

		const tool = new AskTool(createSession());
		const executePromise = tool.execute(
			"call-1",
			{
				questions: [{ id: "q1", question: "Storage?", options: [{ label: "SQLite" }, { label: "PostgreSQL" }] }],
			},
			undefined,
			undefined,
			createContext(askDialog),
		);

		const request = requireRequest(output.mock.calls[0]?.[0]);
		resolveAskResults(pendingRequests, request.id, [
			{ id: "q1", selectedOptions: ["PostgreSQL"], note: "needs replication" },
		]);

		const result = await executePromise;
		const text = result.content.map(part => ("text" in part ? part.text : "")).join("\n");
		expect(text).toContain("needs replication");
		expect(result.details).toMatchObject({ note: "needs replication" });
		expect(pendingRequests.size).toBe(0);
	});
});
