import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * It also tracks which items are pending, so a list can hide a row while its
 * delete can still be undone: `schedule(label, arg, key)` (the key defaults to
 * the label) marks the key pending until Undo, or until `run` has settled when
 * it returns a promise. A key that is already pending is not scheduled twice.
 */
export function useUndoableAction<T = void>({ run, delayMs = 5000, verb = "deleted" }: UndoableActionOptions<T>) {
  const toast = useToast();
  const runRef = useRef(run);
  runRef.current = run;
  // Keys waiting out their delay, with the handles needed to cancel them.
  const waiting = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; toastId: number }>());
  // Keys whose run has started but not settled yet. Still pending for display.
  const running = useRef(new Set<string>());
  const mounted = useRef(true);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const publish = useCallback(() => {
    if (!mounted.current) return;
    setPendingKeys(new Set([...waiting.current.keys(), ...running.current]));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const map = waiting.current;
    return () => {
      mounted.current = false;
      for (const { timer, toastId } of map.values()) {
        clearTimeout(timer);
        toast.dismiss(toastId);
      }
      map.clear();
    };
  }, [toast]);

  const schedule = useCallback(
    (label: string, arg: T, key: string = label) => {
      if (waiting.current.has(key) || running.current.has(key)) return;
      const cancel = () => {
        const entry = waiting.current.get(key);
        if (!entry) return;
        clearTimeout(entry.timer);
        waiting.current.delete(key);
        publish();
      };
      const toastId = toast.show({
        message: `${label} ${verb}.`,
        actionLabel: "Undo",
        onAction: cancel,
      });
      const timer = setTimeout(() => {
        waiting.current.delete(key);
        running.current.add(key);
        toast.dismiss(toastId);
        const settle = () => {
          running.current.delete(key);
          publish();
        };
        try {
          Promise.resolve(runRef.current(arg)).then(settle, settle);
        } catch {
          settle();
        }
      }, delayMs);
      waiting.current.set(key, { timer, toastId });
      publish();
    },
    [toast, delayMs, verb, publish]
  );

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys]);

  return { schedule, isPending, pendingKeys };
}
