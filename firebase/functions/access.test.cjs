const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accessState } = require('./lib/access');
test('lifetime is independent of an expired trial', () => assert.deepEqual(accessState(true, 0, 100), { state: 'licensed' }));
test('trial expires at exact boundary', () => assert.deepEqual(accessState(false, 100, 100), { state: 'expired' }));
test('malformed trial cannot grant access', () => assert.deepEqual(accessState(false, NaN, 100), { state: 'expired' }));
test('remaining trial uses server clock', () => assert.deepEqual(accessState(false, 86400100, 100), { state: 'trial', expiresAt: 86400100, daysLeft: 1 }));
