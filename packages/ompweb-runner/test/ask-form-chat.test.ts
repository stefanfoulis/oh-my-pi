/**
 * The host's `{kind:"chat"}` answer to the ask tool's form dialog: the runner passes the value
 * through, and the tool ends its call asking the user to say it in the conversation.
 */
import { afterEach, describe, expect, it } from "bun:test";
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

describe("ask form chat", () => {
	it("redirects the ask tool into the chat", async () => {
		const html =
			'<form><p>Which database?</p><label><input type="radio" name="db" value="sqlite"> SQLite</label>' +
			'<label><input type="radio" name="db" value="postgres"> Postgres</label></form>';
		host = await startHost();
		test = await createTestSession({
			toolNames: ["ask"],
			responses: [{ content: [{ type: "toolCall", name: "ask", arguments: { html } }] }, { content: ["done"] }],
		});
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		expect(request).toMatchObject({ method: "formDialog" });

		host.send({ t: "ui_response", id: request.id, value: { kind: "chat" } });
		const end = await host.waitFor(frame => eventType(frame) === "tool_execution_end");
		expect(end.event).toMatchObject({ toolName: "ask", isError: false });
		const serialized = JSON.stringify(end.event);
		expect(serialized).toContain('"chatRedirect":true');
		expect(serialized).toContain("User chose to chat about this instead of answering.");
		expect(serialized).toContain("Which database?");
	});
});
