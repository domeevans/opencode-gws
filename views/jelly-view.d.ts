/**
 * The types of `jelly-view.js`, for a page written or checked with TypeScript:
 * `/// <reference path="./jelly-view.d.ts" />`. They mirror the bridge envelopes
 * in Jelly's contracts (`protocol/contracts/src/view-bridge.ts`); the page itself
 * carries only the JavaScript.
 */

type JellyViewPlace = "tool-result" | "home-widget" | "settings-section";
type JellyViewGrant = "data" | "state" | "rpc" | "open-agent";

/** The fixed theme token set; the helper sets each as `--jelly-<name>` on the page. */
interface JellyViewTheme {
  text: string;
  muted: string;
  surface: string;
  raised: string;
  border: string;
  accent: string;
  "on-accent": string;
  danger: string;
  font: string;
  radius: string;
  scheme: "light" | "dark";
}

interface JellyViewHello {
  v: 1;
  kind: "hello";
  /** `package` is null for a Home app an agent made. */
  view: { package: string | null; id: string; title: string; place: JellyViewPlace };
  grants: JellyViewGrant[];
  /** The methods `call` may name. */
  rpc: string[];
  theme: JellyViewTheme;
}

/** A view's state: JSON of at most 64 KB, and the revision a write must name. */
interface JellyViewState {
  revision: number;
  data: unknown;
}

type JellyViewPush =
  | { v: 1; kind: "data.changed"; data: unknown }
  | ({ v: 1; kind: "state.changed" } & JellyViewState)
  | { v: 1; kind: "theme.changed"; theme: JellyViewTheme }
  | { v: 1; kind: "visibility"; visible: boolean }
  /** The call with request id `re` waits for the person, at most until `until` (ISO time). */
  | { v: 1; kind: "rpc.waiting"; re: string; until: string };

interface JellyView {
  hello: JellyViewHello;
  /** Hear pushes; returns the way to stop. */
  on(listener: (push: JellyViewPush) => void): () => void;
  /** Any request by its op, for one the helper has no name for. */
  request(op: string, fields?: Record<string, unknown>): Promise<unknown>;
  /** The place's data (the `data` grant). */
  data(): Promise<unknown>;
  /** The view's state (the `state` grant). */
  state(): Promise<JellyViewState>;
  /** Replace the state if `revision` is still the stored one; rejects on a conflict. */
  setState(revision: number, data: unknown): Promise<JellyViewState>;
  /** One of the methods the hello lists (the `rpc` grant). */
  call(method: string, input?: unknown): Promise<unknown>;
  /** Start a message for the person to send; it is never sent (the `open-agent` grant). */
  openAgent(prefill?: string): Promise<null>;
  /** The height the page needs, in CSS pixels, up to 1200: a hint the app may draw shorter. */
  resize(height: number): Promise<null>;
  /** Not mine: the app closes the frame and keeps its ordinary look. */
  decline(): Promise<null>;
}

declare function jellyView(): Promise<JellyView>;
