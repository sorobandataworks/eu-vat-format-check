/**
 * eu-vat-format-check
 *
 * Format and check-digit (checksum) validation for EU VAT identification
 * numbers in 11 countries: DE, FR, IT, ES, NL, BE, AT, PL, IE, SE, DK.
 *
 * IMPORTANT — SCOPE
 *   This library checks ONLY the format of a VAT number and, where a
 *   public check-digit algorithm exists, its check digit. It does NOT
 *   check whether a number is registered, it never contacts VIES or any
 *   other registry, and a passing result must never be read as
 *   confirmation that the number is registered. Every result therefore
 *   `registration_status: "not_checked"` and
 *   `check_scope: "format_and_checksum_only"`, and there is deliberately
 *   no standalone `valid` field.
 *
 * The validation core below is a verbatim port of the logic running in
 * the hosted checker (Cloudflare Worker "vat-format-checker", source of
 * truth: mock/worker-live.js in the project repository), so the library
 * and the hosted API cannot drift apart silently — the test suite
 * compares both implementations on every case.
 *
 * Number formats follow the European Commission's published list of VAT
 * identification number formats. Each check-digit algorithm is
 * implemented from the public specification noted in the comment of the
 * respective country block. No third-party code is copied.
 *
 * License: MIT. Copyright (c) 2026 Soroban Data Works.
 */

// ---------------------------------------------------------------------------
// Validation core (verbatim port of the hosted Worker's logic)
// ---------------------------------------------------------------------------

/** Sum of the decimal digits of a non-negative integer (e.g. 16 -> 7). */
function digitSum(n) {
  let s = 0;
  let x = n;
  while (x > 0) {
    s += x % 10;
    x = Math.floor(x / 10);
  }
  return s;
}

/**
 * Luhn check over a string of digits, in the convention used by the
 * Swedish organisation number: digits at odd 1-based positions are
 * doubled (subtracting 9 when the doubling exceeds 9).
 */
function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(i) - 48;
    if (i % 2 === 0) { // odd 1-based positions
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * ISO 7064 MOD 97-10 over an alphanumeric string (letters map A=10..Z=35).
 * Returns true when the remainder is 1, which is the "consistent" state
 * for identifiers protected by this scheme.
 */
function iso7064Mod9710(str) {
  let remainder = 0;
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else {
      const v = code - 55; // A=10 ... Z=35, always two decimal digits
      remainder = (remainder * 10 + Math.floor(v / 10)) % 97;
      remainder = (remainder * 10 + (v % 10)) % 97;
    }
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Country definitions.
// Each entry:
//   format(v)   -> boolean. `v` is the number body WITHOUT the 2-letter
//                  country prefix (AT keeps its leading "U").
//   checksum(v) -> true / false, or null when no public check-digit
//                  algorithm can be applied to this number.
// ---------------------------------------------------------------------------

const COUNTRIES = {
  // -------------------------------------------------------------------------
  // Germany — 9 digits.
  // Check digit: ISO 7064 MOD 11-10 over the first 8 digits; the 9th digit
  // is the check digit. Specification: Bundeszentralamt für Steuern (BZSt),
  // construction rules for the USt-IdNr.; algorithm is the ISO 7064
  // MOD 11-10 procedure also described in public VAT-format references.
  // -------------------------------------------------------------------------
  DE: {
    format: (v) => /^\d{9}$/.test(v),
    checksum: (v) => {
      let p = 10;
      for (let i = 0; i < 8; i++) {
        let s = (Number(v[i]) + p) % 10;
        if (s === 0) s = 10;
        p = (2 * s) % 11;
      }
      let check = 11 - p;
      if (check === 10) check = 0;
      return check === Number(v[8]);
    },
  },

  // -------------------------------------------------------------------------
  // France — 2-character key + 9-digit SIREN.
  // For numeric keys, the key is defined by the French tax administration
  // (DGFiP) as: key = (12 + 3 * (SIREN mod 97)) mod 97, zero-padded to 2.
  // Keys containing letters also exist; no public arithmetic rule verifies
  // them, so checksum returns null for those.
  // The two key characters exclude I and O (visual ambiguity), per the
  // published format description.
  // -------------------------------------------------------------------------
  FR: {
    format: (v) => /^[0-9A-HJ-NP-Z]{2}\d{9}$/.test(v),
    checksum: (v) => {
      const key = v.slice(0, 2);
      if (!/^\d{2}$/.test(key)) return null; // letter key: not verifiable
      const siren = v.slice(2);
      const expected = (12 + 3 * (Number(siren) % 97)) % 97;
      return Number(key) === expected;
    },
  },

  // -------------------------------------------------------------------------
  // Italy — 11 digits (partita IVA).
  // Check digit (11th): over the first 10 digits, digits in odd 1-based
  // positions are added as-is; digits in even positions are doubled
  // (subtracting 9 when the doubling exceeds 9). The check digit makes
  // the total a multiple of 10. Specification: Agenzia delle Entrate,
  // partita IVA check-digit rules (a Luhn-family scheme).
  // -------------------------------------------------------------------------
  IT: {
    format: (v) => /^\d{11}$/.test(v),
    checksum: (v) => {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        const n = Number(v[i]);
        if (i % 2 === 0) {
          sum += n; // odd 1-based positions
        } else {
          const t = n * 2;
          sum += t > 9 ? t - 9 : t; // even 1-based positions
        }
      }
      return (10 - (sum % 10)) % 10 === Number(v[10]);
    },
  },

  // -------------------------------------------------------------------------
  // Spain — 9 characters, several shapes:
  //   - starts with a digit, or with X/Y/Z (foreigners' NIE): the control
  //     is a letter from "TRWAGMYFPDXBNJZSQVHLCKE" at (number mod 23),
  //     where X/Y/Z are first replaced by 0/1/2 (AEAT NIF rules).
  //   - starts with another letter (companies): 7 digits plus a control
  //     that is either a digit or a letter. Over the 7 digits, digits in
  //     odd 1-based positions are doubled and digit-summed, even positions
  //     are added as-is; control digit = (10 - (total mod 10)) mod 10, and
  //     the letter form maps 0->J, 1->A, 2->B, ..., 9->I (AEAT rules).
  //   - starts with K, L or M (special personal IDs): the public sources
  //     consulted do not give a single unambiguous rule, so null.
  // The set of permitted initial letters follows the AEAT specification
  // (I, O and T never start a Spanish VAT number).
  // -------------------------------------------------------------------------
  ES: {
    format: (v) =>
      /^[ABCDEFGHJKLMNPQRSUVWXYZ]\d{7}[0-9A-Z]$/.test(v) ||
      /^\d{8}[A-Z]$/.test(v),
    checksum: (v) => {
      const first = v[0];
      const last = v[8];
      if (/^\d$/.test(first) || first === "X" || first === "Y" || first === "Z") {
        if (!/^[A-Z]$/.test(last)) return false;
        let base;
        if (first === "X") base = "0" + v.slice(1, 8);
        else if (first === "Y") base = "1" + v.slice(1, 8);
        else if (first === "Z") base = "2" + v.slice(1, 8);
        else base = v.slice(0, 8);
        return "TRWAGMYFPDXBNJZSQVHLCKE"[Number(base) % 23] === last;
      }
      if (first === "K" || first === "L" || first === "M") return null;
      // Company form.
      let sum = 0;
      for (let i = 0; i < 7; i++) {
        const n = Number(v[i + 1]);
        if (i % 2 === 0) sum += digitSum(n * 2); // odd 1-based positions
        else sum += n; // even 1-based positions
      }
      const control = (10 - (sum % 10)) % 10;
      if (/^\d$/.test(last)) return control === Number(last);
      return "JABCDEFGHI"[control] === last; // 0->J, 1->A, ..., 9->I
    },
  },

  // -------------------------------------------------------------------------
  // Netherlands — 9 digits + "B" + 2 digits (btw-id).
  // Two number generations coexist (Belastingdienst):
  //   - numbers based on an RSIN/BSN satisfy the "elfproef": the 9 digits
  //     weighted 9,8,7,6,5,4,3,2,-1 sum to a multiple of 11;
  //   - btw-ids issued to sole traders from 1 Jan 2020 are decoupled from
  //     the BSN and instead satisfy ISO 7064 MOD 97-10 over the full
  //     "NL" + number string.
  // A number is checksum-consistent when EITHER scheme holds (this is the
  // acceptance rule the Belastingdienst scheme requires; gating on the
  // elfproef alone would wrongly reject post-2020 sole-trader numbers).
  // Format additionally requires a non-zero digit block and a suffix other
  // than "00", per the published structure.
  // -------------------------------------------------------------------------
  NL: {
    format: (v) =>
      /^\d{9}B\d{2}$/.test(v) &&
      v.slice(0, 9) !== "000000000" &&
      v.slice(10, 12) !== "00",
    checksum: (v) => {
      const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
      let sum = 0;
      for (let i = 0; i < 9; i++) sum += weights[i] * Number(v[i]);
      if (sum % 11 === 0) return true; // elfproef
      return iso7064Mod9710("NL" + v); // post-2020 scheme
    },
  },

  // -------------------------------------------------------------------------
  // Belgium — 10 digits, first digit 0 or 1.
  // Check digits (last two): 97 - (first 8 digits mod 97).
  // Specification: Belgian FPS Finance enterprise number rules, as
  // reproduced in the European Commission / Wikipedia format references.
  // -------------------------------------------------------------------------
  BE: {
    format: (v) => /^[01]\d{9}$/.test(v),
    checksum: (v) => 97 - (Number(v.slice(0, 8)) % 97) === Number(v.slice(8, 10)),
  },

  // -------------------------------------------------------------------------
  // Austria — "U" + 8 digits (UID).
  // Check digit (8th digit): modified Luhn (mod 10) over the first 7
  // digits with a fixed +4 constant: digits in odd 1-based positions are
  // added as-is, digits in even positions are doubled and digit-summed,
  // then 4 is added; the check digit makes the total a multiple of 10.
  // Specification: Austrian Federal Ministry of Finance (BMF),
  // "Konstruktionsregeln der Umsatzsteuer-Identifikationsnummern".
  // -------------------------------------------------------------------------
  AT: {
    format: (v) => /^U\d{8}$/.test(v),
    checksum: (v) => {
      const d = v.slice(1); // 8 digits
      let sum = 0;
      for (let i = 0; i < 7; i++) {
        const n = Number(d[i]);
        if (i % 2 === 0) sum += n; // odd 1-based positions
        else sum += digitSum(n * 2); // even 1-based positions
      }
      sum += 4;
      return (10 - (sum % 10)) % 10 === Number(d[7]);
    },
  },

  // -------------------------------------------------------------------------
  // Poland — 10 digits (VAT number = NIP).
  // Check digit (10th): the first 9 digits weighted 6,5,7,2,3,4,5,6,7;
  // the weighted sum mod 11 must equal the check digit (a remainder of
  // 10 means the number cannot be consistent). Specification: Polish
  // Ministry of Finance NIP check-digit rules.
  // -------------------------------------------------------------------------
  PL: {
    format: (v) => /^\d{10}$/.test(v),
    checksum: (v) => {
      const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
      let sum = 0;
      for (let i = 0; i < 9; i++) sum += weights[i] * Number(v[i]);
      const rest = sum % 11;
      if (rest === 10) return false;
      return rest === Number(v[9]);
    },
  },

  // -------------------------------------------------------------------------
  // Ireland — 7 digits + check letter, plus an optional second letter on
  // numbers issued since 2013; a legacy shape with a letter in the second
  // position also exists.
  // Check letter: modulus 23. The 7 digits are weighted 8,7,6,5,4,3,2;
  // when a second letter is present, 9 times its value is added, where
  // letters map through the alphabet "WABCDEFGHIJKLMNOPQRSTUV"
  // (W=0, A=1, ..., V=22). The total mod 23 selects the check letter from
  // the same alphabet. Specification: Irish Revenue rules as documented
  // in Algorithm::CheckDigits (M23_002) and Revenue's worked examples.
  // For the legacy shape the digit arrangement feeding the scheme is not
  // covered by the sources consulted, so checksum returns null there.
  // -------------------------------------------------------------------------
  IE: {
    format: (v) =>
      /^\d{7}[A-W]([A-IW])?$/.test(v) || /^\d[A-Z]\d{5}[A-W]$/.test(v),
    checksum: (v) => {
      if (/^\d[A-Z]\d{5}[A-W]$/.test(v)) return null; // legacy shape
      const alphabet = "WABCDEFGHIJKLMNOPQRSTUV";
      const weights = [8, 7, 6, 5, 4, 3, 2];
      let sum = 0;
      for (let i = 0; i < 7; i++) sum += weights[i] * Number(v[i]);
      if (v.length === 9) sum += 9 * alphabet.indexOf(v[8]);
      return alphabet[sum % 23] === v[7];
    },
  },

  // -------------------------------------------------------------------------
  // Sweden — 12 digits: the 10-digit organisation number followed by "01".
  // Check digit: the organisation number's 10th digit is a Luhn check
  // digit (digits in odd 1-based positions doubled). Specification:
  // Skatteverket, organisation number / VAT number ("SE" + orgnr + "01").
  // -------------------------------------------------------------------------
  SE: {
    format: (v) => /^\d{10}01$/.test(v),
    checksum: (v) => luhnValid(v.slice(0, 10)),
  },

  // -------------------------------------------------------------------------
  // Denmark — 8 digits (CVR), first digit non-zero.
  // Check digit: a modulus-11 scheme existed historically, but it is no
  // longer guaranteed for issued CVR numbers (compare the Danish CPR
  // register, which formally abandoned modulus 11 in 2007 because valid
  // numbers were being rejected). Enforcing it here would brand real
  // numbers as inconsistent, so checksum returns null by design; only
  // the format is checked. This limitation is deliberate and documented.
  // -------------------------------------------------------------------------
  DK: {
    format: (v) => /^[1-9]\d{7}$/.test(v),
    checksum: () => null,
  },
};

const SUPPORTED = Object.keys(COUNTRIES);

/**
 * Remove spaces/dots/hyphens, uppercase, and strip the country prefix
 * when the remainder then looks like a number body for that country.
 */
function normalize(country, rawVat) {
  const cleaned = String(rawVat).replace(/[\s.\-]/g, "").toUpperCase();
  if (cleaned.startsWith(country)) {
    const rest = cleaned.slice(country.length);
    if (COUNTRIES[country].format(rest)) return rest;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Error thrown for invalid calls. Mirrors the hosted API's error shape:
 * `code` is "invalid_request" or "unsupported_country"; the
 * unsupported-country error also carries a `supported` array.
 */
export class VatCheckError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail);
    this.name = "VatCheckError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Country codes supported by this library (ISO 3166-1 alpha-2). */
export const SUPPORTED_COUNTRIES = Object.freeze([...SUPPORTED]);

/**
 * Check the format and check digit of an EU VAT number.
 *
 * This is a FORMAT AND CHECKSUM check only. It does not check whether
 * the number is registered (no VIES or registry lookup is performed),
 * and a passing result does not mean the registration is valid.
 *
 * @param {string} country  Two-letter country code (case-insensitive):
 *                          DE, FR, IT, ES, NL, BE, AT, PL, IE, SE, DK.
 * @param {string} vat      The VAT number. Spaces, dots and hyphens are
 *                          ignored; a leading country prefix (e.g.
 *                          "DE 136 695 976") is accepted.
 * @returns {{country: string, normalized: string,
 *            format_valid: boolean, checksum_valid: (boolean|null),
 *            registration_status: "not_checked",
 *            check_scope: "format_and_checksum_only"}}
 *   `checksum_valid` is null when the format is wrong, or when no
 *   public check-digit algorithm applies to the number (e.g. all
 *   Danish numbers, French letter keys, Spanish K/L/M numbers,
 *   legacy-shape Irish numbers).
 * @throws {VatCheckError} code "invalid_request" when country/vat are
 *   missing or not strings; code "unsupported_country" (with a
 *   `supported` array) for countries outside the supported set.
 */
export function validateVat(country, vat) {
  const cc = typeof country === "string" ? country.toUpperCase() : "";
  if (!cc || typeof vat !== "string" || vat === "") {
    throw new VatCheckError(
      "invalid_request",
      'Both "country" and "vat" (strings) are required.'
    );
  }
  const def = COUNTRIES[cc];
  if (!def) {
    throw new VatCheckError(
      "unsupported_country",
      `Unsupported country: ${cc}`,
      { supported: [...SUPPORTED] }
    );
  }
  const normalized = normalize(cc, vat);
  const format_valid = def.format(normalized);
  const checksum_valid = format_valid ? def.checksum(normalized) : null;
  return {
    country: cc,
    normalized,
    format_valid,
    checksum_valid,
    registration_status: "not_checked",
    check_scope: "format_and_checksum_only",
  };
}

export default validateVat;
