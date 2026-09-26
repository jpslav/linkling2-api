// An in-memory stand-in for the link store, for tests of the HTTP layer only.
import type { Link, LinkLookup } from "../../src/links.js";

export class MemoryLinks implements LinkLookup {
  readonly links = new Map<string, Link>();
  lookups = 0;

  make(name: string, target: string, expiresAt: Date | null = null): this {
    this.links.set(name, { target, expiresAt });
    return this;
  }

  /** Stores a link only if the name is free; the shape `claimMadeUpName` expects. */
  claim(name: string, target = "https://example.com/"): boolean {
    if (this.links.has(name)) return false;
    this.make(name, target);
    return true;
  }

  delete(name: string): void {
    this.links.delete(name);
  }

  async lookup(name: string): Promise<Link | null> {
    this.lookups++;
    return this.links.get(name) ?? null;
  }
}
