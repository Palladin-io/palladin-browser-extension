import { describe, expect, it } from "vitest";

import { messageForError, PopupSessionError } from "./errors";

describe("messageForError", () => {
  it("reads a bad credential differently per context", () => {
    const err = new PopupSessionError("invalid-credentials");
    expect(messageForError(err, "sign-in")).toMatch(/email or master password/i);
    expect(messageForError(err, "unlock")).toMatch(/master password/i);
    expect(messageForError(err, "totp")).toMatch(/code/i);
  });

  it("shares network and setup messages across contexts", () => {
    expect(messageForError(new PopupSessionError("network"), "unlock")).toMatch(/connection/i);
    expect(messageForError(new PopupSessionError("no-account-material"), "sign-in")).toMatch(
      /web panel/i,
    );
  });

  it("never leaks a raw non-session error", () => {
    expect(messageForError(new Error("secret=hunter2"), "sign-in")).not.toMatch(/hunter2/);
  });
});
