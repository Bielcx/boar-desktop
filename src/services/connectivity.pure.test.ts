import { describe, expect, it } from "vitest";
import { isOnline } from "./connectivity.pure";

describe("isOnline", () => {
  it("is offline with no network, or a network without internet", () => {
    expect(isOnline(undefined)).toBe(false);
    expect(isOnline({})).toBe(false);
    expect(isOnline({ isConnected: false, isInternetReachable: true })).toBe(false);
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
  });

  it("is online when connected and reachable, or before the OS has checked", () => {
    expect(isOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnline({ isConnected: true })).toBe(true);
  });
});
