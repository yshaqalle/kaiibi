import { groupedPermissions } from '@/lib/permission-groups';
import { ALL_PERMISSIONS } from '@/lib/permissions';

// permissions.test.ts's "files every permission in exactly one group" checks
// PERMISSION_GROUPS, the input list groupedPermissions() is built from. It
// says nothing about what the editor actually draws: a grandchild permission
// (one whose `parent` names a CHILD, not a top-level key) is invisible to
// `childrenOf`'s one-level walk -- filed correctly in PERMISSION_GROUPS, but
// rendered nowhere -- and a permission left un-parented while still listed
// under its old parent's `childrenOf` renders twice, as two switches that can
// disagree about the same stored string. Both holes pass every other test in
// this codebase; only drawing the actual output catches them.
describe('groupedPermissions', () => {
  it('draws every permission exactly once', () => {
    const drawn = groupedPermissions().flatMap((g) => g.rows.flatMap((r) => [r.permission.key, ...r.children.map((c) => c.key)]));
    expect([...drawn].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});
