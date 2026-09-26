// What the redirect needs to know about a link. The store behind it is injected, so the
// HTTP layer never reaches the database itself.

export interface Link {
  target: string;
  /** null: the link never expires (ADR-0003). */
  expiresAt: Date | null;
}

export interface LinkLookup {
  /** The link stored under a lower-cased name, or null when it was deleted or never made. */
  lookup(name: string): Promise<Link | null>;
}

/** A link has expired once its expiry is reached. */
export function isExpired(link: Link, now: Date): boolean {
  return link.expiresAt !== null && now.getTime() >= link.expiresAt.getTime();
}
