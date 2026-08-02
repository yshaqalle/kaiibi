import { openExternalUrl } from '@/lib/external-url';

export function openWhatsApp(phone: string, text?: string): void {
  const digits = phone.replace(/\D/g, '');
  const query = text ? `?text=${encodeURIComponent(text)}` : '';
  openExternalUrl(`https://wa.me/${digits}${query}`);
}
