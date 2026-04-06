/**
 * Czech bank account → IBAN conversion.
 *
 * Input: "123456789/0800" or prefix-number "19-123456789/0800"
 * Output: "CZ6508000000190123456789"
 *
 * CZ IBAN structure:
 *   CZ + 2 check digits + 4-digit bank code + 6-digit prefix (zero-padded) + 10-digit account (zero-padded)
 *   Total: 24 characters
 */

export function czechAccountToIban(accountNumber: string, bankCode: string): string | null {
  // Clean inputs
  const cleanBank = bankCode.replace(/\s/g, "").replace(/^0+/, "") || "0";
  let prefix = "0";
  let number = accountNumber.replace(/\s/g, "");

  // Handle "prefix-number" format
  if (number.includes("-")) {
    const parts = number.split("-");
    if (parts.length !== 2) return null;
    prefix = parts[0] || "0";
    number = parts[1];
  }

  // Validate: bank code 1-4 digits, prefix 0-6 digits, number 1-10 digits
  if (!/^\d{1,4}$/.test(cleanBank)) return null;
  if (!/^\d{0,6}$/.test(prefix)) return null;
  if (!/^\d{1,10}$/.test(number)) return null;

  // Pad to fixed lengths
  const paddedBank = cleanBank.padStart(4, "0");
  const paddedPrefix = prefix.padStart(6, "0");
  const paddedNumber = number.padStart(10, "0");

  // BBAN = bank code + prefix + account number
  const bban = paddedBank + paddedPrefix + paddedNumber;

  // Calculate check digits (ISO 7064 MOD 97-10)
  // Move "CZ00" to end, replace letters: C=12, Z=35
  const numericString = bban + "123500"; // CZ = 12 35, 00 = placeholder
  const checkDigits = 98 - mod97(numericString);
  const checkStr = checkDigits.toString().padStart(2, "0");

  return `CZ${checkStr}${bban}`;
}

/**
 * Validate a Czech IBAN (CZxx + 20 digits = 24 chars).
 */
export function isValidCzechIban(iban: string): boolean {
  const clean = iban.replace(/\s/g, "").toUpperCase();
  if (!/^CZ\d{22}$/.test(clean)) return false;

  // MOD 97 check: move first 4 chars to end, replace letters
  const rearranged = clean.substring(4) + clean.substring(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => (ch.charCodeAt(0) - 55).toString());
  return mod97(numeric) === 1;
}

/**
 * Format IBAN with spaces: CZ65 0800 0000 1901 2345 6789
 */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Parse "123456-789012345/0800" into parts.
 */
export function parseCzechAccount(input: string): { accountNumber: string; bankCode: string } | null {
  const clean = input.replace(/\s/g, "");
  const match = clean.match(/^(\d{0,6}-?\d{1,10})\/(\d{1,4})$/);
  if (!match) return null;
  return { accountNumber: match[1], bankCode: match[2] };
}

/** MOD 97 for long numeric strings (chunk-based, no BigInt) */
function mod97(numStr: string): number {
  let remainder = 0;
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + Number(numStr[i])) % 97;
  }
  return remainder;
}
