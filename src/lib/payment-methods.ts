import type { PaymentMethod } from '@/types/models';

export const paymentMethods: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: 'cash', label: 'Cash', icon: '💵' },
  { key: 'zaad', label: 'ZAAD', icon: '📱' },
  { key: 'edahab', label: 'e-Dahab', icon: '📱' },
  { key: 'other', label: 'Other', icon: '•' },
];

export const methodLabel = (method: PaymentMethod) => paymentMethods.find((m) => m.key === method)?.label ?? method;
