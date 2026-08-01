# Document And Message Annotation

Users can visually annotate documents and assistant responses in Plannotator, then return structured feedback to the owning Pi session.

## Commands

- `/plannotator-annotate <path-or-url>` opens a file, URL, or folder in the annotation UI.
- `/plannotator-last` opens the latest rendered assistant response and allows selecting another recent response when available.
- Support `--gate` when an explicit approval decision is required.

## Document Annotation

- Support Markdown, plain-text configuration and data files, rendered HTML, URLs, and folders of annotatable files.
- Render HTML directly by default and allow conversion to Markdown for document-oriented review.
- Fetch URLs through the configured reader and retain source provenance.
- Enforce file-type and size limits before opening the browser.

## Feedback

- Support text comments, redlines, markup, quick labels, global comments, looks-good marks, and image attachments.
- Treat annotations as requested changes or guidance; do not silently modify the reviewed source.
- Return submitted feedback automatically as a follow-up in the Pi session that opened the review.
- Preserve the selected assistant-message identity so feedback targets the reviewed response rather than a newer message.
- Do not emit a conversational preamble before resolving the target for `/plannotator-last`.
- Treat approval with notes as accepted guidance, not a request to rewrite the reviewed document or message.
- Closing without feedback produces no agent work.

## Integration

- Expose document and last-message annotation through the shared Plannotator event API for other Pi extensions.
- Keep browser sessions asynchronous so Pi remains usable while a review is open.
- Deliver results only to the originating live session and report failures without redirecting feedback to another session.

## References

- https://github.com/backnotprop/plannotator
