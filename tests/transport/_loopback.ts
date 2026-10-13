import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import {fileURLToPath} from 'node:url';

const fixtures = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'_fixtures',
);

export type CertificateName = 'localhost' | 'wrong-host' | 'self-signed';

/** A PEM fixture's text. */
export function fixture(name: string): string {
	return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

/** The synthetic root that only these tests trust. */
export function testCertificateAuthority(): string {
	return fixture('ca.crt');
}

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Allow sockets only to loopback ports a test opened; anything else throws
 * before connecting and is counted.
 */
export function allowLoopbackOnly() {
	const ports = new Set<number>();
	const denied: string[] = [];
	const original = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (
		this: net.Socket,
		...parameters: unknown[]
	) {
		// Node passes either (options), (port, host) or a normalized [options].
		const first: unknown = Array.isArray(parameters[0])
			? (parameters[0] as unknown[])[0]
			: parameters[0];
		const options =
			typeof first === 'object' && first !== null
				? (first as {host?: string; port?: number | string})
				: {port: first as number, host: parameters[1] as string | undefined};
		const host = options.host ?? 'localhost';
		const port = Number(options.port);
		if (!loopbackHosts.has(host) || !ports.has(port)) {
			denied.push(`${host}:${String(options.port)}`);
			throw new Error('Connection outside the test loopback servers denied');
		}

		return Reflect.apply(original, this, parameters) as net.Socket;
	} as typeof original;

	return {
		allow(port: number) {
			ports.add(port);
		},
		get denied(): readonly string[] {
			return denied;
		},
		restore() {
			net.Socket.prototype.connect = original;
		},
	};
}

export type LoopbackGuard = ReturnType<typeof allowLoopbackOnly>;

/** TLS options every handshake in this process was started with. */
export function recordTlsOptions() {
	const seen: tls.ConnectionOptions[] = [];
	const original = tls.connect;
	tls.connect = function (...parameters: unknown[]) {
		const options = parameters.find(
			parameter => typeof parameter === 'object' && parameter !== null,
		);
		if (options) {
			seen.push({...(options as tls.ConnectionOptions)});
		}

		return Reflect.apply(original, tls, parameters) as tls.TLSSocket;
	} as typeof tls.connect;
	return {
		seen,
		restore() {
			tls.connect = original;
		},
	};
}

type Closable = {
	readonly port: number;
	close(): Promise<void>;
};

async function listen(
	server: http.Server | https.Server,
	guard: LoopbackGuard,
	sockets: Set<net.Socket>,
): Promise<Closable> {
	server.on('connection', (socket: net.Socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as net.AddressInfo;
	guard.allow(port);
	return {
		port,
		async close() {
			for (const socket of sockets) {
				socket.destroy();
			}

			await new Promise<void>(resolve => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}

/** An HTTPS endpoint presenting `certificate`; records requests it served. */
export async function startTlsServer(
	certificate: CertificateName,
	guard: LoopbackGuard,
) {
	const requests: string[] = [];
	const server = https.createServer(
		{key: fixture(`${certificate}.key`), cert: fixture(`${certificate}.crt`)},
		(request, response) => {
			requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({status: 'ok'}));
		},
	);
	const sockets = new Set<net.Socket>();
	return {...(await listen(server, guard, sockets)), requests};
}

/**
 * A CONNECT proxy that relays every tunnel to `targetPort` on loopback,
 * whatever authority the client asked for, as an intercepting proxy would.
 * With `certificate`, clients reach the proxy itself over TLS.
 */
export async function startConnectProxy(
	targetPort: number,
	guard: LoopbackGuard,
	certificate?: CertificateName,
) {
	const authorities: string[] = [];
	const server = certificate
		? https.createServer({
				key: fixture(`${certificate}.key`),
				cert: fixture(`${certificate}.crt`),
			})
		: http.createServer();
	const sockets = new Set<net.Socket>();
	server.on(
		'connect',
		(request: http.IncomingMessage, client: net.Socket, head: Uint8Array) => {
			authorities.push(request.url ?? '');
			sockets.add(client);
			const upstream = net.connect(targetPort, '127.0.0.1', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			sockets.add(upstream);
			upstream.on('error', () => client.destroy());
			client.on('error', () => upstream.destroy());
		},
	);
	return {...(await listen(server, guard, sockets)), authorities};
}
