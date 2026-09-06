import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  ImageAttachmentEditor,
  ImageAttachmentStore,
  transformImageAttachmentInput,
} from "../../../extensions/image-paste/index.ts";

function temporaryImage(extension: "jpg" | "png", bytes: string) {
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
  writeFileSync(path, bytes);
  return path;
}

class FakeEditor implements EditorComponent {
  focused = false;
  text = "";
  cursor = 0;
  setTextCalls = 0;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  render() {
    return [this.text];
  }

  invalidate() {}

  getText() {
    return this.text;
  }

  getExpandedText() {
    return this.text;
  }

  getCursor() {
    const before = this.text.slice(0, this.cursor).split("\n");
    return { line: before.length - 1, col: before.at(-1)?.length ?? 0 };
  }

  setText(text: string) {
    this.setTextCalls += 1;
    this.text = text;
    this.cursor = text.length;
    this.onChange?.(text);
  }

  insertTextAtCursor(text: string) {
    this.text =
      this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.onChange?.(this.text);
  }

  handleInput(data: string) {
    if (data === "\u001b[D") this.cursor = Math.max(0, this.cursor - 1);
    if (data === "\u001b[C") {
      this.cursor = Math.min(this.text.length, this.cursor + 1);
    }
    if (data === "BACKSPACE" && this.cursor > 0) {
      this.text =
        this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
      this.cursor -= 1;
      this.onChange?.(this.text);
    }
  }

  submit() {
    const text = this.text.trim();
    this.text = "";
    this.cursor = 0;
    this.onChange?.("");
    this.onSubmit?.(text);
  }
}

const keybindings = {
  matches: (data: string, action: string) =>
    data === "BACKSPACE" && action === "tui.editor.deleteCharBackward",
} as unknown as KeybindingsManager;

test("clipboard images become compact ordered placeholders and native image content", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("jpg", "second");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" between ");
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "before [Image #1] between [Image #2]");

  let transformed: ReturnType<typeof transformImageAttachmentInput> | undefined;
  editor.onSubmit = (text) => {
    transformed = transformImageAttachmentInput(store, {
      text,
      source: "interactive",
    });
  };
  base.submit();

  assert.equal(transformed?.text, "before  between ");
  assert.deepEqual(
    transformed?.images.map(({ data, mimeType }) => ({ data, mimeType })),
    [
      { data: Buffer.from("first").toString("base64"), mimeType: "image/png" },
      {
        data: Buffer.from("second").toString("base64"),
        mimeType: "image/jpeg",
      },
    ],
  );
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), false);

  const nextPrompt = temporaryImage("png", "next");
  editor.insertTextAtCursor(nextPrompt);
  assert.equal(editor.getText(), "[Image #1]");
  store.cleanup();
  assert.equal(existsSync(nextPrompt), false);
});

test("backspace anywhere in an image placeholder removes it atomically", () => {
  const path = temporaryImage("png", "image");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor("left ");
  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" right");
  base.cursor = "left [Image".length;
  editor.handleInput("BACKSPACE");

  assert.equal(editor.getText(), "left  right");
  assert.equal(base.cursor, "left ".length);
  assert.equal(base.setTextCalls, 0);
  assert.equal(existsSync(path), false);
});

test("ordinary paths and unregistered placeholder text stay ordinary text", () => {
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor("/tmp/example.png [Image #1]");
  assert.equal(editor.getText(), "/tmp/example.png [Image #1]");
  assert.equal(
    transformImageAttachmentInput(store, {
      text: editor.getText(),
      source: "interactive",
    }),
    undefined,
  );
});

test("removing the draft or ending the session cleans temporary images", () => {
  const removed = temporaryImage("png", "removed");
  const shutdown = temporaryImage("png", "shutdown");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor(removed);
  editor.setText("");
  assert.equal(existsSync(removed), false);

  editor.insertTextAtCursor(shutdown);
  store.cleanup();
  assert.equal(existsSync(shutdown), false);

  rmSync(removed, { force: true });
  rmSync(shutdown, { force: true });
});
