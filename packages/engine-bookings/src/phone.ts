// Minimal phone normalisation to E.164, enough to match and store a customer made during confirm_booking.
// The catalogue engine owns CRM and has the full version; this one is deliberately the same rules, smaller:
// "+" or "00" prefix with any country, or a bare Indian mobile number (10 digits starting 6-9, optional leading 0 or 91).
export function normalisePhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?[0-9]+$/.test(compact)) return null;
  let intl: string;
  if (compact.startsWith("+")) intl = compact.slice(1);
  else if (compact.startsWith("00")) intl = compact.slice(2);
  else if (/^[6-9][0-9]{9}$/.test(compact)) intl = `91${compact}`;
  else if (/^0[6-9][0-9]{9}$/.test(compact)) intl = `91${compact.slice(1)}`;
  else if (/^91[6-9][0-9]{9}$/.test(compact)) intl = compact;
  else return null;
  if (!/^[1-9][0-9]{6,14}$/.test(intl)) return null;
  if (intl.startsWith("91") && !/^91[1-9][0-9]{9}$/.test(intl)) return null;
  return `+${intl}`;
}
