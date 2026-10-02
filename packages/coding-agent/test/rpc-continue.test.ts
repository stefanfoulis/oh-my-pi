import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown>;

/**
 * Echoes the last user/developer message back as the answer, so the test can
 * assert which directive text reached the provider. The first request parks
 * until `release.txt` appears in the cwd, which keeps a turn streaming while the
 * test sends a command.
 */
const scriptedContinueProvider = `
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";

let calls = 0;

export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-continue",
		models: [{
			id: "continue",
			name: "Scripted continue",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const call = ++calls;
			const last = context.messages.findLast(entry => entry.role === "user" || entry.role === "developer");
			const content = typeof last?.content === "string" ? last.content : (last?.content ?? []).map(part => part.text ?? "").join("");
			const text = "[" + (last?.role ?? "none") + "] " + content;
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text }],
				stopReason: "stop",
			};
			(async () => {
				stream.push({ type: "start", partial: message });
				if (call === 1 && process.env.PI_CONTINUE_HOLD === "1") {
					// Cross-process handshake: the RPC child has no event channel back to
					// the test, so the held turn polls for the release file the test writes.
					const release = Bun.file(process.cwd() + "/release.txt");
					while (!(await release.exists())) await Bun.sleep(20);
				}
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			})();
			return stream;
		},
	});
}
`;

interface Harness {
	send(frame: object): Promise<void>;
	frames: AsyncIterable<unknown>;
	stderr: Promise<string>;
	dispose(): Promise<void>;
}

async function spawnRpc(temp: TempDir, env: Record<string, string> = {}): Promise<Harness> {
	const extensionPath = temp.join("scripted-continue.ts");
	await Bun.write(extensionPath, scriptedContinueProvider);
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--trusted-extension",
			extensionPath,
			"--mode",
			"rpc-ui",
		],
		{
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
				...env,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 60_000,
		},
	);
	const stdout = new Response(child.stdout).body;
	if (!stdout) throw new Error("RPC continue fixture did not expose stdout");
	const stderr = new Response(child.stderr).text();
	return {
		send: async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		},
		frames: readJsonl<unknown>(stdout),
		stderr,
		dispose: async () => {
			child.stdin.end();
			child.kill();
			await child.exited;
		},
	};
}

/** Text of an assistant `message_end` frame. */
function assistantText(frame: Frame): string | undefined {
	const message = frame.message;
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content.map(part => (isRecord(part) && part.type === "text" ? String(part.text) : "")).join("");
}

describe("RPC continue command", () => {
	it("starts an advisor-continue turn while idle and marks the prompt synthetic", async () => {
		await using temp = await TempDir.create("@rpc-continue-advisor-");
		const rpc = await spawnRpc(temp);
		const developerStarts: Frame[] = [];
		const answers: string[] = [];
		let continueResponse: Frame | undefined;
		let promptResult: Frame | undefined;
		let sessionFile: string | undefined;

		try {
			await rpc.send({ type: "set_model", id: "model", provider: "scripted", modelId: "continue" });
			for await (const frame of rpc.frames) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					// The command takes no parameters; a host that still spells out the
					// directive it wants is accepted like any frame with an extra key.
					await rpc.send({ type: "continue", id: "cont", reason: "advisor" });
				} else if (frame.type === "response" && frame.id === "cont") {
					continueResponse = frame;
				} else if (frame.type === "message_start") {
					const message = frame.message;
					if (isRecord(message) && message.role === "developer") developerStarts.push(frame);
				} else if (frame.type === "message_end") {
					const text = assistantText(frame);
					if (text) answers.push(text);
				} else if (frame.type === "prompt_result" && frame.id === "cont") {
					promptResult = frame;
					await rpc.send({ type: "get_state", id: "state" });
				} else if (frame.type === "response" && frame.id === "state") {
					const data = frame.data;
					if (isRecord(data) && typeof data.sessionFile === "string") sessionFile = data.sessionFile;
					break;
				}
			}
		} finally {
			await rpc.dispose();
		}

		if (!promptResult) throw new Error(`RPC continue fixture did not finish: ${await rpc.stderr}`);
		expect(continueResponse).toMatchObject({ type: "response", command: "continue", success: true });
		expect(promptResult).toMatchObject({ type: "prompt_result", agentInvoked: true, status: "completed" });

		// The directive is a hidden developer message, flagged synthetic for hosts.
		expect(developerStarts).toHaveLength(1);
		const directive = developerStarts[0]?.message as Record<string, unknown>;
		expect(directive).toMatchObject({ role: "developer", synthetic: true, userInitiated: true });
		expect(typeof developerStarts[0]?.messageId).toBe("string");

		// The provider saw the advisor directive as the last input message.
		expect(answers.at(-1)).toContain("[developer]");
		expect(answers.at(-1)).toContain("act on the advisor notes above");

		// A host reloading history can tell the marker apart from a user bubble.
		if (!sessionFile) throw new Error("get_state reported no session file");
		const persisted = (await Bun.file(sessionFile).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { message?: { role?: string; synthetic?: boolean; userInitiated?: boolean } })
			.filter(entry => entry.message?.role === "developer");
		expect(persisted.at(-1)?.message).toMatchObject({ synthetic: true, userInitiated: true });
	}, 90_000);

	it("queues the directive behind a streaming turn", async () => {
		await using temp = await TempDir.create("@rpc-continue-queued-");
		const rpc = await spawnRpc(temp, { PI_CONTINUE_HOLD: "1" });
		const answers: string[] = [];
		const order: string[] = [];
		let continueResponse: Frame | undefined;

		try {
			await rpc.send({ type: "set_model", id: "model", provider: "scripted", modelId: "continue" });
			for await (const frame of rpc.frames) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					await rpc.send({ type: "prompt", id: "first", message: "hold the line" });
				} else if (frame.type === "agent_start") {
					order.push("agent_start");
					// The first turn parks inside the provider, so the continue below is
					// dispatched while the session is streaming.
					await rpc.send({ type: "continue", id: "cont" });
				} else if (frame.type === "response" && frame.id === "cont") {
					order.push("cont_response");
					continueResponse = frame;
					await Bun.write(temp.join("release.txt"), "go");
				} else if (frame.type === "message_end") {
					const text = assistantText(frame);
					if (text) {
						answers.push(text);
						order.push("answer");
					}
				} else if (frame.type === "agent_end") {
					order.push("agent_end");
				} else if (frame.type === "prompt_result" && frame.id === "cont") {
					order.push("continue_result");
					break;
				}
			}
		} finally {
			await rpc.dispose();
		}

		if (!order.includes("continue_result"))
			throw new Error(`RPC continue fixture did not finish: ${await rpc.stderr}`);
		expect(continueResponse).toMatchObject({ type: "response", command: "continue", success: true });
		// Accepted while the held turn streamed, then delivered to the same run as a
		// follow-up rather than interrupting it or starting a second run.
		expect(order.indexOf("cont_response")).toBeLessThan(order.indexOf("answer"));
		expect(order.filter(entry => entry === "agent_start")).toHaveLength(1);
		expect(order.indexOf("agent_end")).toBeLessThan(order.indexOf("continue_result"));
		// The held turn answered first; the directive drove the turn after it.
		expect(answers).toHaveLength(2);
		expect(answers[0]).toContain("hold the line");
		expect(answers[1]).toContain("[developer]");
		expect(answers[1]).toContain("act on the advisor notes above");
	}, 90_000);
});
