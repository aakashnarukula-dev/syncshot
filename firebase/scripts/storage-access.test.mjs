import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStorageAccess, STORAGE_FIRESTORE_ROLE } from './check-storage-access.mjs';
const member = 'serviceAccount:service-123@gcp-sa-firebasestorage.iam.gserviceaccount.com';
const binding = { role: STORAGE_FIRESTORE_ROLE, members: [member] };

test('accepts the storage service agent cross-service role', () => {
  assert.equal(assertStorageAccess({ bindings: [binding] }, '123'), member);
});
test('rejects storage-only permission that caused production uploads to fail', () => {
  assert.throws(() => assertStorageAccess({ bindings: [{ ...binding, role: 'roles/firebasestorage.serviceAgent' }] }, '123'), /cannot evaluate/);
});
test('rejects grants to another project or a conditional binding', () => {
  assert.throws(() => assertStorageAccess({ bindings: [binding] }, '456'), /cannot evaluate/);
  assert.throws(() => assertStorageAccess({ bindings: [{ ...binding, condition: { expression: 'false' } }] }, '123'), /cannot evaluate/);
});
test('rejects missing permissions without changing the policy', () => {
  const policy = { bindings: [] };
  assert.throws(() => assertStorageAccess(policy, '123'), /cannot evaluate/);
  assert.deepEqual(policy, { bindings: [] });
});
