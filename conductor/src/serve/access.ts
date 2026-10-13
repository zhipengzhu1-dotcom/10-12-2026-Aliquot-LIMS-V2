import { createPublicKey, type KeyObject, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";

/** Who Cloudflare Access must vouch for: `--access-team`, `--access-aud` and `--operator-email`. */
export type AccessPolicy = {
	readonly team: string;
	readonly aud: string;
	readonly email: string;
};

/** Whether a request may reach the Conductor. */
export type Admit = (req: IncomingMessage) => Promise<boolean>;

/** Without a `max-age`, the team's keys are fetched again after an hour. */
const DEFAULT_CERTS_LIFETIME_S = 3600;

const Jwk = z.looseObject({ kid: z.string(), kty: z.literal("RSA") });
const Certs = z.looseObject({ keys: z.array(Jwk) });

const Header = z.looseObject({ alg: z.literal("RS256"), kid: z.string() });
const Claims = z.looseObject({
	aud: z.union([z.string(), z.array(z.string())]),
	email: z.string(),
	exp: z.number(),
});

const decoded = (part: string): unknown => {
	try {
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
};

export const certsUrl = (team: string) =>
	`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;

/**
 * Admit a request only when its `Cf-Access-Jwt-Assertion` carries an RS256
 * signature by one of the team's published keys, an `aud` that includes the
 * policy's, the Operator's email, and an `exp` still ahead. The keys are
 * fetched on first use and kept for the lifetime their response gives.
 */
export const cloudflareAccess = (
	policy: AccessPolicy,
	{
		fetch: fetchCerts = fetch,
		now = () => new Date(),
	}: { fetch?: typeof fetch; now?: () => Date } = {},
): Admit => {
	const url = certsUrl(policy.team);
	let cached: { keys: Map<string, KeyObject>; until: number } | undefined;
	let loading: Promise<Map<string, KeyObject>> | undefined;

	const load = async () => {
		const res = await fetchCerts(url);
		if (!res.ok) throw new Error(`${url} answered ${res.status}`);
		const certs = Certs.parse(await res.json());
		const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
		const lifetime_s = maxAge?.[1]
			? Number(maxAge[1])
			: DEFAULT_CERTS_LIFETIME_S;
		const keys = new Map(
			certs.keys.map((jwk) => [
				jwk.kid,
				createPublicKey({ key: jwk, format: "jwk" }),
			]),
		);
		cached = { keys, until: now().getTime() + lifetime_s * 1000 };
		return keys;
	};

	const keys = () => {
		if (cached !== undefined && cached.until > now().getTime()) {
			return Promise.resolve(cached.keys);
		}
		loading ??= load().finally(() => {
			loading = undefined;
		});
		return loading;
	};

	return async (req) => {
		const token = req.headers["cf-access-jwt-assertion"];
		if (typeof token !== "string") return false;
		const [header, claims, signature, ...extra] = token.split(".");
		if (
			header === undefined ||
			claims === undefined ||
			signature === undefined ||
			extra.length > 0
		) {
			return false;
		}
		const parsedHeader = Header.safeParse(decoded(header));
		if (!parsedHeader.success) return false;
		const key = (await keys()).get(parsedHeader.data.kid);
		if (key === undefined) return false;
		const signed = verify(
			"sha256",
			Buffer.from(`${header}.${claims}`),
			key,
			Buffer.from(signature, "base64url"),
		);
		if (!signed) return false;
		const parsedClaims = Claims.safeParse(decoded(claims));
		if (!parsedClaims.success) return false;
		const { aud, email, exp } = parsedClaims.data;
		return (
			(Array.isArray(aud) ? aud : [aud]).includes(policy.aud) &&
			email.toLowerCase() === policy.email.toLowerCase() &&
			exp * 1000 > now().getTime()
		);
	};
};
