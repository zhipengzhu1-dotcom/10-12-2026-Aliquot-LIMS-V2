import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATOR_UNNAMED } from "../cli-support.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { seedRooms } from "../room/seed.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import { Email } from "../types/actor.js";
import { cloudflareAccess } from "./access.js";
import { type People, type Serving, serve } from "./http.js";

const TEAM = "aliquot-lab";
const AUD = "4d1f0c3e9a";
const KID = "key-1";
const ADA = Email.parse("ada@lab.test");
const BO = Email.parse("bo@lab.test");

const teamKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

const base64url = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

/** A Cf-Access-Jwt-Assertion for `email`, signed by the team's key. */
const token = (email: string) => {
	const header = base64url({ alg: "RS256", kid: KID, typ: "JWT" });
	const body = base64url({
		aud: [AUD],
		email,
		exp: Math.floor(Date.now() / 1000) + 600,
	});
	const signature = sign(
		"sha256",
		Buffer.from(`${header}.${body}`),
		teamKey,
	).toString("base64url");
	return `${header}.${body}.${signature}`;
};

const certs = (async () => {
	const jwk = teamKey.export({ format: "jwk" });
	return Response.json({
		keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: KID, alg: "RS256" }],
	});
}) as typeof fetch;

let ledger: Ledger;
let serving: Serving | undefined;

const start = async (people: People) => {
	ledger = openMemoryLedger();
	seedOrg(ledger, TEST_OPERATOR);
	seedRooms(ledger, TEST_OPERATOR);
	serving = await serve(ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: "/nonexistent",
		people,
	});
	return serving.url;
};

afterEach(async () => {
	if (serving === undefined) return;
	await serving.close();
	serving = undefined;
	ledger.close();
});

let url: string;

const headers = (email: string | undefined): Record<string, string> =>
	email === undefined ? {} : { "cf-access-jwt-assertion": token(email) };

const whoAmI = async (email?: string) => {
	const res = await fetch(`${url}/api/operator`, {
		headers: headers(email),
	});
	return { status: res.status, body: await res.text() };
};

const say = async (body: string, email?: string) => {
	const res = await fetch(`${url}/api/actions/room-say`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers(email) },
		body: JSON.stringify({ room_id: "RM-lab", body }),
	});
	return { status: res.status, body: await res.text() };
};

describe("aliquot serve behind Cloudflare Access, with two Operator emails", () => {
	const access = (): People => ({
		tag: "Access",
		admit: cloudflareAccess(
			{ team: TEAM, aud: AUD, emails: [ADA, BO] },
			{ fetch: certs },
		),
	});

	it("admits both listed people and refuses a third", async () => {
		url = await start(access());

		expect(await whoAmI("ada@lab.test")).toEqual({
			status: 200,
			body: '{"email":"ada@lab.test"}',
		});
		expect(await whoAmI("Bo@Lab.Test"), "an email ignoring case").toEqual({
			status: 200,
			body: '{"email":"bo@lab.test"}',
		});
		expect(await whoAmI("cy@lab.test")).toEqual({ status: 401, body: "" });
	});

	it("names on the Event a view action appends the person Access admitted", async () => {
		url = await start(access());

		const byAda = await say("Received 3 bottles", "ada@lab.test");
		const byBo = await say("Results follow", "bo@lab.test");
		const byCy = await say("Let me in", "cy@lab.test");

		expect(byAda.status).toBe(200);
		expect(JSON.parse(byAda.body).actor).toEqual({
			tag: "Operator",
			email: "ada@lab.test",
		});
		expect(JSON.parse(byBo.body).actor).toEqual({
			tag: "Operator",
			email: "bo@lab.test",
		});
		expect(byCy.status).toBe(401);
		expect(
			ledger.projections.rooms.messages.map((m) => m.body),
			"the refused person said nothing",
		).toEqual(["Received 3 bottles", "Results follow"]);
	});
});

describe("aliquot serve on 127.0.0.1 without Access", () => {
	it("acts for the person named at start, and says who that is", async () => {
		url = await start({ tag: "Local", email: ADA });

		expect(await whoAmI()).toEqual({
			status: 200,
			body: '{"email":"ada@lab.test"}',
		});
		const said = await say("Received 3 bottles");
		expect(JSON.parse(said.body).actor).toEqual({
			tag: "Operator",
			email: "ada@lab.test",
		});
	});

	it("refuses to start without a person, in the line every Operator command uses", () => {
		const home = mkdtempSync(join(tmpdir(), "aliquot-serve-"));
		const { ALIQUOT_OPERATOR: _, ...env } = process.env;
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(new URL("../cli.ts", import.meta.url)),
					"--home",
					home,
					"serve",
					"--port",
					"0",
					"--no-schedule",
				],
				{
					encoding: "utf8",
					env: { ...env, ALIQUOT_HOME: "" },
					timeout: 20_000,
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`error: ${OPERATOR_UNNAMED}\n`);
			expect(result.stdout).not.toContain("Serving");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
