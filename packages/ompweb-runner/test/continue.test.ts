/**
 * `continue`: resume the agent on the advisor notes in its context with a hidden directive.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { MockCall } from "@oh-my-pi/pi-ai/providers/mock";
import { createTestSession, type Frame, startHost, type TestHost, type TestSession } from "./harness";

let host: TestHost | undefined;
let test: TestSession | undefined;

afterEach(async () => {
	await test?.dispose();
	host?.close();
	test = undefined;
	host = undefined;
});

const eventType = (frame: Frame) => {
	const event = frame.event;
	return frame.t === "event" && typeof event === "object" && event !== null && "type" in event
		? event.type
		: undefined;
};

/** The message a call ended on, as JSON, so role and text can be asserted together. */
const lastSent = (call: MockCall) => JSON.stringify(call.context.messages.at(-1));

const DIRECTIVE = "Advisor notes are advice, not orders";

describe("continue", () => {
	it("sends the directive as a synthetic developer message when idle", async () => {
		host = await startHost();
		test = await createTestSession({ responses: [{ content: ["weighed them"] }] });
		await host.connected;

		expect(await host.command("continue", { reason: "advisor" })).toMatchObject({ ok: true });
		await host.waitFor(frame => eventType(frame) === "agent_end");

		const sent = lastSent(test.mock.calls[0]);
		expect(sent).toContain('"role":"developer"');
		expect(sent).toContain(DIRECTIVE);

		// Recorded as hidden developer input, not as something the user typed.
		const recorded = test.session.sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "developer" ? [entry.message] : []));
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ synthetic: true, userInitiated: true });
		// One `prompt_result` for the command, as a prompt reports.
		expect(host.frames.filter(frame => frame.t === "prompt_result")).toMatchObject([{ agentInvoked: true }]);
	});

	it("queues behind a streaming turn instead of steering it", async () => {
		const html = '<form><label>Name <input name="q"></label></form>';
		host = await startHost();
		test = await createTestSession({
			toolNames: ["ask"],
			responses: [
				{ content: [{ type: "toolCall", name: "ask", arguments: { html } }] },
				{ content: ["answered the question"] },
				{ content: ["and now the advisor notes"] },
			],
		});
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		expect(test.session.isStreaming).toBe(true);

		expect(await host.command("continue", {})).toMatchObject({ ok: true });
		// The live turn keeps its own question: the directive neither steers nor aborts it.
		host.send({ t: "ui_response", id: request.id, value: { data: { q: "from host" } } });

		await host.waitFor(frame => eventType(frame) === "agent_end" && JSON.stringify(frame).includes("advisor notes"));
		const calls = test.mock.calls;
		// The second call answers the ask; the third is the turn the queued directive started.
		expect(JSON.stringify(calls[1].context.messages)).toContain("from host");
		expect(lastSent(calls[2])).toContain('"role":"developer"');
		expect(lastSent(calls[2])).toContain(DIRECTIVE);
	});
});
