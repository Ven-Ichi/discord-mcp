'use strict';

// Offline self-check, no network or token: node selfcheck.js
const assert = require('assert');
const { respond, chunk, buildBody, optionLabel, checkReplies } = require('./lib/core');

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
  const originalFetch = global.fetch;
  let reactionReads = 0;
  let botReacted = false;
  global.fetch = async (url) => {
    let data;
    if (url.endsWith('/users/@me')) data = { id: '1' };
    else if (url.includes('/reactions/')) {
      reactionReads++;
      data = [{ id: '2', username: 'Josh', bot: false }];
    } else data = [{ id: '10', author: { id: '1' }, content: 'pick',
      reactions: [{ emoji: { name: '👍' }, count: 1, me: botReacted }] }];
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    const env = { DISCORD_BOT_TOKEN: 'test', DISCORD_CHANNEL_ID: 'test' };
    assert.strictEqual((await checkReplies(env)).hasReplies, true);
    assert.strictEqual(reactionReads, 1);
    const answer = await respond(env, { id: 6, method: 'tools/call',
      params: { name: 'wait_for_reply', arguments: { seconds: 1 } } });
    assert.match(answer.result.content[0].text, /Answered by Josh/);
    assert.strictEqual(reactionReads, 2);
    botReacted = true;
    assert.strictEqual((await checkReplies(env)).hasReplies, false);
    assert.strictEqual(reactionReads, 2);
    const clamped = await respond({ ...env, WAIT_MAX_SECONDS: '1' }, { id: 7, method: 'tools/call',
      params: { name: 'wait_for_reply', arguments: { seconds: 999 } } });
    assert.strictEqual(clamped.result.content[0].text, 'No answer within 1s. Call wait_for_reply again to keep waiting.');
  } finally {
    global.fetch = originalFetch;
  }
  console.log('self-check OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
