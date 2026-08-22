import { StatementRow } from '@/components/ui/statement-row';
import type { StatementSection } from '@/lib/financial-statements';

// One section of a financial statement, as ruled lines with a subtotal.
//
// Shared by all three statements because the shape is genuinely the same
// — a group of accounts and what they come to — and three copies of it is
// three places for the contra handling to be got wrong.
//
// An empty section renders nothing rather than a heading over a blank space.
// A shop with no long-term liabilities has no long-term liabilities section;
// printing "Long-term liabilities … 0.00" makes a reader look for the loan
// they do not have.
export function StatementSectionRows({
  section,
  /** Drops the subtotal when the section is the whole card and the card totals it. */
  showTotal = true,
}: {
  section: StatementSection;
  showTotal?: boolean;
}) {
  if (section.lines.length === 0) return null;

  return (
    <>
      {section.lines.map((line, index) => (
        <StatementRow
          key={line.key}
          label={line.code ? `${line.code}  ${line.label}` : line.label}
          amountCents={line.amountCents}
          // Indented and quieter, because a contra line is a deduction from
          // the line above it rather than an item in its own right.
          variant={line.contra ? 'sub' : 'item'}
          last={!showTotal && index === section.lines.length - 1}
        />
      ))}
      {showTotal && <StatementRow label={section.totalLabel} amountCents={section.totalCents} variant="emphasis" last />}
    </>
  );
}
