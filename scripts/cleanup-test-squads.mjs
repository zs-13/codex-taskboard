#!/usr/bin/env node
// Clean up squads that were created by the collaboration / e2e / diagnostic
// harness (Delivery <epoch>-<hash>, E2E Squad, guard-test, probe agents, ...).
//
// Usage:
//   node scripts/cleanup-test-squads.mjs [--db <path>] [--apply]
//
// Default is a dry run: prints the squads that would be deleted and exits 0.
// Pass --apply to actually delete them through TaskboardDatabase.deleteSquad
// (same code path as DELETE /api/squads/:id) so activity is recorded.
//
// Default DB path: <repo>/.data/taskboard.sqlite
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TaskboardDatabase } from "../server/database.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbFlagIndex = args.indexOf("--db");
const defaultDbPath = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  ".data",
  "taskboard.sqlite",
);
const databasePath = dbFlagIndex !== -1 && args[dbFlagIndex + 1]
  ? resolve(args[dbFlagIndex + 1])
  : defaultDbPath;

// Returns true when the squad is a diagnostic/test artifact rather than a
// deliberately created user squad. Pattern is deliberately conservative: any
// ambiguous squad is left untouched for manual review.
function isTestSquad(squad) {
  const name = squad.name ?? "";
  const leader = squad.leaderAgentId ?? "";
  // Auto-generated names from the collaboration/e2e/guard harness.
  if (/^Delivery(\s|$)/.test(name)) return true;
  if (/E2E/.test(name)) return true;
  if (/guard-test/.test(name)) return true;
  if (/^Autonomy Squad/.test(name)) return true;
  if (/^Assigned Squad/.test(name)) return true;
  if (/CLI Test|probe|T5/i.test(name)) return true;
  // Leaders created by the agent-runner / diagnostic harness.
  if (/^(builder|reviewer|probe|assigned-mismatch|guard-agent|autotest)-/.test(leader)) return true;
  return false;
}

function main() {
  const database = new TaskboardDatabase(databasePath);
  try {
    const squads = database.listSquads();
    const matches = squads.filter(isTestSquad);
    const remaining = squads.filter((squad) => !isTestSquad(squad));

    if (matches.length === 0) {
      console.log(`No test squads found in ${databasePath}`);
      console.log(`Total squads: ${squads.length}`);
      return;
    }

    console.log(`Database: ${databasePath}`);
    console.log(`Total squads: ${squads.length}`);
    console.log(`Test squads to ${apply ? "DELETE" : "remove (dry run; add --apply to delete)"}: ${matches.length}`);
    for (const squad of matches) {
      console.log(`  - ${squad.name}  (leader: ${squad.leaderAgentId ?? "?"})  ${squad.id}`);
    }

    if (remaining.length > 0) {
      console.log(`\nSquads left untouched (${remaining.length}):`);
      for (const squad of remaining) {
        console.log(`  - ${squad.name}  (leader: ${squad.leaderAgentId ?? "?"})  ${squad.id}`);
      }
    }

    if (!apply) {
      console.log("\nDry run complete. Re-run with --apply to delete the squads above.");
      return;
    }

    let deleted = 0;
    for (const squad of matches) {
      try {
        database.deleteSquad(squad.id, { type: "agent", id: "cleanup-script", name: "Cleanup Script" });
        deleted += 1;
      } catch (error) {
        console.error(`  !! failed to delete ${squad.name} (${squad.id}): ${error.message}`);
      }
    }
    console.log(`\nDeleted ${deleted} test squad(s).`);
  } finally {
    database.close();
  }
}

main();
