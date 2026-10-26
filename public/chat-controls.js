// Shared native composer controls for the website and staff workspace.
export function bindComposer(form) {
  const input = form.querySelector("textarea");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      if (!input.disabled)
        form.requestSubmit(form.querySelector("[type=submit]"));
    }
  });
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "quiet emoji-trigger";
  trigger.textContent = "☺";
  trigger.setAttribute("aria-label", "选择表情");
  trigger.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "emoji-picker";
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "表情选择");
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  for (const emoji of [
    "😀",
    "😊",
    "😂",
    "🥰",
    "😉",
    "🤔",
    "😅",
    "🥲",
    "😎",
    "🙏",
    "👍",
    "👏",
    "🙌",
    "🤝",
    "❤️",
    "💛",
    "💚",
    "💙",
    "🎉",
    "🎁",
    "✨",
    "🌟",
    "✅",
    "💬",
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.setAttribute("aria-label", emoji);
    button.onclick = () => {
      if (input.disabled) return;
      input.setRangeText(
        emoji,
        input.selectionStart,
        input.selectionEnd,
        "end",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      close();
      input.focus();
    };
    panel.append(button);
  }
  trigger.onclick = () => {
    if (input.disabled) return;
    panel.hidden = !panel.hidden;
    trigger.setAttribute("aria-expanded", String(!panel.hidden));
  };
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      trigger.focus();
    }
  });
  form.addEventListener("focusout", (e) => {
    if (!form.contains(e.relatedTarget)) close();
  });
  form.querySelector(".composer-footer div.row").prepend(trigger);
  form.append(panel);
  if (form.id === "reply-form") {
    const toolbar = document.createElement("div");
    toolbar.className = "composer-tools";
    toolbar.append(trigger);
    for (const id of ["upload-attachment", "quick-replies", "ai-draft"]) {
      const button = form.querySelector("#" + id);
      if (button) toolbar.append(button);
    }
    form.prepend(toolbar);
  }
}
export function createMessageSound() {
  let context,
    enabled = true;
  async function unlock() {
    try {
      context ||= new (window.AudioContext || window.webkitAudioContext)();
      if (context.state === "suspended") await context.resume();
    } catch {}
  }
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
  return {
    toggle() {
      enabled = !enabled;
      if (enabled) {
        unlock().then(() => this.play());
      }
      return enabled;
    },
    play() {
      if (!enabled || context?.state !== "running") return;
      try {
        const tone = context.createOscillator(),
          gain = context.createGain(),
          now = context.currentTime;
        tone.connect(gain);
        gain.connect(context.destination);
        tone.frequency.setValueAtTime(740, now);
        tone.frequency.setValueAtTime(990, now + 0.12);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.13, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        tone.start(now);
        tone.stop(now + 0.36);
      } catch {}
    },
  };
}
