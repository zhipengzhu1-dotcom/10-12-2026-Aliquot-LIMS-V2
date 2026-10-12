import { createHash } from "node:crypto";
import { Sha256 } from "./ids.js";

/**
 * JSON with object keys sorted at every depth and undefined values omitted,
 * so equal values always serialize to the same bytes.
 */
export const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) {
			sorted[k] = (v as Record<string, unknown>)[k];
		}
		return sorted;
	});

/** Lowercase hex sha256 of a string (as UTF-8) or of raw bytes. */
export const sha256Hex = (data: string | Uint8Array): Sha256 =>
	Sha256.parse(createHash("sha256").update(data).digest("hex"));
