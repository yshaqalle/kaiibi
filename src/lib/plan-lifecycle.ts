import type { Plan } from '@/lib/subscriptions';

// Client-side mirrors of the plan-lifecycle guards in
// supabase/functions/platform-admin/index.ts (publish_plan / archive_plan).
// The portal never offers a button the server would reject, and these
// predicates are that rule made checkable: if a guard changes there, it
// changes here.

// The server validates the same shape on create; the editor uses this to gate
// the save button rather than round-tripping for a 400.
export function isValidPlanKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

export function canPublishPlan(plan: Pick<Plan, 'key' | 'isPublic' | 'retireAt' | 'active'>): boolean {
  return (
    plan.active &&
    !plan.isPublic &&
    // Republish is the verb for a retiring plan -- it clears the retirement.
    plan.retireAt == null &&
    // $0, every module, no limits; publishing it makes the product free.
    plan.key !== 'trial'
  );
}

export function canArchivePlan(
  plan: Pick<Plan, 'key' | 'isPublic' | 'active'>,
  ctx: {
    // Stored subscriptions, matching archive_plan's count over rows -- not the
    // effective plan, which reads zero for exactly the retired plans whose
    // stores have not moved yet.
    storedShopsOn: number;
    postTrialPlanKey: string;
    plans: Pick<Plan, 'successorPlanKey'>[];
  }
): boolean {
  return (
    plan.active &&
    !plan.isPublic &&
    // The signup trigger selects trial by key at every shop creation.
    plan.key !== 'trial' &&
    // Lapsed stores resolve through the fallback on every entitlement read.
    plan.key !== ctx.postTrialPlanKey &&
    ctx.storedShopsOn === 0 &&
    // An in-flight retirement must not sweep stores onto an archived plan.
    !ctx.plans.some((p) => p.successorPlanKey === plan.key)
  );
}
