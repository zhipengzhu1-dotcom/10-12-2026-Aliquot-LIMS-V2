import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { cloudflareAccess } from "./access.js";
import { type Serving, serve } from "./http.js";

const TEAM = "aliquot-lab";
const AUD = "4d1f0c3e9a";
const EMAIL = "operator@example.com";
const KID = "key-1";

const keyPair = () =>
	generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const teamKey = keyPair();

const base64url = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

/** A Cf-Access-Jwt-Assertion signed with `key`, for the Operator unless `claims` say otherwise. */
const token = (
	claims: Record<string, unknown> = {},
	key: KeyObject = teamKey,
) => {
	const header = base64url({ alg: "RS256", kid: KID, typ: "JWT" });
	const body = base64url({
		aud: [AUD],
		email: EMAIL,
		exp: Math.floor(Date.now() / 1000) + 600,
		iss: `https://${TEAM}.cloudflareaccess.com`,
		...claims,
	});
	const signature = sign(
		"sha256",
		Buffer.from(`${header}.${body}`),
		key,
	).toString("base64url");
	return `${header}.${body}.${signature}`;
};

let fetched: string[];
let ledger: Ledger;
let serving: Serving;

beforeEach(async () => {
	fetched = [];
	const jwk = { ...teamKey.export({ format: "jwk" }), kid: KID };
	const publicJwk = {
		kty: jwk.kty,
		n: jwk.n,
		e: jwk.e,
		kid: KID,
		alg: "RS256",
	};
	const certs = (async (url: string | URL | Request) => {
		fetched.push(String(url));
		return Response.json(
			{ keys: [publicJwk] },
			{ headers: { "cache-control": "max-age=600" } },
		);
	}) as typeof fetch;
	ledger = openMemoryLedger();
	seedOrg(ledger);
	serving = await serve(ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: "/nonexistent",
		admit: cloudflareAccess(
			{ team: TEAM, aud: AUD, email: EMAIL },
			{ fetch: certs },
		),
	});
});

afterEach(async () => {
	await serving.close();
	ledger.close();
});

const getOrg = async (assertion?: string) => {
	const res = await fetch(`${serving.url}/api/org`, {
		headers:
			assertion === undefined ? {} : { "cf-access-jwt-assertion": assertion },
	});
	return { status: res.status, body: await res.text() };
};

describe("aliquot serve with Cloudflare Access", () => {
	it("admits the Operator's assertion, signed by a key the team publishes", async () => {
		const admitted = await getOrg(token());

		expect(admitted.status).toBe(200);
		expect(JSON.parse(admitted.body).agents["A-rin"].definition.name).toBe(
			"Rin",
		);
		expect(fetched).toEqual([
			"https://aliquot-lab.cloudflareaccess.com/cdn-cgi/access/certs",
		]);
	});

	it.each([
		["no assertion", undefined],
		["a signature by another key", token({}, keyPair())],
		["a wrong aud", token({ aud: ["another-app"] })],
		["another email", token({ email: "someone@example.com" })],
		["an exp in the past", token({ exp: Math.floor(Date.now() / 1000) - 1 })],
		["a token that is not a JWT", "not-a-jwt"],
	])("answers 401 and no body to %s", async (_, assertion) => {
		const refused = await getOrg(assertion);

		expect(refused).toEqual({ status: 401, body: "" });
	});

	it("fetches the team's keys once while they are fresh", async () => {
		await getOrg(token());
		await getOrg(token());
		await getOrg(token({ email: "someone@example.com" }));

		expect(fetched).toHaveLength(1);
	});
});
