// The client-side mirrors of publish_plan's and archive_plan's server guards.
// The portal's rule is that a button the server would reject is never offered
// -- which only holds if these predicates and the edge-function guards agree.
// If a guard changes in supabase/functions/platform-admin/index.ts, it changes
// here, and vice versa.

import { canArchivePlan, canPublishPlan, isValidPlanKey } from '@/lib/plan-lifecycle';

describe('isValidPlanKey', () => {
  it.each(['starter', 'pro_2025', 'a'])('accepts %s', (key) => {
    expect(isValidPlanKey(key)).toBe(true);
  });

  it.each(['Standard', '9lives', 'has-dash', 'has space', '_leading', ''])('rejects %s', (key) => {
    expect(isValidPlanKey(key)).toBe(false);
  });
});

const hiddenDraft = { key: 'starter', isPublic: false, retireAt: null, active: true };

describe('canPublishPlan', () => {
  it('offers publish for a hidden, active, never-retiring plan', () => {
    expect(canPublishPlan(hiddenDraft)).toBe(true);
  });

  it('never offers publish for trial — the make-the-product-free tripwire', () => {
    expect(canPublishPlan({ ...hiddenDraft, key: 'trial' })).toBe(false);
  });

  it('does not offer publish for an already-public plan', () => {
    expect(canPublishPlan({ ...hiddenDraft, isPublic: true })).toBe(false);
  });

  it('does not offer publish for a retiring plan — republish is the verb there', () => {
    expect(canPublishPlan({ ...hiddenDraft, retireAt: '2999-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('does not offer publish for an archived plan', () => {
    expect(canPublishPlan({ ...hiddenDraft, active: false })).toBe(false);
  });
});

const drained = { key: 'free', isPublic: false, active: true };
const ctx = { storedShopsOn: 0, postTrialPlanKey: 'standard', plans: [{ successorPlanKey: null }] };

describe('canArchivePlan', () => {
  it('offers archive for a drained, hidden plan', () => {
    expect(canArchivePlan(drained, ctx)).toBe(true);
  });

  it('a retired plan is archivable once drained — retireAt is not consulted', () => {
    // Retirement state lives on the row and survives archiving; the predicate
    // deliberately ignores it, matching archive_plan.
    expect(canArchivePlan({ ...drained, key: 'legacy' }, ctx)).toBe(true);
  });

  it('does not offer archive while any subscription row points at it', () => {
    expect(canArchivePlan(drained, { ...ctx, storedShopsOn: 3 })).toBe(false);
  });

  it('does not offer archive for a public plan — retire first', () => {
    expect(canArchivePlan({ ...drained, isPublic: true }, ctx)).toBe(false);
  });

  it('never offers archive for trial — the signup trigger selects it by key', () => {
    expect(canArchivePlan({ ...drained, key: 'trial' }, ctx)).toBe(false);
  });

  it('does not offer archive for the post-trial fallback plan', () => {
    expect(canArchivePlan(drained, { ...ctx, postTrialPlanKey: 'free' })).toBe(false);
  });

  it('does not offer archive for a plan named as a retirement successor', () => {
    expect(canArchivePlan(drained, { ...ctx, plans: [{ successorPlanKey: 'free' }] })).toBe(false);
  });

  it('does not offer archive for an already-archived plan', () => {
    expect(canArchivePlan({ ...drained, active: false }, ctx)).toBe(false);
  });
});
