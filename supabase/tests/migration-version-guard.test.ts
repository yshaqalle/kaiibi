// Migration version-number collisions, guarded across worktrees and branches.
//
// `supabase db push` keys a migration by its VERSION -- the leading
// timestamp in the filename -- never by its content or its name. Two
// branches that each pick "tomorrow" for that timestamp end up with the
// SAME version on TWO DIFFERENT FILES, and db push applies whichever one it
// sees first; the other is silently never run, in production, with no
// error at all.
//
// That is not hypothetical. It is this repo's history, three times over:
//   - db17dc8 moved a grant migration out of the accounting branch's
//     timestamp window after it collided with another branch's.
//   - the phase-3a branch shipped 20260927000000_statement_lines.sql while
//     main independently grew 20260927000000_place_order.sql.
//   - renumbering that into 20260928000* collided immediately with
//     .claude/worktrees/storefront-fulfilment's already-committed
//     20260928000000_delivery_income_account.sql and
//     20260928000100_order_transitions.sql.
//
// Each was caught by luck, not by anything that ran on `npm test`. A
// convention written in a document -- docs/superpowers/ACCOUNTING-ROADMAP.md
// now reserves 202610* for accounting work -- does not enforce itself.
//
// WHAT THIS CHECKS, and why:
//
//   1. supabase/migrations/ against itself. The case a plain `ls | sort`
//      would already catch, except nobody runs that by hand every time.
//
//   2. supabase/migrations/ against every OTHER worktree under
//      .claude/worktrees/*/. This is what would have caught incident 3
//      above, and it costs nothing but a filesystem read: no git process,
//      no network. It also catches a branch that is only ever local --
//      `worktree-storefront-fulfilment` has no `origin/` counterpart at
//      all, so it is invisible to every other check here.
//
//   3. supabase/migrations/ against every branch this repo's git already
//      knows about, local AND remote (`git for-each-ref refs/heads
//      refs/remotes`). This is what would have caught incidents 1 and 2,
//      both of which were collisions with a branch nobody had checked out
//      as a worktree. `git for-each-ref` and `git ls-tree` read local refs
//      only; neither touches the network, so a stale or disconnected
//      checkout degrades to "nothing further to compare against" rather
//      than hanging or failing for an unrelated reason -- measured at ~1.1s
//      across this repo's ~135 branches, which `npm test` can afford.
//
// WHAT THIS DOES NOT CHECK, and why:
//
//   A version that sorts BEFORE the newest migration already applied to the
//   linked project -- the other half of the same failure. `db push` already
//   refuses that loudly on its own, with LegacyDbPushMissingRemoteError.
//   Checking it here would need either a network round-trip to the linked
//   Supabase project, or a local Postgres that a concurrent session resets
//   continuously (see docs/superpowers/ACCOUNTING-ROADMAP.md's "Baselines
//   move under you") -- neither belongs in a test that must run offline, on
//   every `npm test`, and never go red for a reason unrelated to the code
//   under test. This file exists for the half of the failure that is
//   SILENT; that half already announces itself.
//
// WHEN THIS FAILS: the message names both files and the version they share.
// Renumber YOURS to a version nobody else has used. Do not delete either
// file, and do not delete the entry that caught you.

import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const WORKTREES_DIR = join(ROOT, '.claude', 'worktrees');

const VERSION_PATTERN = /^(\d+)_/;

interface Sighting {
  file: string;
  location: string;
}

function versionOf(file: string): string | null {
  const match = VERSION_PATTERN.exec(file);
  return match ? match[1] : null;
}

function sqlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.sql'));
}

// This tree's own migrations, uncommitted edits included -- it is a plain
// filesystem read, so there is nothing to degrade.
function collectLocal(): Sighting[] {
  return sqlFilesIn(MIGRATIONS_DIR).map((file) => ({ file, location: 'supabase/migrations' }));
}

// Every OTHER worktree checked out alongside this one. Purely filesystem
// reads: a worktree that exists on disk needs no git call to inspect.
function collectOtherWorktrees(): Sighting[] {
  if (!existsSync(WORKTREES_DIR)) return [];
  const sightings: Sighting[] = [];
  for (const name of readdirSync(WORKTREES_DIR)) {
    const dir = join(WORKTREES_DIR, name, 'supabase', 'migrations');
    for (const file of sqlFilesIn(dir)) {
      sightings.push({ file, location: `.claude/worktrees/${name}/supabase/migrations` });
    }
  }
  return sightings;
}

// Every branch, local or remote, that this repo's git already knows about.
// `for-each-ref` and `ls-tree` are both local-refs-only: no fetch, no
// network, and nothing here throws just because a remote is unreachable --
// a failed git call degrades to "no branches to compare against" rather
// than failing this test for a reason that has nothing to do with the
// migrations themselves.
function collectBranches(): Sighting[] {
  let refs: string[];
  try {
    refs = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((ref) => !ref.endsWith('HEAD'));
  } catch {
    // No git, not a repo, or some other local failure -- nothing to add.
    return [];
  }

  const sightings: Sighting[] = [];
  for (const ref of refs) {
    let files: string[];
    try {
      files = execFileSync('git', ['ls-tree', '--name-only', ref, 'supabase/migrations/'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.sql'));
    } catch {
      // A branch predating supabase/migrations, or any other per-ref
      // failure: skip that one branch, not the whole check.
      continue;
    }
    for (const file of files) {
      sightings.push({ file, location: ref });
    }
  }
  return sightings;
}

it('no two migrations share a version, in this tree, any sibling worktree, or any branch', () => {
  const sightings = [...collectLocal(), ...collectOtherWorktrees(), ...collectBranches()];

  const byVersion = new Map<string, Map<string, Set<string>>>();
  for (const { file, location } of sightings) {
    const version = versionOf(file);
    if (!version) continue;
    let byFile = byVersion.get(version);
    if (!byFile) {
      byFile = new Map();
      byVersion.set(version, byFile);
    }
    let locations = byFile.get(file);
    if (!locations) {
      locations = new Set();
      byFile.set(file, locations);
    }
    locations.add(location);
  }

  const collisions: string[] = [];
  for (const [version, byFile] of byVersion) {
    if (byFile.size < 2) continue; // one file, seen in however many places -- not a collision.
    const parts = [...byFile.entries()].map(
      ([file, locations]) => `  - ${file}  (seen in: ${[...locations].join(', ')})`
    );
    collisions.push(
      `Version ${version} is shared by ${byFile.size} different files:\n${parts.join('\n')}\n` +
        `Whichever applies first to the linked project wins; the other never runs, silently. ` +
        `Renumber YOURS to a version nobody else has used -- do not delete either file.`
    );
  }

  if (collisions.length > 0) {
    throw new Error(collisions.join('\n\n'));
  }
});
