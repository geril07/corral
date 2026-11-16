import { createContext, type RefObject } from "react";

/** A background chat must not take the keyboard when its request or composer mounts. */
export const ChatFocusContext = createContext<RefObject<boolean> | null>(null);
