import {redactText, sanitizeRequestPath} from './redaction.js';

type DiagnosticRule = {
	readonly namespace: RegExp;
	readonly message: RegExp;
	readonly render: (match: RegExpExecArray) => string;
};

const verbatim = (match: RegExpExecArray) => match[0];

/**
 * Dependency debug messages reviewed as safe, reduced to the parts worth
 * keeping. Messages that embed response bodies, two-factor details, realtime
 * payloads or credentials keep only their fixed wording.
 */
const rules: readonly DiagnosticRule[] = [
	{
		namespace: /^ig:request$/,
		message: /^Requesting ([A-Z]+) (\S+)$/,
		render: match => `Requesting ${match[1]} ${sanitizeRequestPath(match[2]!)}`,
	},
	{
		namespace: /^ig:request$/,
		message: /^Request ([A-Z]+) (\S+) failed: /,
		render: match =>
			`Request ${match[1]} ${sanitizeRequestPath(match[2]!)} failed (response body withheld)`,
	},
	{
		namespace: /^ig:account$/,
		message: /^Login failed, two factor auth required/,
		render: () => 'Login failed, two factor auth required (details withheld)',
	},
	{
		namespace: /^ig:state$/,
		message: /^Could not parse authorization/,
		render: () => 'Could not parse authorization (details withheld)',
	},
	{
		namespace: /^ig:state$/,
		message:
			/^(?:csrftoken lookup failed, returning "missing"\.|Could not find [a-z_]+|Deserializing state of type \w+|State deserialization failed, obj is of type \w+ \(object expected\)|Deserializing [\w, ]*)$/,
		render: verbatim,
	},
	{
		namespace: /^ig:mqtt:realtime$/,
		message:
			/^(?:Applying mixins: [\w, ]*|Connecting to realtime-broker\.\.\.|Overriding: [\w, ]*|Connected\. Checking initial subs\.|Iris Sub to: seqId: \d+, snapshot: \d+)$/,
		render: verbatim,
	},
	{
		namespace: /^ig:mqtt:realtime$/,
		message: /^Subscribing with (GraphQL|Skywalker) to /,
		render: match => `Subscribing with ${match[1]} (topics withheld)`,
	},
	{
		namespace: /^ig:mqtt:realtime:message$/,
		message: /^Received (?:raw )?on ([\w/]+)/,
		render: match => `Received on ${match[1]} (payload withheld)`,
	},
	{
		namespace: /^ig:mqtt:mqttot$/,
		message: /: Publishing (\d+)bytes to topic ([\w/]+)$/,
		render: match => `Publishing ${match[1]} bytes to topic ${match[2]}`,
	},
];

/**
 * The loggable form of one dependency debug message. Anything not reviewed is
 * withheld, whatever namespaces DEBUG enables, so a verbose run cannot expose
 * credentials; the namespace and size still show that it happened.
 */
export function safeDebugLine(
	namespace: string | undefined,
	message: string,
): string {
	const name = namespace ?? 'debug';
	for (const rule of rules) {
		if (!rule.namespace.test(name)) {
			continue;
		}

		const match = rule.message.exec(message);
		if (match) {
			return `${name}: ${redactText(rule.render(match))}`;
		}
	}

	return `${name}: message withheld (${message.length} chars)`;
}
