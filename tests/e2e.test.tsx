/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- xo cannot resolve ink-testing-library types in tests */

import React from 'react';
import test, {type ExecutionContext} from 'ava';
import {render} from 'ink-testing-library';
import Index from '../source/commands/index.js';
import Version from '../source/commands/version.js';
import {AppMock} from '../source/mocks/app.mock.js';
import {mockThreads, mockMessages} from '../source/mocks/mock-data.js';
import {waitForFrame} from './_wait-for-frame.js';
import {denyOutboundSockets} from './_deny-sockets.js';

const network = denyOutboundSockets();
test.after.always('opens no outbound sockets', t => {
	network.restore();
	t.is(network.attempts, 0);
});

test('sanity check', (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<Index />);

	t.not(lastFrame(), undefined);
	unmount();
});

test('unknown command shows helpful error', (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<Index args={['asdfljk']} />);
	const output = lastFrame()!;
	t.true(output.includes('Unknown command'));
	t.true(output.includes('asdfljk'));
	t.true(output.includes('--help'));
	t.true(output.includes('insta-cli --help'));
	unmount();
});

test('version command renders all version info', async (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<Version />);

	// Version info is loaded asynchronously (package.json lookups), so wait for
	// it to render rather than for a fixed time.
	const output = await waitForFrame(lastFrame, frame =>
		frame.includes('Instagram app version:'),
	);
	t.regex(
		output ?? '',
		/Instagram-CLI \(insta-cli\): v\d+\.\d+\.\d+/,
		'Should display the downstream project and package with a valid version',
	);
	t.false(output.includes('@i7m/instagram-cli'));
	t.regex(
		output ?? '',
		/instagram-private-api: v\d+\.\d+\.\d+ \(patched\)/,
		'Should display instagram-private-api with a valid version number and (patched) label',
	);
	t.regex(
		output ?? '',
		// eslint-disable-next-line unicorn/better-regex
		/Instagram app version: \d+\.\d+\.\d+\.\d+\.\d+/,
		'Should display Instagram app version as a valid version number',
	);
	unmount();
});

test('renders chat view', (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<AppMock view="chat" />);

	t.not(lastFrame(), undefined);
	unmount();
});

test('renders feed view', (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<AppMock view="feed" />);

	t.not(lastFrame(), undefined);
	unmount();
});

test('renders stories view', (t: ExecutionContext) => {
	const {lastFrame, unmount} = render(<AppMock view="story" />);

	t.not(lastFrame(), undefined);
	unmount();
});

test('chat view displays messages when thread is selected', async (t: ExecutionContext) => {
	const {lastFrame, stdin, unmount} = render(<AppMock view="chat" />);

	// Threads arrive after the mock client's simulated latency; wait for them
	// rather than for a fixed time.
	let output = await waitForFrame(lastFrame, frame =>
		frame.includes(mockThreads[0]!.title),
	);
	t.truthy(output, 'Frame should render threads');
	t.true(
		output.includes(mockThreads[0]!.title),
		'Thread should be visible before selection',
	);

	// Select first thread by pressing Enter
	stdin.write('\r');

	const lastMessage = mockMessages.at(-1)!;
	output = await waitForFrame(
		lastFrame,
		frame =>
			lastMessage.itemType === 'text' && frame.includes(lastMessage.text),
	);
	t.truthy(output, 'Frame should render after thread selection');
	if (lastMessage.itemType === 'text') {
		t.true(
			output.includes(lastMessage.text),
			'First message should be visible',
		);
	} else {
		t.fail('Expected last mock message to be text');
	}

	unmount();
});
