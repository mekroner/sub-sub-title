import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcutMatch";

describe("matchShortcut", () => {
  it("maps the basic editing keys", () => {
    expect(matchShortcut({ code: "Space" })).toEqual({ type: "togglePlay" });
    expect(matchShortcut({ code: "KeyS" })).toEqual({ type: "split" });
    expect(matchShortcut({ code: "KeyM" })).toEqual({ type: "merge" });
    expect(matchShortcut({ code: "ArrowUp" })).toEqual({ type: "selectPrevious" });
    expect(matchShortcut({ code: "ArrowDown" })).toEqual({ type: "selectNext" });
    expect(matchShortcut({ code: "Enter" })).toEqual({ type: "jumpToSelected" });
  });

  it("assigns speakers from the digit row", () => {
    expect(matchShortcut({ code: "Digit1" })).toEqual({ type: "assignSpeaker", index: 0 });
    expect(matchShortcut({ code: "Digit9" })).toEqual({ type: "assignSpeaker", index: 8 });
    expect(matchShortcut({ code: "Digit0" })).toEqual({ type: "clearSpeaker" });
  });

  it("nudges the right edge for the modifier used", () => {
    expect(matchShortcut({ code: "BracketLeft" })).toEqual({
      type: "nudge",
      edge: "start",
      direction: -1,
    });
    expect(matchShortcut({ code: "BracketRight", shiftKey: true })).toEqual({
      type: "nudge",
      edge: "end",
      direction: 1,
    });
    expect(matchShortcut({ code: "Comma", altKey: true })).toEqual({
      type: "nudge",
      edge: "both",
      direction: -1,
    });
  });

  it("handles the Ctrl chords and ignores the rest", () => {
    expect(matchShortcut({ code: "KeyS", ctrlKey: true })).toEqual({ type: "save" });
    expect(matchShortcut({ code: "KeyZ", ctrlKey: true })).toEqual({ type: "undo" });
    expect(matchShortcut({ code: "KeyZ", ctrlKey: true, shiftKey: true })).toEqual({
      type: "redo",
    });
    expect(matchShortcut({ code: "KeyG", ctrlKey: true })).toEqual({ type: "generate" });
    // Left for the webview.
    expect(matchShortcut({ code: "KeyC", ctrlKey: true })).toBeNull();
    expect(matchShortcut({ code: "KeyV", ctrlKey: true })).toBeNull();
  });

  it("does not fire Ctrl actions from the bare key", () => {
    expect(matchShortcut({ code: "KeyS" })).toEqual({ type: "split" });
    expect(matchShortcut({ code: "KeyG" })).toBeNull();
  });

  /**
   * Regression: injected and on-screen-keyboard events can leave `code` empty,
   * which made every shortcut silently inert.
   */
  it("falls back to `key` when `code` is missing", () => {
    expect(matchShortcut({ code: "", key: "f" })).toEqual({ type: "toggleFollow" });
    expect(matchShortcut({ key: "f" })).toEqual({ type: "toggleFollow" });
    expect(matchShortcut({ key: " " })).toEqual({ type: "togglePlay" });
    expect(matchShortcut({ key: "3" })).toEqual({ type: "assignSpeaker", index: 2 });
    expect(matchShortcut({ key: "s", ctrlKey: true })).toEqual({ type: "save" });
    expect(matchShortcut({ key: "ArrowDown" })).toEqual({ type: "selectNext" });
  });

  it("prefers physical position over the character, for non-US layouts", () => {
    // The Norwegian layout puts "å" where BracketLeft sits.
    expect(matchShortcut({ code: "BracketLeft", key: "å" })).toEqual({
      type: "nudge",
      edge: "start",
      direction: -1,
    });
  });

  it("opens help for ? on either layout", () => {
    expect(matchShortcut({ code: "Slash", shiftKey: true })).toEqual({ type: "showHelp" });
    expect(matchShortcut({ key: "?" })).toEqual({ type: "showHelp" });
    expect(matchShortcut({ code: "Slash" })).toBeNull();
  });

  it("returns null for keys it does not own", () => {
    expect(matchShortcut({ code: "KeyQ" })).toBeNull();
    expect(matchShortcut({ code: "F5" })).toBeNull();
    expect(matchShortcut({})).toBeNull();
  });
});
