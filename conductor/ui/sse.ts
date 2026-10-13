/** One Ledger Event as `/api/events` sends it. */
export type LedgerEvent = {
	readonly seq: number;
	readonly kind: string;
	readonly [field: string]: unknown;
};

const RECONNECT_MS = 2000;

/**
 * Call `listener` with every Ledger Event from now on. An `EventSource`
 * reconnects by itself after a dropped connection and sends `Last-Event-ID`;
 * one the server answered with an error status stays closed, so this opens
 * a new one that names the last seq it read, and the Ledger replays the rest.
 */
export const onLedgerEvent = (listener: (event: LedgerEvent) => void): void => {
	let last: string | undefined;
	const connect = () => {
		const source = new EventSource(
			last === undefined
				? "/api/events"
				: `/api/events?lastEventId=${encodeURIComponent(last)}`,
		);
		source.onmessage = (message) => {
			last = message.lastEventId;
			listener(JSON.parse(message.data) as LedgerEvent);
		};
		source.onerror = () => {
			if (source.readyState === EventSource.CLOSED) {
				setTimeout(connect, RECONNECT_MS);
			}
		};
	};
	connect();
};
