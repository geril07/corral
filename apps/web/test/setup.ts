import { beforeEach } from "vite-plus/test";
// oxlint-disable-next-line import/no-unassigned-import -- design tokens and Tailwind for every browser test
import "../src/app/global.css";

// Device preferences (the sidebar mode) are stored in localStorage; a fresh page per test must
// not inherit the one the previous test left behind.
beforeEach(() => {
  window.localStorage.clear();
});
