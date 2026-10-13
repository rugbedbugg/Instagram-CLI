import net from 'node:net';

/**
 * Fail closed on outbound sockets in UI tests that render mock imagery.
 * Image components fetch their sources and cannot cancel on unmount, so a
 * remote URL would keep the AVA worker alive until a third-party host answers.
 * Mock images are data URIs, which fetch resolves without any socket.
 */
export function denyOutboundSockets() {
	let attempts = 0;
	const original = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (): never {
		attempts++;
		throw new Error('Outbound sockets are forbidden in UI tests');
	};

	return {
		get attempts() {
			return attempts;
		},
		restore() {
			net.Socket.prototype.connect = original;
		},
	};
}
