# Composer media attachments

Status: proposed; implementation must not begin until this specification is approved.

## 1. Decision summary

Add a Pi extension that turns explicit local media references into visible composer attachments and real multimodal image input.

An attachment is discovered when the user:

- pastes an image with Pi's existing `Ctrl+V` behavior, which inserts a `/tmp/pi-clipboard-<uuid>.<ext>` path; or
- references a local file with `@path` syntax.

While the draft remains in the editor, the extension renders a compact attachment preview above the editor. On submission, image attachments are added to the input event as `ImageContent`; the model receives the image in the same user turn and does not need to call `read` first.

Video is represented by its first decodable frame. The original video path remains in the prompt so the model and user can distinguish a video frame from a still image.

This is a composer attachment feature. Image generation, remote URL fetching, audio transcription, and full video understanding are separate future work.

## 2. Goals

- Show a clear visual attachment above the editor before submission.
- Make pasted images and `@`-referenced images behave consistently.
- Send accepted media as actual multimodal image content, not only as path text.
- Support common provider-native image formats directly.
- Convert additional raster formats to a provider-safe format when possible.
- Preview videos and send their first frame as an image attachment.
- Preserve source attribution: source kind, original path, media kind, dimensions, and conversion state.
- Remain responsive in regular and fullscreen Pi modes.
- Preserve a useful text fallback when inline terminal graphics are unavailable.
- Degrade safely when conversion tools, codecs, files, or model image support are unavailable.

## 3. Non-goals

The first implementation does not:

- generate or edit images;
- upload files or fetch `http:`, `https:`, or other remote URLs;
- send native video content to providers;
- sample multiple video frames or understand temporal content;
- preview arbitrary bare filesystem paths, except Pi clipboard paths;
- replace Pi's built-in `read` image rendering;
- add a graphical file picker;
- persist unsent drafts across Pi restarts;
- delete or modify source media files;
- promise support for every codec accepted by ImageMagick or FFmpeg.

## 4. User experience

### 4.1 Pasted image

1. The user presses `Ctrl+V` with an image in the clipboard.
2. Pi saves the clipboard image to `/tmp/pi-clipboard-<uuid>.<ext>` and inserts that path into the editor.
3. Within 250 ms, an attachment card appears above the editor.
4. The card shows a thumbnail, filename, media type, dimensions, and loading/error state.
5. The user submits normally.
6. The path remains in the visible prompt and the image is included in the same user message as `ImageContent`.

No second paste shortcut and no special send command are required.

### 4.2 `@` image reference

Given:

```text
Compare this layout with @~/Pictures/layout.png
```

Pi's normal path autocomplete remains authoritative. Once the referenced file resolves to supported media, the same attachment card appears. On submission, the text remains unchanged and the image is attached once.

Quoted paths with spaces must work:

```text
Review @"~/Pictures/home screen.png"
```

### 4.3 Video reference

Given:

```text
What is visible at the beginning of @./demo.webm?
```

The extension extracts the first decodable frame to an extension-owned PNG. The card is labeled `video · first frame`, shows the frame thumbnail, and retains the original video filename. The submitted user turn contains:

- the unchanged original text and video path; and
- the extracted PNG as `ImageContent`.

The extension must not imply that the model received the full video.

### 4.4 Removal

Attachments are derived from editor text. Deleting the corresponding `@path` or clipboard path removes the card and prevents that media from being submitted. No separate attachment state may survive after its source token disappears.

### 4.5 Multiple attachments

- Canonical duplicate paths are attached once.
- Up to eight attachments may be submitted in one prompt.
- The widget lays out as many thumbnail cards as fit in the terminal width.
- Overflow is summarized as `+N more`; all valid attachments remain listed in compact text when inline graphics are unavailable.
- Exceeding eight media references produces a warning and leaves excess references as text-only paths.

## 5. Attachment card

The attachment widget is placed above the editor through `ctx.ui.setWidget()`.

A card contains:

```text
┌ image · 3200×2000 ─────────┐
│                            │
│         thumbnail          │
│                            │
└ screenshot.png · 1.8 MiB ──┘
```

Requirements:

- use `Image` from `@earendil-works/pi-tui` for inline rendering;
- use a PNG thumbnail regardless of source format;
- cap a thumbnail at approximately 20 columns by 6 rows;
- keep the total widget at or below Pi's ten-line widget limit;
- truncate long filenames without losing the extension;
- distinguish `image`, `animated image`, `converted image`, and `video · first frame`;
- show `loading`, `unsupported`, `missing`, and `conversion failed` states without blocking editor input;
- use the active Pi theme and avoid hard-coded colors;
- provide a path-and-metadata fallback when Kitty/iTerm image rendering is unavailable.

The preview is draft UI only. It does not participate in model context.

## 6. Discovery and path parsing

Only these references are attachment candidates:

1. `@path`, `@"path with spaces"`, and `@'path with spaces'` tokens;
2. bare absolute paths whose basename starts with `pi-clipboard-` and ends in a recognized media extension.

Rules:

- expand a leading `~` against the current user's home directory;
- resolve relative paths against `ctx.cwd`;
- strip trailing sentence punctuation after a recognized extension;
- resolve symlinks with `realpath` before deduplication;
- require a readable regular file;
- never interpret a path through a shell;
- ignore directories, sockets, devices, URLs, and nonexistent files;
- identify media by content/probe result, not extension alone;
- preserve the original textual token and the canonical path separately.

The parser must be a pure module with table-driven tests for whitespace, Unicode, quoting, punctuation, duplicate references, and malformed input.

## 7. Supported media

### 7.1 Provider-safe image input

The first implementation directly accepts and processes:

- PNG (`image/png`)
- JPEG (`image/jpeg`)
- WebP (`image/webp`)
- GIF (`image/gif`)

Before submission, every image passes through Pi's exported `resizeImage()` utility using Pi-compatible limits:

- maximum 2000×2000 pixels;
- maximum 4.5 MiB base64 payload;
- EXIF orientation applied;
- PNG or JPEG output selected by the utility when resizing is required.

The transformed `ImageContent` uses the returned `data` and `mimeType`.

### 7.2 Convertible raster input

Attempt conversion to PNG for formats supported by the installed ImageMagick build, including commonly:

- BMP
- TIFF
- HEIC/HEIF
- AVIF
- SVG
- ICO
- JPEG 2000
- PNM/PPM

Conversion capability is runtime-dependent. A failed delegate or unsupported format produces a card error and leaves the path as text; it must not fail the whole prompt.

Animated formats use their first visual frame for the composer thumbnail. Provider-safe GIF may remain animated in the submitted attachment after resizing; other animated formats are submitted as a first-frame still in phase one.

### 7.3 Video input

Attempt first-frame extraction with FFmpeg for formats/codecs recognized by the installed build, including commonly:

- MP4/M4V
- MOV
- WebM
- Matroska
- AVI
- MPEG
- WMV
- FLV
- 3GP

Use the first decodable video frame at or after timestamp zero. Normalize rotation metadata, preserve aspect ratio, and output PNG before applying normal image resizing limits.

The extension submits only the extracted frame. It must add an attribution note to the transformed prompt when a video is attached:

```text
[Attached video first frame: /absolute/path/demo.webm]
```

Add the note once per video and do not modify the editor draft before submission.

## 8. Submission semantics

Use Pi's `input` event.

For interactive, steering, and follow-up input:

1. Parse `event.text` independently of preview cache state.
2. Resolve and process candidate media.
3. Preserve `event.text` except for generated video attribution notes.
4. Merge new images after `event.images`, preserving any existing attachments.
5. Return:

```ts
{
  action: "transform",
  text,
  images: [...(event.images ?? []), ...attachments],
}
```

Each attachment must have Pi's real image shape:

```ts
{
  type: "image",
  data: "<base64>",
  mimeType: "image/png"
}
```

The preview cache is an optimization only. Submission must still work if the draft was pasted and immediately sent before the widget finishes loading.

If the active model does not advertise image input:

- do not add `ImageContent` that would cause a provider failure;
- retain all source paths in text;
- notify the user that the selected model cannot receive image attachments;
- keep the prompt sendable.

## 9. Extension architecture

Proposed package path:

```text
extensions/media-attachments/
  index.ts
  attachment.ts
  discovery.ts
  media.ts
  preview.ts
  process.ts
  temp-files.ts
  tests/
```

The repository's existing `./extensions/*/index.ts` package glob loads it automatically.

### 9.1 Draft tracking

Pi 0.84 does not expose an editor-change subscription to extensions. Do not replace the editor merely to observe text changes. Instead:

- start a session-scoped polling loop in `session_start`;
- read `ctx.ui.getEditorText()` every 150 ms while in TUI mode;
- do no work when the text is unchanged;
- debounce media probing and conversion;
- use generation IDs or abort controllers so stale asynchronous results cannot overwrite newer draft state;
- clear the timer, widget, and in-flight work in `session_shutdown`.

This preserves Pi's editor behavior, FFF autocomplete, clipboard handling, and compatibility with other custom-editor extensions.

### 9.2 Processing pipeline

Separate source media from generated artifacts:

```text
source token
  -> canonical local path
  -> probe/classify
  -> provider payload image
  -> small PNG preview thumbnail
  -> attachment card
```

Cache results by canonical path plus file size and modification time. A changed file invalidates both payload and thumbnail caches.

### 9.3 External tools

Declare runtime dependencies through the Nix Pi configuration rather than assuming ambient commands:

- ImageMagick for broad raster conversion and thumbnails;
- FFmpeg/ffprobe for video probing and first-frame extraction.

Invoke tools through `pi.exec(command, args, ...)` with argument arrays, timeouts, output limits, and abort signals. Never build shell command strings from media paths.

## 10. Resource and safety limits

- Maximum attachments per prompt: 8.
- Maximum image source file read into memory: 50 MiB.
- Maximum video source size: configurable warning threshold; extraction must stream through FFmpeg rather than reading the video into JavaScript memory.
- Probe timeout: 3 seconds.
- Image conversion timeout: 15 seconds.
- Video frame extraction timeout: 30 seconds.
- Preview thumbnail target: at most 512×512 and 512 KiB encoded.
- Provider payload: Pi `resizeImage()` defaults, capped at 2000×2000 and 4.5 MiB base64.
- Conversion stderr must be bounded and sanitized before display.
- Temporary files must use a private extension-owned directory and unpredictable names.
- Delete extension-owned temporary files on removal, successful submission, reload, and shutdown when no longer needed.
- Never delete Pi's `/tmp/pi-clipboard-*` source files or user-owned media.
- Never perform network requests based on draft content.

## 11. Errors and fallback behavior

A single bad attachment must not block unrelated text or valid attachments.

The card and submission notification should distinguish:

- file missing or unreadable;
- unsupported media;
- source too large;
- conversion tool unavailable;
- codec/delegate unavailable;
- conversion timeout;
- resize failure;
- model does not support images.

On failure, leave the original path in the prompt so the model can still reason about it or use tools later. Do not silently claim the media was attached.

## 12. Session and attribution behavior

- Submitted image data is stored through Pi's normal user message content.
- Original paths remain in user text for attribution.
- Video frame notes explicitly identify derived content.
- Draft thumbnail data is not appended as a custom session entry.
- Extension-generated temporary paths are implementation details and must not replace original source paths in visible prompts.
- Restoring a session relies on Pi's persisted `ImageContent`; no source file reread is required for provider context.

Pi 0.84 does not render user-message image blocks in the transcript. Phase one guarantees the pre-send composer preview and true model attachment. Persisted transcript-side user attachment cards require either a future Pi renderer API or a narrowly justified core patch and are deferred.

## 13. Validation

### 13.1 Unit tests

- parse unquoted, quoted, Unicode, relative, home-relative, and clipboard paths;
- ignore URLs, directories, malformed references, and unrelated bare paths;
- strip safe trailing punctuation;
- canonicalize and deduplicate symlinks and repeated tokens;
- classify image/video content independently of misleading extensions;
- enforce attachment count and size limits;
- cancel stale draft processing;
- merge existing `event.images` without mutation;
- preserve input text and add video attribution exactly once.

### 13.2 Integration tests

Use generated fixtures for:

- PNG, JPEG, WebP, and GIF;
- at least BMP, TIFF, SVG, and AVIF conversion where delegates exist;
- MP4 and WebM first-frame extraction;
- rotated JPEG and rotated video metadata;
- corrupt media and unsupported codecs;
- filenames containing spaces, quotes, Unicode, and leading dashes;
- source deletion or modification between preview and submission;
- immediate submit before preview completion;
- mixed valid and invalid attachment batches.

Assert that successful submission produces user content containing both text and `type: "image"` blocks without requiring a `read` tool call.

### 13.3 Manual acceptance

Test in Ghostty through Herdr with `experimental.kitty_graphics = true`:

- regular Pi mode;
- fullscreen Pi mode;
- narrow and wide terminal sizes;
- mouse scrolling while previews are visible;
- paste, `@` completion, removal, steering, and follow-up flows;
- inline-image-disabled fallback;
- model without image capability.

## 14. Acceptance criteria

The feature is complete when:

1. Pasting an image shows a composer attachment within 250 ms under normal local conditions.
2. Referencing an image with `@` shows the same attachment UI.
3. Deleting the path removes the attachment and prevents submission.
4. Sending the prompt records and sends real `ImageContent` in the same user turn.
5. The model can inspect the image without first calling `read`.
6. Common non-native raster formats convert to a safe still image when ImageMagick supports them.
7. A referenced video displays and submits its first frame with explicit attribution.
8. Multiple and duplicate references behave deterministically.
9. Unsupported or failed media never blocks the text prompt and is never reported as attached.
10. The UI works in fullscreen mode and falls back to readable text without terminal graphics.
11. No source file is modified or deleted.
12. Timers, workers, child processes, widgets, and temporary files are cleaned up on reload and shutdown.

## 15. Delivery phases

### Phase 1: still-image attachment core

- path parser;
- pasted and `@` discovery;
- composer cards;
- PNG/JPEG/WebP/GIF processing;
- input-event image attachment;
- removal and error handling;
- unit tests.

### Phase 2: broad raster conversion

- ImageMagick probe/conversion;
- normalized thumbnails;
- conversion capability diagnostics;
- integration fixtures.

### Phase 3: video first frame

- ffprobe classification;
- FFmpeg extraction;
- video attribution notes;
- timeout and codec fallback tests.

### Deferred work

- transcript-side rendering of attached user images;
- multiple video-frame sampling or contact sheets;
- native provider video input;
- drag-and-drop media;
- remote URL attachments;
- image generation and editing;
- review/editor workflows for generated media.

## 16. References

- Pi v0.84.0 extension input transforms and `ImageContent` support.
- Pi TUI `Image`, `HStack`, widgets, terminal capability detection, and fullscreen renderer.
- Pi exported `resizeImage()` utility and provider-compatible payload limits.
- `packages/pi-codex-conversion/src/ui/tool-rendering/media.ts` for compact image rendering patterns.
- `packages/pi-codex-conversion/src/tools/view-image/` for image validation and tool-result behavior.
- `packages/pi-codex-conversion/src/tools/imagegen/` for future Codex-compatible generation work.
