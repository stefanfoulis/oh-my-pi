/**
 * A form dialog answered with `{kind:"chat"}`: the user wants to talk the questions over
 * instead of filling the form in.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/ask";

const DEPLOY_FORM = `<form>
  <p>Which database?</p>
  <label><input type="radio" name="db" value="sqlite"> SQLite</label>
  <label><input type="radio" name="db" value="postgres" checked> Postgres</label>
</form>`;

describe("AskTool form dialog chat", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	it("ends the call with the questions it asked", async () => {
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: { formDialog: async () => ({ kind: "chat" as const }) },
			abort,
		} as unknown as AgentToolContext;
		const tool = new AskTool({
			hasUI: true,
			settings: Settings.isolated({ "ask.notify": "off", "speech.enabled": false }),
			getPlanModeState: () => ({ enabled: false }),
		} as unknown as ToolSession);

		const result = await tool.execute("ask-chat", { html: DEPLOY_FORM }, undefined, undefined, context);

		expect(result.details).toEqual({ answers: [], chatRedirect: true });
		const text = result.content[0];
		expect(text?.type === "text" && text.text).toContain("User chose to chat about this instead of answering.");
		expect(text?.type === "text" && text.text).toContain("Which database?");
		// Chatting is not a cancel: the tool call ends with a result instead of aborting the turn.
		expect(abort).not.toHaveBeenCalled();
	});
});
