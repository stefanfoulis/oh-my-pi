/**
 * `inlineFormImages` rewrites an ask form's `<img src>` into something a host without this
 * session's filesystem can still draw, before the runner forwards the form.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { inlineFormImages } from "../src/form-images";

// A 1x1 transparent PNG, the smallest fixture `loadMedia` recognizes as an image.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.fromBase64(PNG_BASE64);

let tmpDir: string | undefined;

afterEach(() => {
	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

function makeCwd(): string {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "form-images-"));
	return tmpDir;
}

describe("inlineFormImages", () => {
	it("inlines a relative-path image, an absolute-path image, leaves a data: src untouched, and empties a missing file's src", async () => {
		const cwd = makeCwd();
		fs.writeFileSync(path.join(cwd, "relative.png"), PNG_BYTES);
		const absolutePath = path.join(cwd, "sub", "absolute.png");
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, PNG_BYTES);

		const html =
			`<img src="relative.png" alt="rel">` +
			`<img src="${absolutePath}" alt="abs">` +
			// an invalid payload proves this src is never decoded, only passed through
			`<img src="data:image/png;base64,not-really-base64!!" alt="already">` +
			`<img src="missing.png" alt="gone">`;

		const result = await inlineFormImages(html, { cwd });

		expect(result).toBe(
			`<img src="data:image/png;base64,${PNG_BASE64}" alt="rel">` +
				`<img src="data:image/png;base64,${PNG_BASE64}" alt="abs">` +
				`<img src="data:image/png;base64,not-really-base64!!" alt="already">` +
				`<img src="" alt="gone">`,
		);
	});

	it("empties a src that would push the form past its image budget", async () => {
		const cwd = makeCwd();
		fs.writeFileSync(path.join(cwd, "pic.png"), PNG_BYTES);
		const html = `<img src="pic.png" alt="big">`;

		// The data: URI is well over 100 bytes; a budget this small can never fit it.
		const result = await inlineFormImages(html, { cwd, budgetBytes: 10 });

		expect(result).toBe(`<img src="" alt="big">`);
	});

	it("spends the budget in document order: an earlier image can push a later one over it", async () => {
		const cwd = makeCwd();
		fs.writeFileSync(path.join(cwd, "a.png"), PNG_BYTES);
		fs.writeFileSync(path.join(cwd, "b.png"), PNG_BYTES);
		const dataUri = `data:image/png;base64,${PNG_BASE64}`;
		const html = `<img src="a.png" alt="a"><img src="b.png" alt="b">`;

		// Room for exactly one image's data: URI.
		const result = await inlineFormImages(html, { cwd, budgetBytes: dataUri.length });

		expect(result).toBe(`<img src="${dataUri}" alt="a"><img src="" alt="b">`);
	});

	it("leaves non-img markup and inline svg byte-identical", async () => {
		const cwd = makeCwd();
		fs.writeFileSync(path.join(cwd, "pic.png"), PNG_BYTES);
		const html =
			`<form><p>Some <b>context</b> & <i>notes</i>.</p>` +
			`<svg viewBox="0 0 10 10"><title>A diagram</title><circle r="1"/></svg>` +
			`<img src="pic.png" alt="pic">` +
			`<label><input type="radio" name="x" value="y"> y</label></form>`;

		const result = await inlineFormImages(html, { cwd });

		expect(result).toBe(
			`<form><p>Some <b>context</b> & <i>notes</i>.</p>` +
				`<svg viewBox="0 0 10 10"><title>A diagram</title><circle r="1"/></svg>` +
				`<img src="data:image/png;base64,${PNG_BASE64}" alt="pic">` +
				`<label><input type="radio" name="x" value="y"> y</label></form>`,
		);
	});

	it("returns html unchanged when there is no <img> tag", async () => {
		const html = `<form><p>No pictures here.</p><svg><circle r="1"/></svg></form>`;
		const result = await inlineFormImages(html, { cwd: makeCwd() });
		expect(result).toBe(html);
	});

	it("passes the abort signal to the loader", async () => {
		const controller = new AbortController();
		controller.abort();
		// An already-aborted signal fails an in-flight fetch before any network call; the src
		// falls back to empty rather than the dialog's abort rejecting the whole form.
		const html = `<img src="http://127.0.0.1:1/pic.png" alt="pic">`;

		const result = await inlineFormImages(html, { cwd: makeCwd(), signal: controller.signal });

		expect(result).toBe(`<img src="" alt="pic">`);
	});
});
