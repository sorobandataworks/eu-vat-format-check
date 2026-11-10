# eu-vat-format-check

Format and check-digit (checksum) validation for EU VAT identification
numbers in 11 countries — a zero-dependency ES module for Node.js and
browsers.

## What this is — and what it is not

**This library checks format and check digits only. It is NOT a
registration check.**

- It verifies that a VAT number is *well-formed* for its country and,
  where a public check-digit algorithm exists, that the check digit is
  *consistent*.
- It does **not** check whether the number is registered to any
  business. It never contacts VIES or any other registry, and it makes
  no network calls at all.
- A passing result means only "well-formed, check digit consistent" —
  never "this number is registered". Every result says so explicitly:
  `registration_status: "not_checked"`,
  `check_scope: "format_and_checksum_only"`. There is deliberately no
  standalone `valid` field, so the two questions cannot be confused.

Use it as a pre-check: catch typos and malformed numbers at form input
or import time, before the (separate) registration check against VIES.

## Install

```sh
npm install eu-vat-format-check
```

(If the npm package is not live yet, copy the single `index.js` file
into your project, or depend on this repository directly.)

Or load the single file directly in a browser:

```html
<script type="module">
  import { validateVat } from "./index.js";
</script>
```

## Usage

```js
import { validateVat } from "eu-vat-format-check";

validateVat("DE", "136695976");
// {
//   country: "DE",
//   normalized: "136695976",
//   format_valid: true,
//   checksum_valid: true,
//   registration_status: "not_checked",
//   check_scope: "format_and_checksum_only"
// }

validateVat("DK", "32357809");
// checksum_valid: null — Denmark has no applicable public check digit,
// so only the format is checked. null means "not applicable",
// never "failed".

validateVat("de", "DE 136.695.976"); // country prefix, spaces,
                                     // dots and lowercase are
                                     // normalised away
```

## API

### `validateVat(country, vat)`

- `country`: two-letter country code, case-insensitive. One of
  DE, FR, IT, ES, NL, BE, AT, PL, IE, SE, DK
  (also exported as `SUPPORTED_COUNTRIES`).
- `vat`: the VAT number as a string.

Returns an object:

| Field | Meaning |
| --- | --- |
| `country` | The uppercased country code. |
| `normalized` | The number after removing spaces/dots/hyphens, uppercasing, and stripping a country prefix when the remainder is a well-formed body. |
| `format_valid` | Whether the number matches the country's published format. |
| `checksum_valid` | `true`/`false` when a public check-digit algorithm applies; `null` when the format is wrong **or** no algorithm applies (see below). |
| `registration_status` | Always `"not_checked"` — registration is never checked. |
| `check_scope` | Always `"format_and_checksum_only"`. |

Throws a `VatCheckError` (exported) with a `code` property:

| `code` | When |
| --- | --- |
| `"invalid_request"` | `country` or `vat` is missing or not a string. |
| `"unsupported_country"` | Country outside the supported set. The error also carries a `supported` array. |

### When `checksum_valid` is `null`

- **DK** — all numbers. A modulus-11 scheme existed historically but is
  no longer guaranteed for issued CVR numbers, so enforcing it would
  wrongly reject real numbers. Format only, by design.
- **FR** — numbers whose 2-character key contains a letter (no public
  arithmetic rule verifies those keys).
- **ES** — numbers starting with K, L or M (no single unambiguous
  public rule in the sources consulted).
- **IE** — legacy-shape numbers (a letter in the second position).

## Supported countries

Formats follow the European Commission's published list of VAT
identification number formats; each check-digit algorithm is
implemented from the public specification of the respective tax
administration (BZSt, DGFiP, Agenzia delle Entrate, AEAT,
Belastingdienst, FPS Finance, BMF, Polish Ministry of Finance, Irish
Revenue, Skatteverket). The validation logic is identical to the one
running in the hosted checker below and is tested against it.

| Country | Format | Check digit |
| --- | --- | --- |
| DE | 9 digits | ISO 7064 MOD 11-10 |
| FR | 2-char key + 9-digit SIREN | numeric keys only; letter keys → `null` |
| IT | 11 digits | Luhn-family |
| ES | 9 characters (several shapes) | mod-23 letter / control digit or letter; K/L/M → `null` |
| NL | 9 digits + `B` + 2 digits | elfproef **or** ISO 7064 MOD 97-10 |
| BE | 10 digits, first digit 0 or 1 | 97 − (first 8 mod 97) |
| AT | `U` + 8 digits | modified Luhn with +4 constant |
| PL | 10 digits | weighted mod 11 |
| IE | 7 digits + check letter (+ optional 2nd letter) | modulus 23; legacy shape → `null` |
| SE | 10-digit org number + `01` | Luhn |
| DK | 8 digits, first non-zero | none (format only) |

## Hosted version

The same checker runs as a free hosted API (free beta, format &
checksum only):

- RapidAPI listing: https://rapidapi.com/sorobandataworks/api/eu-vat-number-format-checksum-checker
- Background — why "invalid" and "couldn't verify" must not be merged
  when VIES is down: https://vat-format-checker.phoenixrefurbtools.workers.dev/guide

A full verification API (one that reports "couldn't verify" instead of
"invalid" when a registry is unreachable) has **not** been built. If
that is what you need, registering interest is the signal being
counted: https://vat-format-checker.phoenixrefurbtools.workers.dev/interest

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Soroban Data Works.
