import { createContext, useContext, useEffect, useRef, useState } from "react";
import { emptyPopupView, type PopupViewCommand, type PopupViewSnapshot, type PopupViewState } from "../../shared/messaging/popup-view";
import { ListSkeleton } from "../components/ListSkeleton";

interface PopupViewContextValue {
  state: PopupViewState;
  update(patch: Partial<PopupViewState>): void;
}
const Context = createContext<PopupViewContextValue | null>(null);

async function send(command: PopupViewCommand): Promise<PopupViewSnapshot | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return null;
  return chrome.runtime.sendMessage(command);
}

export function PopupViewProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState(emptyPopupView);
  const current = useRef(state);
  const generation = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void send({ type: "popup/view/get" }).then((snapshot) => {
      if (!active || !snapshot || typeof snapshot.generation !== "string") return;
      generation.current = snapshot.generation;
      current.current = snapshot.state ?? emptyPopupView();
      setState(current.current);
    }).catch(() => undefined).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  function update(patch: Partial<PopupViewState>): void {
    const next = { ...current.current, ...patch };
    current.current = next;
    setState(next);
    // Send while the surface is alive: popup unload cannot reliably await work.
    if (generation.current !== null) {
      void send({ type: "popup/view/set", generation: generation.current, state: next }).catch(() => undefined);
    }
  }

  return ready ? <Context.Provider value={{ state, update }}>{children}</Context.Provider> : <ListSkeleton />;
}

export function usePopupView(): PopupViewContextValue | null {
  return useContext(Context);
}
