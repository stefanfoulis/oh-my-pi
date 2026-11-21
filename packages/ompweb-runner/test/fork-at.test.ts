/**
 * `fork_at`: write a cut of this session's file as a new session, without touching the live one.
 *
 * The cut is read from the file rather than from the in-memory transcript, so these tests append
 * to the source file behind the session's back — what a session writing its own turn looks like
 * to the command.
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createTestSession, startHost, type TestHost, type TestSession } from "./harness";

let host: TestHost | undefined;
let test: TestSession | undefined;

afterEach(async () => {
	await test?.dispose();
	host?.close();
	test = undefined;
	host = undefined;
});

const TIMESTAMP = "2026-11-21T10:00:00.000Z";

function userEntry(id: string, parentId: string, text: string): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: Date.parse(TIMESTAMP) },
	};
}

function assistantEntry(id: string, parentId: string, content: unknown[], stopReason: string): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			stopReason,
			timestamp: Date.parse(TIMESTAMP),
		},
	};
}

/** The session's own file, flushed, plus the ids of its messages in order. */
async function sourceState(session: TestSession["session"]): Promise<{ file: string; ids: string[] }> {
	await session.sessionManager.flush();
	const file = session.sessionFile;
	if (!file) throw new Error("Expected a persisted test session");
	const entries = await loadEntriesFromFile(file);
	return { file, ids: entries.flatMap(entry => (entry.type === "message" ? [entry.id] : [])) };
}

/** Append entries to `file` the way the session's own writer does. */
function append(file: string, entries: unknown[]): void {
	fs.appendFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function messageIds(file: string): Promise<string[]> {
	const entries = (await loadEntriesFromFile(file)) as SessionEntry[];
	return entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
}

describe("fork_at", () => {
	it("cuts the file at an entry a concurrent writer appended, and leaves the source alone", async () => {
		host = await startHost();
		test = await createTestSession({ persist: true, responses: [{ content: ["scripted reply"] }] });
		await host.connected;
		expect(await host.command("prompt", { message: "hello" })).toMatchObject({ ok: true });
		await host.waitFor(frame => frame.t === "event" && JSON.stringify(frame).includes("agent_end"));

		const source = await sourceState(test.session);
		const [, assistantId] = source.ids;
		// Two entries this session knows nothing about, as a writer mid-turn would leave them.
		append(source.file, [
			userEntry("appended-user", assistantId, "asked while running"),
			assistantEntry("appended-assistant", "appended-user", [{ type: "text", text: "still going" }], "stop"),
		]);
		const sourceText = fs.readFileSync(source.file, "utf8");

		const res = await host.command("fork_at", { entryId: "appended-user" });
		expect(res.ok).toBe(true);
		const { sessionId, sessionFile } = res.data as { sessionId: string; sessionFile: string };
		expect(sessionId).not.toBe(test.session.sessionId);
		expect(await messageIds(sessionFile)).toEqual([...source.ids, "appended-user"]);

		// The live session kept its own file, its transcript and its id.
		expect(test.session.sessionFile).toBe(source.file);
		expect(fs.readFileSync(source.file, "utf8")).toBe(sourceText);
	});

	it("reports an unknown entry as entry_not_found", async () => {
		host = await startHost();
		test = await createTestSession({ persist: true, responses: [{ content: ["scripted reply"] }] });
		await host.connected;
		expect(await host.command("prompt", { message: "hello" })).toMatchObject({ ok: true });
		await host.waitFor(frame => frame.t === "event" && JSON.stringify(frame).includes("agent_end"));
		const file = (await sourceState(test.session)).file;

		expect(await host.command("fork_at", { entryId: "ghost" })).toMatchObject({
			ok: false,
			code: "entry_not_found",
			error: `Entry "ghost" is not a message in session "${file}".`,
		});
	});

	it("ends the cut before an assistant message whose tool calls the source has not answered", async () => {
		host = await startHost();
		test = await createTestSession({ persist: true, responses: [{ content: ["scripted reply"] }] });
		await host.connected;
		expect(await host.command("prompt", { message: "hello" })).toMatchObject({ ok: true });
		await host.waitFor(frame => frame.t === "event" && JSON.stringify(frame).includes("agent_end"));

		const source = await sourceState(test.session);
		const [, assistantId] = source.ids;
		append(source.file, [
			userEntry("running-user", assistantId, "run a tool"),
			assistantEntry(
				"running-assistant",
				"running-user",
				[{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 60" } }],
				"toolUse",
			),
		]);

		const res = await host.command("fork_at", { entryId: "running-assistant" });
		expect(res.ok).toBe(true);
		const { sessionFile } = res.data as { sessionFile: string };
		// The fork cannot produce `tc1`'s result, so the call stays with the session that made it.
		expect(await messageIds(sessionFile)).toEqual([...source.ids, "running-user"]);
	});
});
