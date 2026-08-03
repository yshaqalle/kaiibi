export const TIME_OFF_REASONS = [
  'Vacation',
  'PTO (Paid Time Off)',
  'Sick leave',
  'Personal day',
  'Bereavement',
  'Parental leave',
  'Medical appointment',
  'Emergency',
  'Other',
] as const;

export type TimeOffReason = typeof TIME_OFF_REASONS[number];
