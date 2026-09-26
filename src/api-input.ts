// What the team API accepts in a request body (ADR-0012), checked by hand rather than by
// Fastify's schema: its default Ajv drops unknown fields and coerces types, and a typo like
// `expiry` should be refused, not silently ignored.
import { normalizeName } from "./names.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MakeRequest {
  /** null: make one up. */
  name: string | null;
  target: string;
  madeBy: string;
  /** null: the link never expires (ADR-0003). */
  expiresAt: Date | null;
}

const MAX_URL = 2048;
const MAX_MADE_BY = 64;
// Control characters (C0 and C1), Unicode line and paragraph separators, and the
// bidirectional marks, embeddings, overrides and isolates that can make a name display as
// something else: none belongs in a name shown on the stats page or printed by the CLI.
// Other format characters stay allowed: the zero-width joiner builds emoji sequences, and
// the zero-width non-joiner is ordinary spelling in Persian.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LIFETIME = /^([1-9]\d{0,5})([smhd])$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function fields(body: unknown, allowed: readonly string[]): Parsed<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("the body must be a JSON object");
  }
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return fail(`unknown field "${unknown}"; the fields are ${allowed.join(", ")}`);
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * The target as it is stored and sent as Location: absolute http or https, in the URL
 * parser's encoded form, which a response header can always carry.
 */
function parseTarget(url: unknown): Parsed<string> {
  if (url === undefined) return fail("url is required");
  if (typeof url !== "string" || !URL.canParse(url)) return fail("url must be an absolute http or https URL");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("url must be an absolute http or https URL");
  }
  if (parsed.href.length > MAX_URL) return fail(`url must be at most ${MAX_URL} characters once encoded`);
  return { ok: true, value: parsed.href };
}

/**
 * An expiry is a date, meaning the end of that UTC day (ADR-0003), or a lifetime counted
 * from now; absent or null, the link never expires. One already past is refused.
 */
export function parseExpiry(expires: unknown, now: Date): Parsed<Date | null> {
  if (expires === undefined || expires === null) return { ok: true, value: null };
  const shape = "expires must be a date (YYYY-MM-DD) or a lifetime such as 7d (s, m, h or d)";
  if (typeof expires !== "string") return fail(shape);
  let at: Date;
  const date = DATE.exec(expires);
  const lifetime = LIFETIME.exec(expires);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    at = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    // Date.UTC rolls 2026-02-30 over into March; a date that moved was not a date.
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return fail(shape);
  } else if (lifetime !== null) {
    at = new Date(now.getTime() + Number(lifetime[1]) * UNIT_MS[lifetime[2] as keyof typeof UNIT_MS]);
  } else {
    return fail(shape);
  }
  if (at.getTime() <= now.getTime()) return fail(`expires is already past: ${at.toISOString()}`);
  return { ok: true, value: at };
}

/** A made-by name is whatever the maker gives, trimmed; none given is the empty string. */
function parseMadeBy(madeBy: unknown): Parsed<string> {
  if (madeBy === undefined || madeBy === null) return { ok: true, value: "" };
  const rule = `made_by must be a string of at most ${MAX_MADE_BY} characters with no line breaks`;
  if (typeof madeBy !== "string") return fail(rule);
  const trimmed = madeBy.trim();
  if (trimmed.length > MAX_MADE_BY || CONTROL.test(trimmed)) return fail(rule);
  return { ok: true, value: trimmed };
}

/** The body of `POST /-/api/links`. */
export function parseMake(body: unknown, now: Date): Parsed<MakeRequest> {
  const given = fields(body, ["url", "name", "made_by", "expires"]);
  if (!given.ok) return given;
  const { url, name, made_by, expires } = given.value;

  const target = parseTarget(url);
  if (!target.ok) return target;
  let chosen: string | null = null;
  if (name !== undefined && name !== null) {
    chosen = typeof name === "string" ? normalizeName(name) : null;
    if (chosen === null) return fail("name must be 1–64 letters, digits and hyphens, not starting with a hyphen");
  }
  const madeBy = parseMadeBy(made_by);
  if (!madeBy.ok) return madeBy;
  const expiresAt = parseExpiry(expires, now);
  if (!expiresAt.ok) return expiresAt;

  return { ok: true, value: { name: chosen, target: target.value, madeBy: madeBy.value, expiresAt: expiresAt.value } };
}

/** The body of `PATCH /-/api/links/:name`: only the target can change (ADR-0001). */
export function parseEdit(body: unknown): Parsed<string> {
  const given = fields(body, ["url"]);
  if (!given.ok) return given;
  return parseTarget(given.value.url);
}
