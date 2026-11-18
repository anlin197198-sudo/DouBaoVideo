import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="modal-heading">
        <h2>{title}</h2>
        <button
          className="text-button"
          aria-label="关闭弹窗"
          disabled={busy}
          onClick={onClose}
        >
          关闭
        </button>
      </header>
      {children}
    </dialog>
  );
}
