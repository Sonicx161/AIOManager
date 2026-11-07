// framer-motion turns Enter on a focused tap target into untyped synthetic pointer events.
// The deck's own key handler already owns Enter, so those taps must not act a second time.
export function isKeyboardSyntheticTap(event: { pointerType?: string } | null | undefined): boolean {
  return !!event && event.pointerType === ''
}
