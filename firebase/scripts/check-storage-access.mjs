import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const STORAGE_FIRESTORE_ROLE = 'roles/firebaserules.firestoreServiceAgent';

/** Emulator rule tests do not exercise production cross-service IAM. */
export function assertStorageAccess(policy, projectNumber) {
  if (!/^\d+$/.test(projectNumber)) throw new Error('A numeric Google Cloud project number is required.');
  const member = `serviceAccount:service-${projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
  const allowed = policy.bindings?.some(binding =>
    binding.role === STORAGE_FIRESTORE_ROLE && !binding.condition && binding.members?.includes(member));
  if (!allowed) {
    throw new Error(`Storage cannot evaluate Firestore-backed access rules. Grant ${STORAGE_FIRESTORE_ROLE} to ${member} in this project before deploying those rules. No permissions were changed.`);
  }
  return member;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const project = process.argv[2] || 'syncshot-v2';
    const projectNumber = execFileSync('gcloud', ['projects', 'describe', project, '--format=value(projectNumber)'], { encoding: 'utf8' }).trim();
    const policy = JSON.parse(execFileSync('gcloud', ['projects', 'get-iam-policy', project, '--format=json'], { encoding: 'utf8' }));
    assertStorageAccess(policy, projectNumber);
    console.log(`Storage/Firestore service permission verified for ${project}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
