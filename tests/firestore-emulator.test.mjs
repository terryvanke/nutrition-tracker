import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-nutriai-rules',
  firestore: {
    rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  }
});

try {
  const alice = testEnv.authenticatedContext('alice').firestore();
  const bob = testEnv.authenticatedContext('bob').firestore();
  const anonymous = testEnv.unauthenticatedContext().firestore();
  const aliceProfile = doc(alice, 'users/alice/profile/current');

  await assertSucceeds(setDoc(aliceProfile, {
    gender: 'female', age: 30, height: 165, weight: 60,
    goal: 'maintain', activity: 1.55, bmr: 1400, tdee: 2100,
    targetKcal: 2000, schemaVersion: 2, updatedAt: new Date()
  }));
  await assertSucceeds(getDoc(aliceProfile));
  await assertFails(getDoc(doc(bob, 'users/alice/profile/current')));
  await assertFails(getDoc(doc(anonymous, 'users/alice/profile/current')));
  await assertFails(setDoc(doc(alice, 'users/alice'), {
    appState: '{}', updatedAt: new Date()
  }));

  await assertFails(setDoc(doc(alice, 'users/alice/profile/current'), {
    gender: 'female', unknownField: true
  }));
  await assertFails(setDoc(doc(alice, 'users/alice/foodLogs/not-a-date'), {
    entries: [], schemaVersion: 2, updatedAt: new Date()
  }));
  await assertSucceeds(setDoc(doc(alice, 'users/alice/foodLogs/2026-07-15'), {
    entries: [], schemaVersion: 2, clientUpdatedAt: Date.now(), updatedAt: new Date()
  }));
  await assertFails(setDoc(doc(bob, 'users/alice/foodLogs/2026-07-15'), {
    entries: [], schemaVersion: 2, updatedAt: new Date()
  }));
  await assertFails(setDoc(doc(alice, 'users/alice/waterLogs/2026-07-15'), {
    total: 999999, records: [], schemaVersion: 2, updatedAt: new Date()
  }));
  await assertSucceeds(deleteDoc(aliceProfile));

  console.log('PASS Firestore emulator authorization tests');
} finally {
  await testEnv.cleanup();
}

assert.ok(true);
