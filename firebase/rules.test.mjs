import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
let env;
before(async () => {
 env = await initializeTestEnvironment({ projectId: 'demo-syncshot', firestore: { rules: await readFile(new URL('./firestore.rules', import.meta.url), 'utf8') }, storage: { rules: await readFile(new URL('./storage.rules', import.meta.url), 'utf8') } });
 await env.withSecurityRulesDisabled(async context => {
  for (const [uid, lifetime, offset] of [['paid',true,-10000], ['trial',false,3600000], ['expired',false,-10000]]) {
   await setDoc(doc(context.firestore(), 'entitlements', uid), { lifetime, trialExpiresAt: Timestamp.fromMillis(Date.now()+offset) });
   await setDoc(doc(context.firestore(), 'users', uid, 'screenshots', 'existing'), { name: 'private' });
  }
 });
});
after(async () => { await env?.cleanup(); });
test('paid and trial accounts can access their own library', async () => {
 for (const uid of ['paid','trial']) await assertSucceeds(getDoc(doc(env.authenticatedContext(uid).firestore(),'users',uid,'screenshots','existing')));
});
test('expired, unknown and anonymous accounts cannot read paid data', async () => {
 await assertFails(getDoc(doc(env.authenticatedContext('expired').firestore(),'users','expired','screenshots','existing')));
 await assertFails(getDoc(doc(env.authenticatedContext('unknown').firestore(),'users','unknown','screenshots','existing')));
 await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),'users','paid','screenshots','existing')));
});
test('paid users cannot read another account or self-grant access', async () => {
 const db=env.authenticatedContext('paid').firestore();
 await assertFails(getDoc(doc(db,'users','trial','screenshots','existing')));
 await assertFails(setDoc(doc(db,'entitlements','paid'),{lifetime:true}));
 await assertFails(setDoc(doc(env.authenticatedContext('expired').firestore(),'entitlements','expired'),{lifetime:true}));
});
test('uploads require active access, correct account and image content type', async () => {
 const storage=env.authenticatedContext('paid').storage();
 await assertSucceeds(uploadBytes(ref(storage,'users/paid/screenshots/test/full.png'),new Uint8Array([1]),{contentType:'image/png'}));
 await assertFails(uploadBytes(ref(storage,'users/trial/screenshots/test/full.png'),new Uint8Array([1]),{contentType:'image/png'}));
 await assertFails(uploadBytes(ref(storage,'users/paid/screenshots/test/script.html'),new Uint8Array([1]),{contentType:'text/html'}));
 await assertFails(uploadBytes(ref(env.authenticatedContext('expired').storage(),'users/expired/screenshots/test/full.png'),new Uint8Array([1]),{contentType:'image/png'}));
});
