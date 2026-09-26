// The one team key (ADR-0005): API calls send it as `Authorization: Bearer <key>`, the stats
// page through the browser's Basic prompt as the password, with any user name.
import { createHash, timingSafeEqual } from "node:crypto";

/** What a 401 asks the browser's password prompt for (RFC 7617). */
export const KEY_CHALLENGE = 'Basic realm="Linkling", charset="UTF-8"';

/** The key an Authorization header carries, or null when it carries none in either form. */
export function keyFromAuthorization(header: string | undefined): string | null {
  const match = /^(\S+) +(.+)$/.exec(header ?? "");
  if (match === null) return null;
  const scheme = match[1]!.toLowerCase();
  const credentials = match[2]!;
  if (scheme === "bearer") return credentials;
  if (scheme !== "basic") return null;
  const decoded = Buffer.from(credentials, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  // Any user name, or none: the password is everything after the first colon.
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/**
 * Why a key cannot be used, or null when it can. A key must be printable ASCII with no
 * spaces. Node trims the ends of header values, and a space at either end of a Bearer key
 * is lost, so such a key works as the Basic password but never as Bearer. Node also reads
 * header bytes as latin1, so a non-ASCII key sent as UTF-8 (as curl sends it) never matches.
 * A space inside a key would survive; it is refused too, to keep the rule one line.
 */
export function keyProblem(key: string | undefined): string | null {
  if (key === undefined || key === "") return "is not set";
  if (!/^[\x21-\x7e]+$/.test(key)) return "must be printable ASCII with no spaces or line breaks";
  return null;
}

function digest(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/**
 * A check against one key, in constant time: both sides are hashed to 32 bytes first, so
 * neither the content nor the length of a wrong key shortens the comparison.
 */
export function keyChecker(key: string): (given: string | null) => boolean {
  const problem = keyProblem(key);
  if (problem !== null) throw new Error(`the team key ${problem}; an app cannot be built without a usable one`);
  const expected = digest(key);
  return (given) => given !== null && timingSafeEqual(digest(given), expected);
}
