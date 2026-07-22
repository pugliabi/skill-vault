import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import { openEventStream } from "./lib/sse";
import "./index.css";

// One QueryClient for the whole app. Defaults:
// - 5s stale → fast refresh after mutations, but still cached across
//   quick route changes
// - retry: 1 → one retry on failure, no more (we don't want hung UIs)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Open the SSE stream once for the lifetime of the app. We
// intentionally do NOT call .close() — it should run as long as
// the tab is open, and the browser will close it on tab close.
// Module-scope (not a React effect) guarantees a single connection
// even under StrictMode's double-render in dev.
if (typeof window !== "undefined") {
  openEventStream(queryClient);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  </React.StrictMode>,
);
