/** Browser file download helpers (text or binary). */
export function autoDownload(filename: string, content: string | Uint8Array, mime: string): void {
  const part: BlobPart = typeof content === 'string' ? content : (content.slice().buffer as ArrayBuffer);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
