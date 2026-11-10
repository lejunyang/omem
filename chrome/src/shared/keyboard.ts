export function isComposingKeyboardEvent(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function shouldHandleEnterKey(event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">): boolean {
  return event.key === "Enter" && !isComposingKeyboardEvent(event);
}
