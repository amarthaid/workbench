import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/ui/Toast";

export interface UndoableActionOptions<T> {
  /** The real work. Called with the argument given to `schedule`, once the delay has passed. */
  run: (arg: T) => void | Promise<unknown>;
  /** How long Undo is on offer before `run` is called. */
  delayMs?: number;
  /** Past-tense word in the toast, after the label. */
  verb?: string;
}

/**
 * Delay a destructive action behind an Undo toast: "<label> deleted. Undo".
 * `run` is only called after the delay. Undo cancels it. Leaving the page
 * (unmounting the component that uses this hook) cancels pending actions too,
 * without running them, as does closing the tab. Needs a ToastProvider above it.
 */
export function useUndoableAction<T = void>({ run, delayMs = 5000, verb = "deleted" }: UndoableActionOptions<T>) {
  const toast = useToast();
  const runRef = useRef(run);
  runRef.current = run;
  const pending = useRef(new Map<number, { timer: ReturnType<typeof setTimeout>; toastId: number }>());
  const next = useRef(1);

  useEffect(() => {
    const map = pending.current;
    return () => {
      for (const { timer, toastId } of map.values()) {
        clearTimeout(timer);
        toast.dismiss(toastId);
      }
      map.clear();
    };
  }, [toast]);

  const schedule = useCallback(
    (label: string, arg: T) => {
      const key = next.current++;
      const cancel = () => {
        const entry = pending.current.get(key);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.current.delete(key);
      };
      const toastId = toast.show({
        message: `${label} ${verb}.`,
        actionLabel: "Undo",
        onAction: cancel,
      });
      const timer = setTimeout(() => {
        pending.current.delete(key);
        toast.dismiss(toastId);
        void runRef.current(arg);
      }, delayMs);
      pending.current.set(key, { timer, toastId });
    },
    [toast, delayMs, verb]
  );

  return { schedule };
}
