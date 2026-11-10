/**
 * Test suite for the eu-vat-format-check library (index.js).
 *
 * Two layers:
 *  1. The original case set from the hosted Worker's QA suite
 *     (mock/test-final.mjs): valid samples are constructed by recomputing
 *     check digits from the public specifications (implemented
 *     independently below), plus externally published anchor numbers.
 *  2. Port-parity: EVERY case is also run through the original hosted
 *     Worker (mock/worker-live.js, the source of truth) and the six
 *     result fields must match exactly. A mutation sweep over anchor
 *     numbers adds several hundred more parity comparisons.
 *     The reference Worker is NOT bundled with the public repository:
 *     when it cannot be imported, parity checks are skipped (and the
 *     run says so) while all library-only assertions still run.
 *
 * Run: npm test   (or: node test/validate.test.mjs)
 */
import { validateVat, VatCheckError, SUPPORTED_COUNTRIES } from "../index.js";
let worker = null;
try {
  worker = (await import("../../../mock/worker-live.js")).default;
} catch {
  worker = null; // public repository: reference Worker not bundled
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name} ${extra}`);
    console.log(`FAIL: ${name} ${extra}`);
  }
}

const FIELDS = ["country", "normalized", "format_valid", "checksum_valid", "registration_status", "check_scope"];

async function workerValidate(country, vat) {
  const req = new Request("http://localhost/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ country, vat }),
  });
  const res = await worker.fetch(req);
  return { status: res.status, json: await res.json() };
}

/** Run one input through the library and the Worker; assert parity. */
async function runBoth(name, country, vat) {
  const lib = validateVat(country, vat);
  if (worker) {
    const { status, json } = await workerValidate(country, vat);
    check(`${name} parity-http`, status === 200, `worker got ${status}`);
    for (const f of FIELDS) {
      check(`${name} parity-${f}`, lib[f] === json[f],
        `lib=${JSON.stringify(lib[f])} worker=${JSON.stringify(json[f])}`);
    }
  }
  check(`${name} no-valid-key`, !("valid" in lib), JSON.stringify(lib));
  return lib;
}

async function expectValid(name, country, vat, expectedChecksum = true) {
  const lib = await runBoth(name, country, vat);
  check(`${name} format`, lib.format_valid === true, JSON.stringify(lib));
  check(
    `${name} checksum`,
    lib.checksum_valid === expectedChecksum,
    `expected ${expectedChecksum}, got ${JSON.stringify(lib)}`
  );
  check(`${name} scope`, lib.registration_status === "not_checked" && lib.check_scope === "format_and_checksum_only", JSON.stringify(lib));
  return lib;
}

async function expectChecksumFalse(name, country, vat) {
  const lib = await runBoth(name, country, vat);
  check(`${name} format`, lib.format_valid === true, JSON.stringify(lib));
  check(`${name} checksum-false`, lib.checksum_valid === false, JSON.stringify(lib));
}

async function expectFormatFalse(name, country, vat) {
  const lib = await runBoth(name, country, vat);
  check(`${name} format-false`, lib.format_valid === false, JSON.stringify(lib));
  check(`${name} checksum-null`, lib.checksum_valid === null, JSON.stringify(lib));
}

// ---------------------------------------------------------------------------
// Independent check-digit construction (from the public specifications;
// copied verbatim from mock/test-final.mjs)
// ---------------------------------------------------------------------------

function deCheckDigit(first8) {
  let p = 10;
  for (let i = 0; i < 8; i++) {
    let s = (Number(first8[i]) + p) % 10;
    if (s === 0) s = 10;
    p = (2 * s) % 11;
  }
  const c = 11 - p;
  return String(c === 10 ? 0 : c);
}

function frKey(siren) {
  return String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, "0");
}

function itCheckDigit(first10) {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const n = Number(first10[i]);
    if (i % 2 === 0) sum += n;
    else { const t = n * 2; sum += t > 9 ? t - 9 : t; }
  }
  return String((10 - (sum % 10)) % 10);
}

function esCompanyControl(sevenDigits) {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = Number(sevenDigits[i]);
    if (i % 2 === 0) { const t = n * 2; sum += Math.floor(t / 10) + (t % 10); }
    else sum += n;
  }
  return (10 - (sum % 10)) % 10;
}

function beCheck(base8) {
  return String(97 - (Number(base8) % 97)).padStart(2, "0");
}

function atCheckDigit(first7) {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = Number(first7[i]);
    if (i % 2 === 0) sum += n;
    else { const t = n * 2; sum += Math.floor(t / 10) + (t % 10); }
  }
  sum += 4;
  return String((10 - (sum % 10)) % 10);
}

function plCheckDigit(first9) {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += w[i] * Number(first9[i]);
  return sum % 11; // 10 means unusable base
}

function ieCheckLetter(sevenDigits, secondLetter = null) {
  const alphabet = "WABCDEFGHIJKLMNOPQRSTUV";
  const w = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += w[i] * Number(sevenDigits[i]);
  if (secondLetter) sum += 9 * alphabet.indexOf(secondLetter);
  return alphabet[sum % 23];
}

function luhnCheckDigit(first9) {
  // Swedish org number: digits at odd 1-based positions are doubled.
  for (let d = 0; d <= 9; d++) {
    const full = first9 + String(d);
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      let n = Number(full[i]);
      if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return String(d);
  }
  throw new Error("no luhn digit");
}

function elfproefDigit(first8) {
  const w = [9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += w[i] * Number(first8[i]);
  const d9 = sum % 11; // because last weight is -1: sum - d9 ≡ 0 (mod 11)
  return d9 <= 9 ? String(d9) : null;
}

function mod9710(str) {
  let rem = 0;
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) rem = (rem * 10 + (code - 48)) % 97;
    else {
      const v = code - 55;
      rem = (rem * 10 + Math.floor(v / 10)) % 97;
      rem = (rem * 10 + (v % 10)) % 97;
    }
  }
  return rem === 1;
}

function elfproefOk(d9str) {
  const w = [9, 8, 7, 6, 5, 4, 3, 2, -1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += w[i] * Number(d9str[i]);
  return sum % 11 === 0;
}

const flipDigit = (s, idx) => s.slice(0, idx) + String((Number(s[idx]) + 1) % 10) + s.slice(idx + 1);

// ---------------------------------------------------------------------------
// DE
// ---------------------------------------------------------------------------
{
  const base = "40257193";
  const valid = base + deCheckDigit(base);
  await expectValid("DE constructed", "DE", valid);
  await expectChecksumFalse("DE mutated check", "DE", flipDigit(valid, 8));
  // Externally published anchor: the long-used BZSt-style example number.
  await expectValid("DE anchor 136695976", "DE", "136695976");
  await expectValid("DE with prefix+spaces", "DE", "DE 136 695 976");
  await expectFormatFalse("DE too short", "DE", "12345678");
  await expectFormatFalse("DE letters", "DE", "12345678A");
}

// ---------------------------------------------------------------------------
// FR
// ---------------------------------------------------------------------------
{
  const siren = "732829320";
  const valid = frKey(siren) + siren;
  await expectValid("FR constructed numeric key", "FR", valid);
  const wrongKey = String((Number(frKey(siren)) + 1) % 97).padStart(2, "0") + siren;
  await expectChecksumFalse("FR wrong key", "FR", wrongKey);
  // Letter key: format ok, checksum not applicable.
  await expectValid("FR letter key", "FR", "K4" + siren, null);
  await expectFormatFalse("FR too short", "FR", "1234567890");
  await expectFormatFalse("FR letter I in key", "FR", "I4" + siren);
}

// ---------------------------------------------------------------------------
// IT
// ---------------------------------------------------------------------------
{
  const base = "0764352056";
  const valid = base + itCheckDigit(base);
  await expectValid("IT constructed", "IT", valid);
  await expectChecksumFalse("IT mutated check", "IT", flipDigit(valid, 10));
  await expectFormatFalse("IT too short", "IT", "0764352056");
}

// ---------------------------------------------------------------------------
// ES
// ---------------------------------------------------------------------------
{
  // Company, numeric control.
  const digits = "8632130";
  const ctrl = esCompanyControl(digits);
  await expectValid("ES company digit control", "ES", "B" + digits + String(ctrl));
  await expectChecksumFalse("ES company wrong digit", "ES", "B" + digits + String((ctrl + 1) % 10));
  // Company, letter control.
  const letter = "JABCDEFGHI"[ctrl];
  await expectValid("ES company letter control", "ES", "P" + digits + letter);
  // DNI form (digit start, letter control).
  const dniBase = "12345678";
  const dniLetter = "TRWAGMYFPDXBNJZSQVHLCKE"[Number(dniBase) % 23];
  await expectValid("ES DNI", "ES", dniBase + dniLetter);
  await expectChecksumFalse("ES DNI wrong letter", "ES", dniBase + (dniLetter === "A" ? "B" : "A"));
  // NIE form (X start).
  const nieLetter = "TRWAGMYFPDXBNJZSQVHLCKE"[Number("0" + digits) % 23];
  await expectValid("ES NIE X", "ES", "X" + digits + nieLetter);
  // K start: not verifiable -> null.
  await expectValid("ES K prefix", "ES", "K" + digits + "A", null);
  await expectFormatFalse("ES bad length", "ES", "B1234567");
  await expectFormatFalse("ES bad first letter I", "ES", "I" + digits + "0");
}

// ---------------------------------------------------------------------------
// NL
// ---------------------------------------------------------------------------
{
  // Externally published RSIN-based example (elfproef verified by hand).
  await expectValid("NL anchor elfproef", "NL", "806753742B01");
  // Constructed elfproef number.
  const first8 = "12345678";
  const d9 = elfproefDigit(first8);
  if (d9 !== null) {
    await expectValid("NL constructed elfproef", "NL", first8 + d9 + "B01");
  } else {
    check("NL constructed elfproef (base usable)", false, "base produced d9=10");
  }
  // Post-2020 scheme: search for a number failing elfproef but passing MOD 97-10.
  let found = null;
  for (let n = 100000000; n < 100020000 && !found; n++) {
    const cand = String(n) + "B01";
    if (!elfproefOk(String(n)) && mod9710("NL" + cand)) found = cand;
  }
  check("NL mod97 sample found", found !== null);
  if (found) await expectValid("NL constructed mod97", "NL", found);
  // A number passing neither scheme must be checksum-false.
  let bad = null;
  for (let n = 100000000; n < 100020000 && !bad; n++) {
    const cand = String(n) + "B01";
    if (!elfproefOk(String(n)) && !mod9710("NL" + cand)) bad = cand;
  }
  if (bad) await expectChecksumFalse("NL neither scheme", "NL", bad);
  await expectFormatFalse("NL suffix 00", "NL", "806753742B00");
  await expectFormatFalse("NL wrong letter", "NL", "806753742C01");
  await expectFormatFalse("NL zero block", "NL", "000000000B01");
}

// ---------------------------------------------------------------------------
// BE
// ---------------------------------------------------------------------------
{
  const base = "04287594";
  const valid = base + beCheck(base);
  await expectValid("BE constructed", "BE", valid);
  await expectChecksumFalse("BE mutated", "BE", flipDigit(valid, 9));
  await expectFormatFalse("BE starts with 2", "BE", "24287594" + beCheck("24287594"));
  await expectFormatFalse("BE too short", "BE", "042875949");
}

// ---------------------------------------------------------------------------
// AT
// ---------------------------------------------------------------------------
{
  const base = "1234567";
  const valid = "U" + base + atCheckDigit(base);
  await expectValid("AT constructed", "AT", valid);
  await expectChecksumFalse("AT mutated check", "AT", "U" + base + String((Number(atCheckDigit(base)) + 1) % 10));
  // Externally published anchors: OMV's number from its Impressum, and a
  // published checksum-valid dummy.
  await expectValid("AT anchor OMV", "AT", "U14189108");
  await expectValid("AT anchor dummy", "AT", "U12345675");
  await expectValid("AT with AT prefix", "AT", "ATU14189108");
  await expectFormatFalse("AT missing U", "AT", "14189108");
}

// ---------------------------------------------------------------------------
// PL
// ---------------------------------------------------------------------------
{
  let valid = null;
  for (const base of ["526104082", "856734621", "123456788"]) {
    const r = plCheckDigit(base);
    if (r !== 10) { valid = base + String(r); break; }
  }
  check("PL sample constructed", valid !== null);
  if (valid) {
    await expectValid("PL constructed", "PL", valid);
    await expectChecksumFalse("PL mutated", "PL", flipDigit(valid, 9));
  }
  await expectFormatFalse("PL too short", "PL", "123456789");
}

// ---------------------------------------------------------------------------
// IE
// ---------------------------------------------------------------------------
{
  const digits = "1234567";
  const chk = ieCheckLetter(digits);
  await expectValid("IE constructed 8-char", "IE", digits + chk);
  await expectValid("IE constructed 9-char", "IE", digits + ieCheckLetter(digits, "H") + "H");
  // Published worked examples.
  await expectValid("IE anchor 1234567T", "IE", "1234567T");
  await expectValid("IE anchor 1234567WH", "IE", "1234567WH");
  // Published as failing the check.
  await expectChecksumFalse("IE anchor 1234567A fails", "IE", "1234567A");
  await expectChecksumFalse("IE wrong letter", "IE", digits + (chk === "A" ? "B" : "A"));
  // Legacy shape: format ok, checksum null.
  await expectValid("IE legacy shape", "IE", "8D79739I", null);
  await expectFormatFalse("IE too short", "IE", "123456T");
}

// ---------------------------------------------------------------------------
// SE
// ---------------------------------------------------------------------------
{
  const first9 = "556074756";
  const valid = first9 + luhnCheckDigit(first9) + "01";
  check("SE constructed equals anchor", valid === "556074756901", valid);
  await expectValid("SE anchor orgnr", "SE", "556074756901");
  await expectChecksumFalse("SE mutated check", "SE", flipDigit("556074756901", 9));
  await expectFormatFalse("SE wrong suffix", "SE", "556074756902");
}

// ---------------------------------------------------------------------------
// DK
// ---------------------------------------------------------------------------
{
  await expectValid("DK format only", "DK", "32357809", null);
  await expectFormatFalse("DK starts with 0", "DK", "02357809");
  await expectFormatFalse("DK too short", "DK", "3235780");
}

// ---------------------------------------------------------------------------
// Library error contract (mirrors the hosted API's error responses)
// ---------------------------------------------------------------------------
function expectThrow(name, args, code) {
  let thrown = null;
  try {
    validateVat(...args);
  } catch (e) {
    thrown = e;
  }
  check(`${name} throws`, thrown !== null, "no error thrown");
  if (thrown) {
    check(`${name} is VatCheckError`, thrown instanceof VatCheckError, String(thrown));
    check(`${name} code`, thrown.code === code, `got ${thrown.code}`);
  }
  return thrown;
}
{
  expectThrow("missing vat", ["DE"], "invalid_request");
  expectThrow("empty vat", ["DE", ""], "invalid_request");
  expectThrow("missing country", ["", "136695976"], "invalid_request");
  expectThrow("non-string country", [123, "136695976"], "invalid_request");
  expectThrow("non-string vat", ["DE", 136695976], "invalid_request");
  const e1 = expectThrow("unsupported XX", ["XX", "123"], "unsupported_country");
  if (e1) check("unsupported carries supported list", Array.isArray(e1.supported) && e1.supported.length === 11, JSON.stringify(e1.supported));
  expectThrow("unsupported JP", ["JP", "123"], "unsupported_country");

  // The Worker agrees on these inputs (400 + same error codes).
  if (worker) {
    const w1 = await workerValidate("DE", "");
    check("worker empty vat -> 400 invalid_request", w1.status === 400 && w1.json.error === "invalid_request", JSON.stringify(w1.json));
    const w2 = await workerValidate("XX", "123");
    check("worker XX -> 400 unsupported_country", w2.status === 400 && w2.json.error === "unsupported_country", JSON.stringify(w2.json));
  }

  // Lowercase country + messy input normalization (Worker case, ported).
  const lib = await runBoth("normalization dots+case", "de", "136.695.976");
  check("normalization result", lib.format_valid === true && lib.normalized === "136695976", JSON.stringify(lib));

  check("SUPPORTED_COUNTRIES has 11 entries", SUPPORTED_COUNTRIES.length === 11, SUPPORTED_COUNTRIES.join(","));
  check("SUPPORTED_COUNTRIES frozen", Object.isFrozen(SUPPORTED_COUNTRIES));
}

// ---------------------------------------------------------------------------
// Mutation parity sweep: mutate every position of one anchor number per
// country with several replacement characters; library and Worker must
// agree on all six fields every time.
// ---------------------------------------------------------------------------
{
  const anchors = {
    DE: "136695976",
    FR: frKey("732829320") + "732829320",
    IT: "0764352056" + itCheckDigit("0764352056"),
    ES: "B8632130" + String(esCompanyControl("8632130")),
    NL: "806753742B01",
    BE: "04287594" + beCheck("04287594"),
    AT: "U14189108",
    PL: "526104082" + String(plCheckDigit("526104082")),
    IE: "1234567T",
    SE: "556074756901",
    DK: "32357809",
  };
  const replacements = ["0", "1", "9", "A", "B", "X"];
  let sweep = 0;
  for (const [cc, anchor] of Object.entries(anchors)) {
    for (let i = 0; i < anchor.length; i++) {
      for (const r of replacements) {
        if (anchor[i] === r) continue;
        const mutated = anchor.slice(0, i) + r + anchor.slice(i + 1);
        const lib = validateVat(cc, mutated);
        if (worker) {
          const { status, json } = await workerValidate(cc, mutated);
          let ok = status === 200;
          for (const f of FIELDS) ok = ok && lib[f] === json[f];
          check(`sweep ${cc} ${mutated}`, ok, `lib=${JSON.stringify(lib)} worker=${JSON.stringify(json)}`);
        } else {
          const shape = typeof lib.format_valid === "boolean"
            && (lib.checksum_valid === null || typeof lib.checksum_valid === "boolean")
            && lib.registration_status === "not_checked"
            && lib.check_scope === "format_and_checksum_only"
            && !("valid" in lib);
          check(`sweep ${cc} ${mutated}`, shape, `lib=${JSON.stringify(lib)}`);
        }
        sweep++;
      }
    }
  }
  console.log(`mutation sweep: ${sweep} comparisons (${worker ? "worker parity" : "library-only, reference Worker not bundled"})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
