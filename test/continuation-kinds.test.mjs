import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationKindDecision, REV16_CONTINUATION_KINDS } from '../scripts/lib/continuation-kinds.mjs';

test('absent member, unreadable bodies and malformed lists are ok (the deployment decides at POST)', () => {
  for (const caps of [{ data: {} }, {}, null, undefined, 'x', { data: { continuation_kinds: 'mcp_held' } }, { data: { continuation_kinds: [1] } }]) {
    assert.deepEqual(continuationKindDecision(caps), { ok: true });
  }
});
test('the rev-16 default set contains mcp_held, so absent never refuses', () => {
  assert.ok(REV16_CONTINUATION_KINDS.includes('mcp_held'));
});
test('listed with mcp_held is ok; listed without is refused with the advertised list; bare and enveloped both read', () => {
  assert.deepEqual(continuationKindDecision({ data: { continuation_kinds: ['mcp_held'] } }), { ok: true });
  assert.deepEqual(continuationKindDecision({ continuation_kinds: ['adk'] }), { ok: false, advertised: ['adk'] });
  assert.deepEqual(continuationKindDecision({ data: { continuation_kinds: [] } }), { ok: false, advertised: [] });
});
