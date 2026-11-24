#!/usr/bin/env node
// Runs exactly one red test by id: node tests/red/run.mjs <id>
// Exit 0 pass, 1 fail (the message is printed), 3 unknown id. An unknown id
// never passes, so a typo in manifest.json cannot turn a test green.
import p3a from "./cases/p3a.mjs";
import p3b from "./cases/p3b.mjs";
import p3c from "./cases/p3c.mjs";

const all = { ...p3a, ...p3b, ...p3c };
const id = process.argv[2];
if (!id || !Object.hasOwn(all, id)) {
  console.error(`red: unknown test ${JSON.stringify(id)}`);
  process.exit(3);
}
try {
  await all[id]();
  console.log(`PASS ${id}`);
} catch (e) {
  console.log(`FAIL ${id}: ${e?.message ?? e}`);
  process.exit(1);
}
