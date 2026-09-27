/**
 * Rich `ask` dialog bridge for RPC mode.
 *
 * Opt-in via `OMP_RPC_ASK_DIALOG` (truthy): when enabled, `RpcExtensionUIContext`
 * exposes `askDialog`, letting the `ask` tool emit a single `extension_ui_request`
 * with `method: "ask"` carrying every question instead of falling back to the
 * plain `select`/`editor` frames. See docs/rpc.md's "Extension UI" section.
 */
import { $env, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIDialogOptions,
} from "../../extensibility/extensions";
import type { PendingExtensionRequest } from "./rpc-mode";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types";

/** True when the RPC `ask` dialog opt-in env var is set to a truthy value. */
export function isRpcAskDialogEnabled(): boolean {
	const raw = $env.OMP_RPC_ASK_DIALOG;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Builds the `timedOut: true` fallback answers used when the ask dialog's own timer fires. */
function buildAskDialogTimeoutResults(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogResultItem[] {
	return questions.map(question => {
		const labels = question.options.map(option => option.label);
		const fallbackIndex = Math.min(Math.max(question.recommended ?? 0, 0), Math.max(labels.length - 1, 0));
		const fallback = labels[fallbackIndex];
		return {
			id: question.id,
			question: question.question,
			options: labels,
			multi: question.multi ?? false,
			selectedOptions: fallback === undefined ? [] : [fallback],
			customInput: undefined,
			timedOut: true,
		};
	});
}

/** Maps a wire `results` reply back onto {@link ExtensionAskDialogResultItem}s, or undefined when malformed. */
function parseAskDialogResults(
	rawResults: ReadonlyArray<{ id: string; selectedOptions: string[]; customInput?: string; note?: string }>,
	questions: ExtensionAskDialogQuestion[],
): ExtensionAskDialogResultItem[] | undefined {
	if (rawResults.length !== questions.length) return undefined;
	const results: ExtensionAskDialogResultItem[] = [];
	for (let index = 0; index < questions.length; index++) {
		const question = questions[index]!;
		const raw = rawResults[index];
		if (!raw || raw.id !== question.id) return undefined;
		const labels = question.options.map(option => option.label);
		const multi = question.multi ?? false;
		const validSelected = raw.selectedOptions.filter(label => labels.includes(label));
		const selectedOptions = multi ? validSelected : validSelected.slice(0, 1);
		const customInput = raw.customInput?.trim() ? raw.customInput.trim() : undefined;
		const trimmedNote = raw.note?.trim();
		const note = trimmedNote && (selectedOptions.length > 0 || customInput !== undefined) ? trimmedNote : undefined;
		results.push({
			id: question.id,
			question: question.question,
			options: labels,
			multi,
			selectedOptions,
			customInput,
			note,
		});
	}
	return results;
}

/** Interprets an `extension_ui_response` for a pending ask-dialog request. */
function parseAskDialogResponse(
	response: RpcExtensionUIResponse,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions: ExtensionUIDialogOptions | undefined,
): ExtensionAskDialogResult | undefined {
	if ("chat" in response && response.chat) return { kind: "chat" };
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if (!("results" in response)) return undefined;
	const results = parseAskDialogResults(response.results, questions);
	if (!results) return undefined;
	return { kind: "submit", results };
}

/**
 * Sends an RPC `ask` dialog request carrying every question in one frame and
 * resolves with the host's structured answers. Reuses the
 * abort/timeout/cleanup shape of `requestRpcEditor`/`requestRpcDialog`: an
 * aborted signal emits a `cancel` frame and resolves `undefined`; an own
 * timeout calls `dialogOptions.onTimeout`, emits `cancel`, and resolves the
 * TUI's timed-out fallback answers (recommended option, else the first
 * option, else none) so a distracted host still gets a usable default.
 */
export function requestRpcAskDialog(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: (obj: object) => void,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionAskDialogResult | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: ExtensionAskDialogResult | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const emitCancel = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
	};
	const onAbort = () => {
		emitCancel();
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

	const timeout = dialogOptions?.timeout;
	const hasTimeout = typeof timeout === "number" && timeout > 0;
	if (hasTimeout) {
		timeoutId = setTimeout(() => {
			dialogOptions?.onTimeout?.();
			emitCancel();
			finish({ kind: "submit", results: buildAskDialogTimeoutResults(questions) });
		}, timeout);
	}

	pendingRequests.set(id, {
		resolve: response => finish(parseAskDialogResponse(response, questions, dialogOptions)),
		reject: fail,
	});

	output({
		type: "extension_ui_request",
		id,
		method: "ask",
		questions,
		...(hasTimeout ? { timeout } : {}),
	} as RpcExtensionUIRequest);

	return promise;
}
