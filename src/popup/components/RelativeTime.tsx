import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

export function relativeTime(value: string, locale: string, now = Date.now()): string {
  const seconds = (new Date(value).getTime() - now) / 1000;
  if (!Number.isFinite(seconds)) return '—';
  const magnitude = Math.abs(seconds);
  const [unit, divisor] = magnitude < 60 ? ['second', 1] as const
    : magnitude < 3600 ? ['minute', 60] as const
    : magnitude < 86400 ? ['hour', 3600] as const
    : ['day', 86400] as const;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.trunc(seconds / divisor), unit);
}
export function RelativeTime({ value }: { value: string }): React.JSX.Element {
  const { locale } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const date = new Date(value);
  return <time dateTime={value} title={Number.isFinite(date.getTime()) ? date.toLocaleString(locale, { dateStyle: 'long', timeStyle: 'medium' }) : undefined}>{relativeTime(value, locale, now)}</time>;
}
