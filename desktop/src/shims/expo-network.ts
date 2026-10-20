// Desktop shim for "expo-network" (useNetworkState, the header's ONLINE/OFFLINE pill and the model browser). See
// shared/bridge.ts. expo-network's web module answers from navigator.onLine, which on Windows stays true while any
// adapter is up (WSL, VirtualBox): main asks Windows whether there's internet (handlers/expo-network.ts). Checked on
// open, every POLL_MS and on the window's online/offline events; navigator.onLine where main has no answer.
import { useEffect, useState } from "react";
import { native } from "../shared/bridge";

export interface NetworkState {
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

const POLL_MS = 10_000;
const fromOnline = (online: boolean): NetworkState => ({ isConnected: online, isInternetReachable: online });

let last: NetworkState = fromOnline(typeof navigator === "undefined" || navigator.onLine);
const listeners = new Set<(s: NetworkState) => void>();

export async function getNetworkStateAsync(): Promise<NetworkState> {
  const reachable = await native()
    .invoke<boolean | null>("expo-network:internet")
    .catch(() => null);
  const next = fromOnline(reachable ?? navigator.onLine);
  if (next.isConnected !== last.isConnected) {
    last = next;
    for (const l of listeners) l(last);
  }
  return last;
}

let timer: ReturnType<typeof setInterval> | null = null;
const check = () => void getNetworkStateAsync();

export function useNetworkState(): NetworkState {
  const [state, setState] = useState(last);
  useEffect(() => {
    listeners.add(setState);
    if (listeners.size === 1) {
      timer = setInterval(check, POLL_MS);
      window.addEventListener("online", check);
      window.addEventListener("offline", check);
    }
    check();
    return () => {
      listeners.delete(setState);
      if (listeners.size === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        window.removeEventListener("online", check);
        window.removeEventListener("offline", check);
      }
    };
  }, []);
  return state;
}
