/** Use the clipboard of the window that owns the clicked control. */
export async function writeClipboardText(text: string, target: Pick<Window, 'navigator'> = window): Promise<void> {
  if (!target.navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
  await target.navigator.clipboard.writeText(text);
}
