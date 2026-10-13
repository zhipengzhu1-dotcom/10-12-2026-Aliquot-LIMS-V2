import type { IncomingMessage, ServerResponse } from "node:http";
import type { Event } from "../events.js";
import type { Ledger } from "../ledger.js";

/** Cloudflare closes a Tunnel connection that stays idle for 100 s. */
const KEEPALIVE_MS = 30_000;

const frame = (event: Event) =>
	`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * The seq a reconnecting client last read: its `Last-Event-ID`, which an
 * `EventSource` sends when it reconnects by itself, else `?lastEventId=`,
 * which a page that opens a new `EventSource` must use since it cannot set
 * the header.
 */
export const lastEventId = (
	req: IncomingMessage,
	url: URL,
): number | undefined | "invalid" => {
	const given =
		req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
	if (given === undefined || given === null) return undefined;
	return typeof given === "string" && /^\d+$/.test(given)
		? Number(given)
		: "invalid";
};

/**
 * `GET /api/events`: one Server-Sent Event per Event the Ledger appends, with
 * its seq as the event id. A client that sends `Last-Event-ID` first gets
 * every Event after that seq from the Ledger, so a reconnect misses nothing.
 */
export const eventStream = (ledger: Ledger) => {
	const clients = new Set<ServerResponse>();
	const stopListening = ledger.onAppend((event) => {
		for (const res of clients) res.write(frame(event));
	});

	return {
		open(req: IncomingMessage, res: ServerResponse, after: number | undefined) {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.flushHeaders();
			// Appends run synchronously in this process, so none lands between the replay and
			// joining `clients`.
			if (after !== undefined) {
				for (const event of ledger.events()) {
					if (event.seq > after) res.write(frame(event));
				}
			}
			clients.add(res);
			const keepalive = setInterval(
				() => res.write(": keepalive\n\n"),
				KEEPALIVE_MS,
			);
			req.on("close", () => {
				clearInterval(keepalive);
				clients.delete(res);
			});
		},
		close() {
			stopListening();
			for (const res of clients) res.end();
			clients.clear();
		},
	};
};
