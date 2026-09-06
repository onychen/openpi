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

  assert.equal(transformed?.text, "before [Image #1] between [Image #2]");
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

test("Alt+Enter paths retain images after Pi clears the editor first", () => {
  for (const pathKind of ["idle", "streaming"] as const) {
    const path = temporaryImage("png", pathKind);
    const store = new ImageAttachmentStore();
    const base = new FakeEditor();
    const editor = new ImageAttachmentEditor(base, keybindings, store);

    editor.insertTextAtCursor("send ");
    editor.insertTextAtCursor(path);
    const submittedText = editor.getText();
    editor.setText("");

    let transformed: ReturnType<typeof transformImageAttachmentInput>;
    if (pathKind === "idle") {
      editor.onSubmit = (text) => {
        transformed = transformImageAttachmentInput(store, {
          text,
          source: "interactive",
        });
      };
      editor.onSubmit(submittedText);
    } else {
      transformed = transformImageAttachmentInput(store, {
        text: submittedText,
        source: "interactive",
      });
    }

    assert.equal(transformed?.text, "send [Image #1]");
    assert.equal(
      transformed?.images[0]?.data,
      Buffer.from(pathKind).toString("base64"),
    );
    assert.equal(existsSync(path), false);
  }
});

test("submitted images survive until Pi emits the delayed input event", async () => {
  const path = temporaryImage("png", "delayed");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor("describe ");
  editor.insertTextAtCursor(path);
  const submittedText = editor.getText();
  editor.onSubmit = async () => {};
  base.submit();

  // Pi may queue the text in pendingUserInputs and resolve onSubmit before its
  // main loop reaches session.prompt(), which is where the input event fires.
  await Promise.resolve();
  const transformed = transformImageAttachmentInput(store, {
    text: submittedText,
    source: "interactive",
  });

  assert.equal(transformed?.text, "describe [Image #1]");
  assert.equal(
    transformed?.images[0]?.data,
    Buffer.from("delayed").toString("base64"),
  );
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

test("duplicating a placeholder makes both copies ordinary text", () => {
  const path = temporaryImage("png", "image");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" [Image #1]");

  assert.equal(editor.getText(), "[Image #1] [Image #1]");
  assert.equal(existsSync(path), false);
  assert.equal(
    transformImageAttachmentInput(store, {
      text: editor.getText(),
      source: "interactive",
    }),
    undefined,
  );
});

test("deleting the last image makes its number available to the next paste", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("png", "second");
  const third = temporaryImage("png", "third");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "[Image #1] [Image #2]");

  base.cursor = editor.getText().length;
  editor.handleInput("BACKSPACE");
  assert.equal(editor.getText(), "[Image #1] ");
  assert.equal(existsSync(second), false);

  base.cursor = editor.getText().length;
  editor.insertTextAtCursor(third);
  assert.equal(editor.getText(), "[Image #1] [Image #2]");
  store.cleanup();
});

test("deleting an earlier image does not reorder later image numbers", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("png", "second");
  const third = temporaryImage("png", "third");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(second);
  base.cursor = "[Image #1]".length;
  editor.handleInput("BACKSPACE");

  assert.equal(editor.getText(), " [Image #2]");
  base.cursor = editor.getText().length;
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(third);
  assert.equal(editor.getText(), " [Image #2] [Image #3]");
  store.cleanup();
});

test("a failed image read removes the dangling placeholder", () => {
  const path = temporaryImage("png", "image");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" after");
  const text = editor.getText();
  const submissionId = store.beginSubmission(text);
  assert.notEqual(submissionId, undefined);
  rmSync(path, { force: true });

  const transformed = transformImageAttachmentInput(store, {
    text,
    source: "interactive",
  });
  assert.equal(transformed?.text, "before  after");
  assert.deepEqual(transformed?.images, []);
  assert.deepEqual(transformed?.failures, ["[Image #1]"]);
});

test("removing the draft or ending the session cleans temporary images", async () => {
  const removed = temporaryImage("png", "removed");
  const pending = temporaryImage("png", "pending");
  const shutdown = temporaryImage("png", "shutdown");
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);

  editor.insertTextAtCursor(removed);
  editor.setText("");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(existsSync(removed), false);

  editor.insertTextAtCursor(pending);
  editor.onSubmit = async () => {};
  base.submit();
  await Promise.resolve();
  assert.equal(existsSync(pending), true);

  editor.insertTextAtCursor(shutdown);
  store.cleanup();
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(shutdown), false);

  rmSync(removed, { force: true });
  rmSync(pending, { force: true });
  rmSync(shutdown, { force: true });
});
