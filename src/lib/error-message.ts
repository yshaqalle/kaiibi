/**
 * The message out of a thrown thing, whatever shape it arrived in.
 *
 * `error instanceof Error ? error.message : fallback` IS WRONG against
 * Supabase, and wrong in the quiet way: PostgrestError -- what `rpc()` and
 * every query reject with -- is a plain `{ code, details, hint, message }`
 * object and is NEVER `instanceof Error`. So that expression takes the
 * fallback EVERY time, and a screen written to print the database's own
 * sentence prints a generic one instead, with no error anywhere to notice.
 * It shipped exactly that way on Close a Period, where the refusal whose
 * entire purpose is to name every outstanding item rendered "The database
 * refused the close."
 *
 * This lives on its own, with the fallback as a PARAMETER, because the shape
 * check is not domain knowledge and the sentence is: checkout-errors.ts wants
 * "Could not complete this sale.", the period screen wants something about
 * closing, and a third copy of the `typeof message === 'string'` test is how
 * one of them silently stops handling PostgrestError again.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}
