# Native clipboard image ownership

The retained `chatImages:readClipboard` command has empty arguments. It runs
directly in the native host; the Node service does not receive clipboard targets,
file paths or image bytes. The renderer supplies its native bootstrap document
receipt separately from the public payload. The host checks the trusted main
window, physical document, visibility and engine epoch before reading and before
returning a result.

The first implementation reads `image/png` on Linux through the GTK runtime
already used by Tauri. Target and content requests run asynchronously on the GTK
main thread. A bounded target query precedes the content request. Copied-file
targets return a fixed message without reading their contents or opening paths;
ordinary text and empty clipboard content return empty images and errors. Other
known image formats return a fixed unsupported-format message.

A successful result contains one `image.png` with MIME `image/png`, canonical
plain base64, a PNG signature and at most 512 KiB of decoded bytes. Validation
checks the reported byte length before copying native selection data. The strict
codec rejects extra fields, filenames, paths, unknown errors and malformed
base64. Images and errors cannot appear together. Native diagnostics are not
included in public results. GTK receives the underlying selection before its
reported length is available; the cap bounds copying and RPC output rather than
all memory inside the clipboard transport.

Native work retains the actual GTK callback until it completes. Cancelling or
timing out a public request does not release unfinished callback ownership;
shutdown drains that work. A five-second native response deadline returns the
fixed read-failure message and retires further acquisition while the callback
still drains. A retired document cannot receive its old result,
and reconnect does not replay a clipboard read. Clipboard reads are fenced
while renderer hydration is pending.

This is scoped implementation for #202, #209, #214 and #215. Copied-file import,
other image formats, macOS and Windows clipboard owners, installed graphical
paste acceptance and complete migration gates remain open. Display-free callback
fixtures do not establish installed OS clipboard behavior. The shipping
application remains Electron; hosted voice remains deferred by user decision.
