/**
 * Inlines `<img>` sources of an agent-written ask form before it leaves this process: the host
 * on the other end of the channel (ompweb's browser tab) has no access to this session's
 * filesystem, so a local path, a `file:` URL or a slow remote fetch means nothing to it. Every
 * `<img src>` that is not already a `data:` URL is loaded the way the TUI loads one (relative to
 * the session cwd) and rewritten to one; a source that cannot be read, or that would push the
 * form past its image budget, becomes an empty `src` so the host falls back to the image's
 * `alt`. Inline `<svg>` carries its own bytes already and is left untouched.
 *
 * This edits the raw HTML string rather than reparsing and reserializing it: a host form must
 * reach the browser byte-for-byte except for the rewritten attribute, and `parseHtmlForm`
 * discards everything a draw doesn't need (attribute order, unknown attributes, whitespace).
 */
import { loadMedia } from "@oh-my-pi/pi-tui/media";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Total base64 bytes one form may inline. ompweb's host link closes an uplink frame over 16 MiB
 * (`LINK_LIMITS.uplinkBytes`) once it forwards this dialog's `ui_request` to the hub; this stays
 * well under that so the rest of the frame — markup, other fields, JSON overhead — still fits.
 */
export const FORM_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;

export interface InlineFormImagesOptions {
	/** Where a relative `src` resolves; the live session's cwd. */
	cwd: string;
	signal?: AbortSignal;
	/** Override for tests; defaults to {@link FORM_IMAGE_BUDGET_BYTES}. */
	budgetBytes?: number;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

interface ImgSrcMatch {
	/** Offset in `html` of `src="…"` (or the equivalent), including the attribute name. */
	start: number;
	end: number;
	src: string;
}

/** Every `<img>` tag's `src` attribute span, in document order; tags without one are skipped. */
function findImgSrcs(html: string): ImgSrcMatch[] {
	const found: ImgSrcMatch[] = [];
	for (const tag of html.matchAll(IMG_TAG)) {
		const attr = SRC_ATTR.exec(tag[0]);
		if (!attr) continue;
		const tagStart = tag.index;
		const start = tagStart + attr.index;
		found.push({ start, end: start + attr[0].length, src: attr[1] ?? attr[2] ?? attr[3] ?? "" });
	}
	return found;
}

/** Rewrites one `<img>` source to a `data:` URL, or `""` when it cannot be inlined within budget. */
async function loadImgSrc(src: string, options: InlineFormImagesOptions): Promise<string> {
	try {
		const media = await loadMedia(src, options);
		return `data:${media.mime};base64,${media.bytes.toBase64()}`;
	} catch (error) {
		logger.debug("ask form image could not be loaded", {
			src,
			error: error instanceof Error ? error.message : String(error),
		});
		return "";
	}
}

/**
 * Returns `html` with every non-`data:` `<img src>` replaced by a `data:` URL, or by `""` when
 * the source fails to load or the form's image budget is spent; everything else, `<svg>`
 * included, is untouched.
 */
export async function inlineFormImages(html: string, options: InlineFormImagesOptions): Promise<string> {
	const matches = findImgSrcs(html).filter(match => match.src !== "" && !/^data:/i.test(match.src));
	if (matches.length === 0) return html;

	const dataUris = await Promise.all(matches.map(match => loadImgSrc(match.src, options)));

	let budget = options.budgetBytes ?? FORM_IMAGE_BUDGET_BYTES;
	let out = "";
	let cursor = 0;
	for (const [i, match] of matches.entries()) {
		let value = dataUris[i];
		if (value !== "") {
			if (value.length > budget) value = "";
			else budget -= value.length;
		}
		out += html.slice(cursor, match.start) + `src="${value}"`;
		cursor = match.end;
	}
	out += html.slice(cursor);
	return out;
}
