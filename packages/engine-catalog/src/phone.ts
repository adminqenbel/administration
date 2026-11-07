// Phone and email normalisation and masking. Pure functions.

export interface NormalisePhoneOptions {
  /** Country calling code assumed for numbers written without one. Default "91" (India). */
  defaultCallingCode?: string;
}

/**
 * Normalise a phone number to E.164 ("+919876543210"), or return null if it cannot be done safely.
 *
 * Accepted: an explicit "+" or "00" prefix with any country; and, for the default country India, a bare
 * 10-digit mobile number (starts 6-9), the same with a leading 0, or with 91 in front.
 * Separators (spaces, dashes, dots, round brackets) are dropped. Anything else is refused rather than guessed:
 * extensions, letters, bare digit strings of unusual length, numbers that would not be valid E.164.
 * For +91 the national part must be 10 digits and not start with 0.
 */
export function normalisePhone(raw: unknown, options: NormalisePhoneOptions = {}): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  const compact = trimmed.replace(/[\s\-().]/g, "");
  if (!/^\+?[0-9]+$/.test(compact)) return null;

  const code = options.defaultCallingCode ?? "91";
  if (!/^[1-9][0-9]{0,2}$/.test(code)) return null;

  let intl: string;
  if (compact.startsWith("+")) {
    intl = compact.slice(1);
  } else if (compact.startsWith("00")) {
    intl = compact.slice(2);
  } else if (code === "91") {
    if (/^[6-9][0-9]{9}$/.test(compact)) intl = `91${compact}`;
    else if (/^0[6-9][0-9]{9}$/.test(compact)) intl = `91${compact.slice(1)}`;
    else if (/^91[6-9][0-9]{9}$/.test(compact)) intl = compact;
    else return null;
  } else {
    const national = compact.replace(/^0/, "");
    if (national.length < 6 || national.length > 14 || national.startsWith(code)) return null;
    intl = `${code}${national}`;
  }

  if (!/^[1-9][0-9]{6,14}$/.test(intl)) return null;
  if (intl.startsWith("91") && !/^91[1-9][0-9]{9}$/.test(intl)) return null;
  return `+${intl}`;
}

/** Lower-cased, trimmed email, or null if it is not plausibly an address. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > 254) return null;
  if (!/^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(v)) return null;
  const local = v.slice(0, v.indexOf("@"));
  if (local.length > 64) return null;
  return v;
}

/** "+919876543210" -> "******3210". Used for anything an AI tool may see. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  return `******${digits.slice(-4)}`;
}

/** "jane.doe@example.com" -> "j***@example.com". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
