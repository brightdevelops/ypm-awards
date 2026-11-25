import { useEffect, useId, useRef } from 'react'

// A modal built on the browser's <dialog>: showModal() makes the rest of the
// page inert, keeps Tab inside the dialog, and closes on Escape. Focus moves
// to the first [data-autofocus] element (or the dialog's first control) and
// goes back to whatever was focused before when it closes.
//
// canDismiss: false stops Escape from closing it (the show-once screen).
export default function Dialog({ title, description, onClose, canDismiss = true, children, wide }) {
  const ref = useRef(null)
  const titleId = useId()
  const descId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dismissRef = useRef(canDismiss)
  dismissRef.current = canDismiss

  useEffect(() => {
    const el = ref.current
    const opener = document.activeElement
    if (!el.open) el.showModal()
    const first = el.querySelector('[data-autofocus]')
    if (first) first.focus()

    function onCancel(e) {
      e.preventDefault()
      if (dismissRef.current) closeRef.current()
    }
    // Some browsers close a dialog on a repeated Escape even when "cancel" was
    // prevented. Reopen one that mustn't be dismissed; otherwise treat it as
    // a normal close so the parent's state follows.
    function onNativeClose() {
      if (dismissRef.current) closeRef.current()
      else el.showModal()
    }
    el.addEventListener('cancel', onCancel)
    el.addEventListener('close', onNativeClose)

    return () => {
      el.removeEventListener('cancel', onCancel)
      el.removeEventListener('close', onNativeClose)
      if (el.open) el.close()
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={`adminDialog${wide ? ' wide' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
    >
      <div className="dialogHead">
        <h2 id={titleId}>{title}</h2>
        {canDismiss && (
          <button type="button" className="dialogClose" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      {description && (
        <p id={descId} className="dim small dialogDesc">
          {description}
        </p>
      )}
      {children}
    </dialog>
  )
}
