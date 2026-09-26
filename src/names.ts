// Short names, as ADR-0001 fixes them. Printed links carry these shapes forever;
// tests/url-shape.test.ts fails if any of them changes.
import { randomInt } from "node:crypto";

// Made-up names: six characters from 31, leaving out 0 o 1 l i.
export const MADE_UP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const MADE_UP_LENGTH = 6;

// Checked on the raw input, before lower-casing: String.prototype.toLowerCase maps some
// non-ASCII characters (KELVIN SIGN U+212A) onto ASCII letters.
const CHOSEN_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The stored form of a name: lower-case, or null when it is not a name at all
 * (empty, over 64 characters, starting with `-`, or anything but letters, digits and `-`).
 * A leading `-` is refused so that no name can reach the service's own routes under `/-/`.
 */
export function normalizeName(raw: string): string | null {
  return CHOSEN_NAME.test(raw) ? raw.toLowerCase() : null;
}

/** Returns an integer in [0, max), uniformly. The default is a cryptographic source. */
export type RandomIndex = (max: number) => number;

export function makeUpName(randomIndex: RandomIndex = randomInt): string {
  let name = "";
  for (let i = 0; i < MADE_UP_LENGTH; i++) {
    name += MADE_UP_ALPHABET[randomIndex(MADE_UP_ALPHABET.length)];
  }
  return name;
}

/**
 * Makes up names until `tryClaim` takes one, and returns it. `tryClaim` should be the
 * insert itself, answering false on a name clash, so that two makers cannot both win.
 * Throws after `attempts` refusals.
 */
export async function claimMadeUpName(
  tryClaim: (name: string) => boolean | Promise<boolean>,
  randomIndex: RandomIndex = randomInt,
  attempts = 10,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const name = makeUpName(randomIndex);
    if (await tryClaim(name)) return name;
  }
  throw new Error(`no free made-up name after ${attempts} attempts`);
}
