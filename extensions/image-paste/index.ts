import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";

const IMAGE_PLACEHOLDER = /\[Image #(\d+)\]/g;
const PI_CLIPBOARD_IMAGE =
  /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(gif|jpe?g|png|webp)$/i;
const LEFT_INPUT = "\u001b[D";
const RIGHT_INPUT = "\u001b[C";

interface Attachment {
  readonly id: number;
  readonly placeholder: string;
  readonly path: string;
  readonly mimeType: string;
}

interface Submission {
  readonly id: number;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

function normalizedPath(path: string) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function mimeTypeForPath(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function isPiClipboardImage(path: string) {
  if (normalizedPath(dirname(path)) !== normalizedPath(tmpdir())) return false;
  if (!PI_CLIPBOARD_IMAGE.test(basename(path))) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function removeTemporaryImage(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup is best effort; never turn an editor action into a crash.
  }
}

function placeholderOccurrences(text: string) {
  return [...text.matchAll(IMAGE_PLACEHOLDER)].map((match) => ({
    id: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export class ImageAttachmentStore {
  private nextAttachmentId = 1;
  private nextSubmissionId = 1;
  private readonly draft = new Map<number, Attachment>();
  private readonly pending = new Map<number, Submission>();

  get hasDraft() {
    return this.draft.size > 0;
  }

  attachClipboardPath(path: string, editorText: string) {
    const mimeType = mimeTypeForPath(path);
    if (!mimeType || !isPiClipboardImage(path)) return undefined;

    let id = this.nextAttachmentId;
    while (this.draft.has(id) || editorText.includes(`[Image #${id}]`)) id += 1;
    const placeholder = `[Image #${id}]`;
    const attachment = {
      id,
      placeholder,
      path,
      mimeType,
    } satisfies Attachment;
    this.nextAttachmentId = id + 1;
    this.draft.set(attachment.id, attachment);
    return placeholder;
  }

  reconcileDraft(text: string) {
    const occurrenceCounts = new Map<number, number>();
    for (const occurrence of placeholderOccurrences(text)) {
      occurrenceCounts.set(
        occurrence.id,
        (occurrenceCounts.get(occurrence.id) ?? 0) + 1,
      );
    }
    for (const [id, attachment] of this.draft) {
      // Placeholder text is user-editable, so only an unambiguous single
      // occurrence may retain ownership of a temporary image. Duplicated or
      // removed tokens become ordinary text and the image is cleaned up.
      if (occurrenceCounts.get(id) === 1) continue;
      this.draft.delete(id);
      removeTemporaryImage(attachment.path);
    }
    this.nextAttachmentId =
      this.draft.size === 0 ? 1 : Math.max(...this.draft.keys()) + 1;
  }

  beginSubmission(text: string) {
    this.reconcileDraft(text);
    const attachments = [...this.draft.values()];
    if (attachments.length === 0) return undefined;
    this.draft.clear();
    this.nextAttachmentId = 1;
    const submission = {
      id: this.nextSubmissionId,
      text,
      attachments,
    } satisfies Submission;
    this.nextSubmissionId += 1;
    this.pending.set(submission.id, submission);
    return submission.id;
  }

  finishSubmission(id: number) {
    const submission = this.pending.get(id);
    if (!submission) return;
    this.pending.delete(id);
    for (const attachment of submission.attachments) {
      removeTemporaryImage(attachment.path);
    }
  }

  discardPendingSubmissions() {
    for (const submission of this.pending.values()) {
      for (const attachment of submission.attachments) {
        removeTemporaryImage(attachment.path);
      }
    }
    this.pending.clear();
  }

  consumeSubmission(text: string) {
    // Pi preserves interactive submission order. Consume that lifecycle-owned
    // identity instead of letting repeated placeholder text select any older
    // pending attachment.
    const submission = this.pending.values().next().value;
    if (!submission || submission.text !== text) return undefined;
    this.pending.delete(submission.id);

    const ordered = [...submission.attachments].sort(
      (left, right) =>
        text.indexOf(left.placeholder) - text.indexOf(right.placeholder),
    );
    const images: ImageContent[] = [];
    const failures: string[] = [];
    let transformedText = text;
    for (const attachment of ordered) {
      try {
        images.push({
          type: "image",
          data: readFileSync(attachment.path).toString("base64"),
          mimeType: attachment.mimeType,
        });
      } catch {
        failures.push(attachment.placeholder);
        transformedText = transformedText.replaceAll(
          attachment.placeholder,
          "",
        );
      } finally {
        removeTemporaryImage(attachment.path);
      }
    }
    return { text: transformedText, images, failures };
  }

  attachmentHit(
    text: string,
    cursor: number,
    direction: "backward" | "forward",
  ) {
    for (const occurrence of placeholderOccurrences(text)) {
      if (!this.draft.has(occurrence.id)) continue;
      if (
        direction === "backward"
          ? cursor > occurrence.start && cursor <= occurrence.end
          : cursor >= occurrence.start && cursor < occurrence.end
      ) {
        return occurrence;
      }
    }
    return undefined;
  }

  cleanup() {
    for (const attachment of this.draft.values()) {
      removeTemporaryImage(attachment.path);
    }
    this.draft.clear();
    this.discardPendingSubmissions();
    this.nextAttachmentId = 1;
    this.nextSubmissionId = 1;
  }
}

interface CursorEditor extends EditorComponent {
  getCursor(): { line: number; col: number } | undefined;
}

function cursorOffset(editor: EditorComponent) {
  const cursor = (
    editor as EditorComponent & Partial<CursorEditor>
  ).getCursor?.();
  if (!cursor) return undefined;
  const lines = editor.getText().split("\n");
  let offset = 0;
  for (let line = 0; line < cursor.line; line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return offset + cursor.col;
}

export class ImageAttachmentEditor extends BelowEditorNavigationEditor {
  private readonly editor: EditorComponent;
  private readonly editorKeybindings: KeybindingsManager;
  private readonly attachments: ImageAttachmentStore;
  private downstreamChange?: (text: string) => void;
  private downstreamSubmit?: (text: string) => void;
  private preparedSubmissionId?: number;
  private settingText = false;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    attachments: ImageAttachmentStore,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      () => undefined,
    );
    this.editor = base;
    this.editorKeybindings = keybindings;
    this.attachments = attachments;
    this.onChange = super.onChange;
    this.onSubmit = super.onSubmit;
  }

  override get onChange() {
    return this.downstreamChange;
  }

  override set onChange(value: ((text: string) => void) | undefined) {
    this.downstreamChange = value;
    super.onChange = (text) => {
      if (this.settingText) {
        this.downstreamChange?.(text);
        return;
      }
      if (text.length === 0 && this.attachments.hasDraft) {
        setTimeout(() => this.attachments.reconcileDraft(this.getText()), 0);
      } else {
        this.attachments.reconcileDraft(text);
      }
      this.downstreamChange?.(text);
    };
  }

  override get onSubmit() {
    return this.downstreamSubmit;
  }

  override set onSubmit(value: ((text: string) => void) | undefined) {
    this.downstreamSubmit = value;
    super.onSubmit = value
      ? (text) => {
          const submissionId =
            this.preparedSubmissionId ?? this.attachments.beginSubmission(text);
          let outcome: unknown;
          try {
            outcome = value(text);
          } catch (error) {
            if (submissionId !== undefined) {
              this.attachments.finishSubmission(submissionId);
            }
            throw error;
          }
          if (submissionId !== undefined) {
            // A fulfilled Pi submit callback only means that the editor accepted
            // the text. The interactive loop may have queued it and emit the
            // input event later, so successful settlement is not terminal
            // evidence for the attachment. Input consumption owns success
            // cleanup; rejection and session shutdown own the other paths.
            void Promise.resolve(outcome).catch(() =>
              this.attachments.finishSubmission(submissionId),
            );
          }
        }
      : undefined;
  }

  override setText(text: string) {
    this.settingText = true;
    try {
      super.setText(text);
    } finally {
      this.settingText = false;
    }
    if (text.length > 0) {
      this.attachments.reconcileDraft(text);
    } else if (this.attachments.hasDraft) {
      setTimeout(() => this.attachments.reconcileDraft(this.getText()), 0);
    }
  }

  override insertTextAtCursor(text: string) {
    const placeholder = this.attachments.attachClipboardPath(
      text,
      this.getText(),
    );
    super.insertTextAtCursor(placeholder ?? text);
  }

  private deleteAttachment(data: string, direction: "backward" | "forward") {
    const text = this.getText();
    const cursor = cursorOffset(this.editor);
    if (cursor === undefined) return false;
    const hit = this.attachments.attachmentHit(text, cursor, direction);
    if (!hit) return false;

    // Keep Pi's editor state intact: setText() would clear its native long-paste
    // registry. Move to one edge, then replay the already-matched deletion
    // action so one user keypress removes the whole image token without
    // disturbing ordinary paste markers or autocomplete state.
    const navigationInput = direction === "backward" ? RIGHT_INPUT : LEFT_INPUT;
    const navigationSteps =
      direction === "backward" ? hit.end - cursor : cursor - hit.start;
    for (let step = 0; step < navigationSteps; step += 1) {
      this.editor.handleInput(navigationInput);
    }
    for (let step = hit.start; step < hit.end; step += 1) {
      this.editor.handleInput(data);
    }
    return true;
  }

  override handleInput(data: string) {
    if (
      this.attachments.hasDraft &&
      this.editorKeybindings.matches(data, "app.message.followUp")
    ) {
      // Alt+Enter reaches this editor before Pi clears it, but its streaming
      // path bypasses onSubmit. Move ownership at the key action boundary.
      const submissionId = this.attachments.beginSubmission(
        this.getText().trim(),
      );
      this.preparedSubmissionId = submissionId;
      try {
        super.handleInput(data);
      } finally {
        this.preparedSubmissionId = undefined;
      }
      return;
    }
    if (
      (this.editorKeybindings.matches(data, "tui.editor.deleteCharBackward") ||
        matchesKey(data, "shift+backspace")) &&
      this.deleteAttachment(data, "backward")
    ) {
      return;
    }
    if (
      (this.editorKeybindings.matches(data, "tui.editor.deleteCharForward") ||
        matchesKey(data, "shift+delete")) &&
      this.deleteAttachment(data, "forward")
    ) {
      return;
    }
    super.handleInput(data);
  }
}

export function transformImageAttachmentInput(
  attachments: ImageAttachmentStore,
  event: {
    text: string;
    images?: ImageContent[];
    source: string;
  },
) {
  if (event.source !== "interactive") return undefined;
  const consumed = attachments.consumeSubmission(event.text);
  if (!consumed) return undefined;
  return {
    text: consumed.text,
    images: [...(event.images ?? []), ...consumed.images],
    failures: consumed.failures,
  };
}

function installImagePasteEditor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  attachments: ImageAttachmentStore,
) {
  if (ctx.mode !== "tui") return;
  registerEditorLayer(pi, ctx, {
    id: "image-paste",
    order: 1_000,
    wrap: (base, _tui, _theme, keybindings) =>
      new ImageAttachmentEditor(base, keybindings, attachments),
  });
}

export default function imagePaste(
  pi: ExtensionAPI,
  attachments = new ImageAttachmentStore(),
) {
  pi.on("session_start", (_event, ctx) => {
    installImagePasteEditor(pi, ctx, attachments);
  });

  pi.on("input", (event, ctx) => {
    const transformed = transformImageAttachmentInput(attachments, event);
    if (!transformed) return { action: "continue" };
    for (const placeholder of transformed.failures) {
      ctx.ui.notify(
        `${placeholder} could not be read and was not attached`,
        "warning",
      );
    }
    return {
      action: "transform",
      text: transformed.text,
      images: transformed.images,
    };
  });

  pi.on("session_compact", (event) => {
    if (event.willRetry) {
      // InteractiveMode flushes retry-bound compaction messages through
      // steer()/followUp(), which bypasses the input event. Those submissions
      // therefore cannot retain attachment ownership.
      attachments.discardPendingSubmissions();
    }
  });

  pi.on("session_shutdown", () => {
    removeEditorLayer(pi, "image-paste");
    attachments.cleanup();
  });
}
