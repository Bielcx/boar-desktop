/**
 * Online or offline, from the phone's own network state (expo-network reads Android's
 * ConnectivityManager / iOS's NWPathMonitor; nothing is sent). Answers never need the connection, only downloads and model search do;
 * the header only tells the user whether the phone has one. Pure: tested without the native module.
 */
export interface NetState {
  isConnected?: boolean;
  /** null/undefined while the OS hasn't checked yet: treated as reachable when connected. */
  isInternetReachable?: boolean | null;
}

export function isOnline(state: NetState | null | undefined): boolean {
  if (!state?.isConnected) return false;
  return state.isInternetReachable !== false;
}
