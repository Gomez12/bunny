import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { X } from "../lib/icons";

// Module-scope ESC stack: only the top-most open Modal responds to Escape.
// Without this, nested modals (e.g. DefinitionDialog -> ConfirmDialog) would
// each fire and close both layers on a single ESC press.
const escStack: number[] = [];
let nextEscId = 0;

export type ModalSize = "sm" | "md";

interface ModalProps {
  onClose: () => void;
  /** sm = 420px, md = 600px (`.modal--wide`). Default: sm. */
  size?: ModalSize;
  /** Disable backdrop-click close (e.g. destructive flows). */
  disableBackdropClose?: boolean;
  /** Disable ESC close. */
  disableEscClose?: boolean;
  /** Extra classes on the `.modal` box. */
  className?: string;
  children: ReactNode;
}

interface ModalCtx {
  onClose: () => void;
}

const Ctx = createContext<ModalCtx | null>(null);

function useModalCtx(component: string): ModalCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error(`<${component}> must be used inside <Modal>`);
  return ctx;
}

function Modal({
  onClose,
  size = "sm",
  disableBackdropClose,
  disableEscClose,
  className,
  children,
}: ModalProps) {
  const escIdRef = useRef<number>(0);
  if (escIdRef.current === 0) escIdRef.current = ++nextEscId;

  useEffect(() => {
    if (disableEscClose) return;
    const id = escIdRef.current;
    escStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only the top-most open modal handles ESC.
      if (escStack[escStack.length - 1] !== id) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = escStack.indexOf(id);
      if (idx >= 0) escStack.splice(idx, 1);
    };
  }, [onClose, disableEscClose]);

  const cls = ["modal", size === "md" ? "modal--wide" : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="modal-backdrop"
      onClick={disableBackdropClose ? undefined : onClose}
      role="presentation"
    >
      <div
        className={cls}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <Ctx.Provider value={{ onClose }}>{children}</Ctx.Provider>
      </div>
    </div>
  );
}

interface HeaderProps {
  title: ReactNode;
  /** Override the default onClose (rare — e.g. ConfirmDialog destructive flow). */
  onClose?: () => void;
}

function ModalHeader({ title, onClose: overrideClose }: HeaderProps) {
  const ctx = useModalCtx("Modal.Header");
  const onClose = overrideClose ?? ctx.onClose;
  return (
    <header className="modal__header">
      <h2>{title}</h2>
      <button
        type="button"
        className="modal__close"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </header>
  );
}

function ModalBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const cls = ["modal__body", className].filter(Boolean).join(" ");
  return <div className={cls}>{children}</div>;
}

function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const cls = ["modal__footer", className].filter(Boolean).join(" ");
  return <div className={cls}>{children}</div>;
}

export default Object.assign(Modal, {
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter,
});
