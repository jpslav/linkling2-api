// What the redirect needs to know about a link. The store behind it is injected, so the
// HTTP layer never reaches the database itself.

export interface Link {
  /** The link's internal id, which its daily counts hang off (ADR-0003). Shown nowhere. */
  id: number;
  target: string;
  /** null: the link never expires (ADR-0003). */
  expiresAt: Date | null;
}

export interface LinkLookup {
  /** The link stored under a lower-cased name, or null when it was deleted or never made. */
  lookup(name: string): Promise<Link | null>;
  /** One followed link: that UTC day's count for it goes up by one (R-009, R-029). */
  countFollow(id: number, now: Date): void | Promise<void>;
}

/** A link has expired once its expiry is reached. */
export function isExpired(link: Pick<Link, "expiresAt">, now: Date): boolean {
  return link.expiresAt !== null && now.getTime() >= link.expiresAt.getTime();
}
