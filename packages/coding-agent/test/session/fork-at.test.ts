/**
 * `--fork <source> --fork-at <entryId>`: fork a cut of a session file without
 * touching the process that owns it (`SessionManager.forkFrom` `leafEntryId`).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-10-16T10:00:00.000Z";

function assistantEntry(id: string, parentId: string | null, content: unknown[], stopReason: string): unknown {
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
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

function userEntry(id: string, parentId: string | null, text: string): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: Date.parse(TIMESTAMP) },
	};
}

function toolResultEntry(id: string, parentId: string, toolCallId: string): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: `output of ${toolCallId}` }],
			isError: false,
			timestamp: Date.parse(TIMESTAMP),
		},
	};
}

/**
 * A transcript with every shape the cut has to handle:
 * `u1 → a1 → u2 → a2(tc1,tc2) → r1 → r2 → a3 → u3 → a4(tc3, still running)`.
 */
function sourceEntries(cwd: string): unknown[] {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "fork-at-source",
		timestamp: TIMESTAMP,
		cwd,
		title: "parent session",
	};
	return [
		header,
		userEntry("u1", null, "first"),
		assistantEntry("a1", "u1", [{ type: "text", text: "reply one" }], "stop"),
		userEntry("u2", "a1", "second"),
		assistantEntry(
			"a2",
			"u2",
			[
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "echo one" } },
				{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "echo two" } },
			],
			"toolUse",
		),
		toolResultEntry("r1", "a2", "tc1"),
		toolResultEntry("r2", "r1", "tc2"),
		assistantEntry("a3", "r2", [{ type: "text", text: "both tools done" }], "stop"),
		userEntry("u3", "a3", "third"),
		assistantEntry(
			"a4",
			"u3",
			[{ type: "toolCall", id: "tc3", name: "bash", arguments: { command: "sleep 60" } }],
			"toolUse",
		),
	];
}

interface Source {
	cwd: string;
	sessionDir: string;
	file: string;
	text: string;
}

async function writeSource(root: string): Promise<Source> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, "source.jsonl");
	const text = `${sourceEntries(cwd)
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
	await Bun.write(file, text);
	return { cwd, sessionDir, file, text };
}

/** Fork `source` at `entryId` the way the CLI does, and return the persisted message ids. */
async function forkAt(source: Source, root: string, entryId: string): Promise<{ ids: string[]; file: string }> {
	const forked = await SessionManager.forkFrom(source.file, source.cwd, path.join(root, "forks"), undefined, {
		suppressBreadcrumb: true,
		repairInterruptedTail: true,
		leafEntryId: entryId,
	});
	const file = forked.getSessionFile();
	if (!file) throw new Error("Expected a persisted fork file");
	const entries = await loadEntriesFromFile(file);
	return {
		ids: entries.flatMap(entry => (entry.type === "message" ? [entry.id] : [])),
		file,
	};
}

describe("SessionManager.forkFrom with leafEntryId", () => {
	it("cuts at a user entry, keeping that prompt as the last message", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-user-");
		const source = await writeSource(tempDir.path());

		const { ids } = await forkAt(source, tempDir.path(), "u2");

		expect(ids).toEqual(["u1", "a1", "u2"]);
		expect(await Bun.file(source.file).text()).toBe(source.text);
	});

	it("cuts at an assistant text entry, dropping the later turns", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-assistant-");
		const source = await writeSource(tempDir.path());

		const { ids } = await forkAt(source, tempDir.path(), "a1");

		expect(ids).toEqual(["u1", "a1"]);
	});

	it("extends a cut at an assistant tool-call batch through its recorded results", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-batch-");
		const source = await writeSource(tempDir.path());

		const { ids } = await forkAt(source, tempDir.path(), "a2");

		expect(ids).toEqual(["u1", "a1", "u2", "a2", "r1", "r2"]);
	});

	it("extends a cut at one tool result through its batch's remaining results", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-result-");
		const source = await writeSource(tempDir.path());

		const { ids } = await forkAt(source, tempDir.path(), "r1");

		expect(ids).toEqual(["u1", "a1", "u2", "a2", "r1", "r2"]);
	});

	it("cuts before an assistant message whose tool calls the source has not answered", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-running-");
		const source = await writeSource(tempDir.path());

		const { ids, file } = await forkAt(source, tempDir.path(), "a4");

		// The source process is still running tc3; its result will never reach this fork.
		expect(ids).toEqual(["u1", "a1", "u2", "a2", "r1", "r2", "a3", "u3"]);
		const entries = await loadEntriesFromFile(file);
		expect(JSON.stringify(entries)).not.toContain("tc3");
	});

	it("records the source file as parentSession and copies its artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-lineage-");
		const source = await writeSource(tempDir.path());
		const sourceArtifacts = source.file.slice(0, -".jsonl".length);
		await fs.mkdir(path.join(sourceArtifacts, "nested"), { recursive: true });
		await Bun.write(path.join(sourceArtifacts, "1.read.log"), "tool output");
		await Bun.write(path.join(sourceArtifacts, "nested", "result.txt"), "nested output");

		const { file } = await forkAt(source, tempDir.path(), "u2");

		const header = (await loadEntriesFromFile(file)).find(entry => entry.type === "session") as
			| SessionHeader
			| undefined;
		expect(header?.parentSession).toBe(path.resolve(source.file));
		expect(header?.title).toBe("parent session");
		const forkArtifacts = file.slice(0, -".jsonl".length);
		expect(await Bun.file(path.join(forkArtifacts, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifacts, "nested", "result.txt")).text()).toBe("nested output");
	});

	it("forks a source whose last line is a half-written append", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-partial-");
		const source = await writeSource(tempDir.path());
		// The owning process is mid-append: the final record has no closing brace or newline.
		await Bun.write(source.file, `${source.text}{"type":"message","id":"u4","parentId":"a4","time`);

		const { ids } = await forkAt(source, tempDir.path(), "u3");

		expect(ids).toEqual(["u1", "a1", "u2", "a2", "r1", "r2", "a3", "u3"]);
	});

	it("rejects an unknown or non-message entry id", async () => {
		using tempDir = TempDir.createSync("@omp-fork-at-unknown-");
		const source = await writeSource(tempDir.path());
		const label: SessionEntry = {
			type: "label",
			id: "l1",
			parentId: "a1",
			timestamp: TIMESTAMP,
			targetId: "a1",
			label: "checkpoint",
		};
		await Bun.write(source.file, `${source.text}${JSON.stringify(label)}\n`);

		for (const entryId of ["nope", "l1"]) {
			await expect(
				SessionManager.forkFrom(source.file, source.cwd, path.join(tempDir.path(), "forks"), undefined, {
					suppressBreadcrumb: true,
					leafEntryId: entryId,
				}),
			).rejects.toMatchObject({
				name: "ForkEntryNotFoundError",
				message: `Entry "${entryId}" is not a message in session "${source.file}".`,
			});
		}
	});
});

describe("parseArgs — --fork-at", () => {
	it("parses --fork-at beside --fork", () => {
		const parsed = parseArgs(["--fork", "/tmp/source.jsonl", "--fork-at", "u2"]);

		expect(parsed.fork).toBe("/tmp/source.jsonl");
		expect(parsed.forkAt).toBe("u2");
	});

	it("rejects --fork-at without --fork", () => {
		expect(() => parseArgs(["--fork-at", "u2"])).toThrow("--fork-at requires --fork <session>.");
	});

	it("rejects an empty --fork-at value", () => {
		expect(() => parseArgs(["--fork", "/tmp/source.jsonl", "--fork-at="])).toThrow("--fork-at requires an entry id.");
	});
});
