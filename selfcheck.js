'use strict';

// Offline self-check, no network or token: node selfcheck.js
const assert = require('assert');
const { respond, chunk, buildBody, optionLabel } = require('./lib/core');

assert.strictEqual(chunk('a'.repeat(4500)).length, 3);
assert.strictEqual(chunk('short').length, 1);
assert.strictEqual(buildBody({}, 'hi', null), 'hi');
assert.strictEqual(buildBody({ DISCORD_MENTION_USER_ID: '42' }, 'hi', null), '<@42> hi');
assert.ok(buildBody({}, 'pick', ['a', 'b']).includes('1️⃣ a\n2️⃣ b'));
assert.strictEqual(optionLabel('1️⃣ Yes, deploy\n2️⃣ No', 0), 'Yes, deploy');
assert.strictEqual(optionLabel('nope', 2), 'option 3');

(async () => {
  const init = await respond({}, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  const list = await respond({}, { id: 2, method: 'tools/list' });
  assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['notify', 'check_replies', 'wait_for_reply']);
  assert.strictEqual((await respond({}, { id: 3, method: 'nope' })).error.code, -32601);
  const noToken = await respond({}, { id: 4, method: 'tools/call', params: { name: 'notify', arguments: { message: 'hi' } } });
  assert.strictEqual(noToken.error.message, 'DISCORD_BOT_TOKEN is not set');
  const tooMany = await respond({ DISCORD_BOT_TOKEN: 'x', DISCORD_CHANNEL_ID: 'y' }, {
    id: 5,
    method: 'tools/call',
    params: { name: 'notify', arguments: { message: 'hi', options: ['1', '2', '3', '4', '5', '6'] } },
  });
  assert.strictEqual(tooMany.error.code, -32602);
  assert.strictEqual(await respond({}, { method: 'notifications/initialized' }), null);
  console.log('self-check OK');
})();
