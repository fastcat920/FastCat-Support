import test from "node:test";
import assert from "node:assert/strict";
import {
  createMessageSound,
  shouldSendMessage,
  insertComposerEmoji,
} from "../public/chat-controls.js";
test("visitor message sound waits for interaction and respects mute", async () => {
  const originalDocument = globalThis.document,
    originalWindow = globalThis.window;
  const events = {};
  let started = 0;
  globalThis.document = { addEventListener: (name, fn) => (events[name] = fn) };
  class AudioContext {
    state = "suspended";
    currentTime = 0;
    destination = {};
    async resume() {
      this.state = "running";
    }
    createOscillator() {
      return {
        connect() {},
        frequency: { setValueAtTime() {} },
        start() {
          started++;
        },
        stop() {},
      };
    }
    createGain() {
      return {
        connect() {},
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
      };
    }
  }
  globalThis.window = { AudioContext };
  try {
    const sound = createMessageSound();
    sound.play();
    assert.equal(started, 0);
    await events.pointerdown();
    sound.play();
    assert.equal(started, 1);
    assert.equal(sound.toggle(), false);
    sound.play();
    assert.equal(started, 1);
    assert.equal(sound.toggle(), true);
    await Promise.resolve();
    assert.equal(started, 2);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("Enter sends while Shift+Enter and IME confirmation do not send", () => {
  assert.equal(shouldSendMessage({ key: "Enter" }), true);
  assert.equal(shouldSendMessage({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSendMessage({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSendMessage({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSendMessage({ key: "Enter", repeat: true }), false);
  assert.equal(shouldSendMessage({ key: "a" }), false);
});

test("emoji insertion restores the caret and focuses input without scrolling", () => {
  let focused = false,
    changed = false;
  const input = {
    disabled: false,
    selectionStart: 2,
    selectionEnd: 4,
    setRangeText(emoji, start, end, mode) {
      assert.equal(emoji, "😀");
      assert.equal(start, 2);
      assert.equal(end, 4);
      assert.equal(mode, "end");
    },
    dispatchEvent(e) {
      changed = e.type === "input";
    },
    focus(options) {
      assert.equal(options.preventScroll, true);
      focused = true;
    },
  };
  insertComposerEmoji(input, "😀");
  assert.equal(focused, true);
  assert.equal(changed, true);
});
