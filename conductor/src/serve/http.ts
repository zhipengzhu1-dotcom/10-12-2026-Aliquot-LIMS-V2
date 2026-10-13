import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, resolve, sep } from "node:path";
import type { Ledger } from "../ledger.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import type { Admit } from "./access.js";
import { runAction } from "./actions.js";
import {
	isProjectionName,
	LEDGER_PAGE_LIMIT,
	ledgerPage,
	PROJECTION_ROUTES,
	toJson,
} from "./routes.js";
import { eventStream, lastEventId } from "./sse.js";

export type ServeOptions = {
	readonly port: number;
	readonly bind: string;
	/** The compiled single-page application: `index.html` and its modules. */
	readonly ui: string;
	/**
	 * Cloudflare Access. Without it the Conductor answers only requests addressed
	 * to the loopback host, so a page on another site cannot reach it by
	 * rebinding a hostname to 127.0.0.1.
	 */
	readonly admit?: Admit;
};

export type Serving = {
	/** `http://<bind>:<port>`, with the port the system chose for port 0. */
	readonly url: string;
	/** Stop listening and end every open Event stream. The Ledger stays open. */
	close(): Promise<void>;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/** The most a request body may hold; an Agent definition is far smaller. */
const MAX_BODY_BYTES = 1_000_000;

class BadRequest extends Error {}

const text = (res: ServerResponse, status: number, message: string) => {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(`${message}\n`);
};

const json = (res: ServerResponse, body: string) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(body);
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
	// A cross-site form or `fetch` can send text/plain without a CORS
	// preflight; it cannot send application/json.
	if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
		throw new BadRequest(
			"an action takes a JSON body with content-type application/json",
		);
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new BadRequest("the body is too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw new BadRequest(`the body is not JSON: ${(error as Error).message}`);
	}
};

const whole = (text: string | null, fallback: number, what: string) => {
	if (text === null) return fallback;
	if (!/^\d+$/.test(text)) {
		throw new BadRequest(
			`${what} must be a whole number, not ${JSON.stringify(text)}`,
		);
	}
	return Number(text);
};

const serveFile = async (res: ServerResponse, root: string, path: string) => {
	const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
	const type = CONTENT_TYPES[extname(file)];
	if (!file.startsWith(`${root}${sep}`) || type === undefined) {
		return text(res, 404, `no file ${path}`);
	}
	let content: Buffer;
	try {
		content = await readFile(file);
	} catch {
		return text(res, 404, `no file ${path}`);
	}
	res.writeHead(200, { "content-type": type });
	res.end(content);
};

/**
 * Serve the Operator's interface on `ledger`: every Projection as JSON, the
 * Ledger's Events as a stream, the Operator's actions, and the single-page
 * application.
 */
export const serve = async (
	ledger: Ledger,
	options: ServeOptions,
): Promise<Serving> => {
	const ui = resolve(options.ui);
	const events = eventStream(ledger);
	const { read } = openArtifacts({ ledger, home: dirname(ledger.path) });
	let loopbackHosts: ReadonlySet<string> = new Set();

	const route = async (req: IncomingMessage, res: ServerResponse) => {
		if (options.admit === undefined) {
			if (!loopbackHosts.has(req.headers.host ?? "")) {
				return text(
					res,
					403,
					"the Conductor answers only 127.0.0.1 without Cloudflare Access",
				);
			}
		} else if (!(await options.admit(req))) {
			res.writeHead(401);
			return res.end();
		}

		const url = new URL(req.url ?? "/", "http://conductor");
		const path = url.pathname;
		const action = /^\/api\/actions\/([^/]+)$/.exec(path)?.[1];
		if (req.method === "POST" && action !== undefined) {
			const result = runAction(ledger, action, await readJsonBody(req));
			return result.status === 200
				? json(res, toJson(result.event))
				: text(res, result.status, result.text);
		}
		if (req.method !== "GET")
			return text(res, 405, `${req.method} ${path} is not served`);

		if (path === "/api/events") {
			const after = lastEventId(req, url);
			if (after === "invalid")
				throw new BadRequest("Last-Event-ID must be a seq");
			return events.open(req, res, after);
		}
		if (path === "/api/ledger") {
			const from = whole(url.searchParams.get("from"), 1, "from");
			const limit = whole(
				url.searchParams.get("limit"),
				LEDGER_PAGE_LIMIT.default,
				"limit",
			);
			if (limit < 1 || limit > LEDGER_PAGE_LIMIT.max) {
				throw new BadRequest(`limit must be 1 to ${LEDGER_PAGE_LIMIT.max}`);
			}
			return json(res, toJson(ledgerPage(ledger.events(), from, limit)));
		}
		if (path === "/api/ledger/verify")
			return json(res, toJson(ledger.verify()));
		const name = /^\/api\/([^/]+)$/.exec(path)?.[1];
		if (name !== undefined && isProjectionName(name)) {
			return json(
				res,
				toJson(PROJECTION_ROUTES[name](ledger.projections, ledger.now(), read)),
			);
		}
		if (path.startsWith("/api/")) return text(res, 404, `no route ${path}`);
		return serveFile(res, ui, path);
	};

	const http = createServer((req, res) => {
		route(req, res).catch((error: unknown) => {
			if (error instanceof BadRequest) return text(res, 400, error.message);
			const message =
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error);
			process.stderr.write(`${req.method} ${req.url} failed: ${message}\n`);
			if (res.headersSent) return res.destroy();
			text(res, 500, message);
		});
	});

	await new Promise<void>((done, fail) => {
		http.once("error", fail);
		http.listen(options.port, options.bind, () => {
			http.off("error", fail);
			done();
		});
	});
	const { port } = http.address() as AddressInfo;
	loopbackHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

	return {
		url: `http://${options.bind}:${port}`,
		close: () =>
			new Promise<void>((done, fail) => {
				events.close();
				http.close((error) => (error ? fail(error) : done()));
				http.closeAllConnections();
			}),
	};
};
