import { describe, expect, it } from "vitest";

import { isSecurePage, matchesTab, registrableDomain } from "./domain";

describe("registrableDomain", () => {
  it("reduces a URL to its eTLD+1", () => {
    expect(registrableDomain("https://login.example.com/path?x=1")).toBe("example.com");
    expect(registrableDomain("https://example.com")).toBe("example.com");
  });

  it("handles multi-label public suffixes (co.uk)", () => {
    expect(registrableDomain("https://www.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("treats private suffixes as suffixes so tenants never share a domain", () => {
    // github.io is a PRIVATE suffix: two users must NOT collapse to github.io.
    expect(registrableDomain("https://alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("https://bob.github.io")).toBe("bob.github.io");
  });

  it("returns null for IPs, bare suffixes, and junk", () => {
    expect(registrableDomain("https://127.0.0.1")).toBeNull();
    expect(registrableDomain("https://localhost")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });
});

describe("matchesTab", () => {
  it("matches when the tab and the entry share a registrable domain", () => {
    // Entry stored as a full host; tab on the apex or another subdomain still matches.
    expect(matchesTab("https://example.com/login", "www.example.com")).toBe(true);
    expect(matchesTab("https://login.example.com", "example.com")).toBe(true);
  });

  it("does not match across different registrable domains", () => {
    expect(matchesTab("https://evil.com", "example.com")).toBe(false);
    expect(matchesTab("https://example.com.evil.com", "example.com")).toBe(false);
    expect(matchesTab("https://notexample.com", "example.com")).toBe(false);
  });

  it("does not match tenants of a shared private suffix", () => {
    expect(matchesTab("https://alice.github.io", "bob.github.io")).toBe(false);
  });

  it("is fail-closed when either side has no domain", () => {
    expect(matchesTab("https://example.com", undefined)).toBe(false);
    expect(matchesTab(undefined, "example.com")).toBe(false);
    expect(matchesTab("https://127.0.0.1", "example.com")).toBe(false);
  });

  it("ignores port and protocol differences in the host reduction", () => {
    expect(matchesTab("https://example.com:8443/app", "example.com")).toBe(true);
    expect(matchesTab("http://example.com", "example.com")).toBe(true);
  });
});

describe("isSecurePage", () => {
  it("accepts only https", () => {
    expect(isSecurePage("https://example.com")).toBe(true);
    expect(isSecurePage("http://example.com")).toBe(false);
    expect(isSecurePage("file:///tmp/x.html")).toBe(false);
    expect(isSecurePage("about:blank")).toBe(false);
    expect(isSecurePage(undefined)).toBe(false);
    expect(isSecurePage("garbage")).toBe(false);
  });
});
