import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import App from "./App";
import { ConfirmProvider } from "./components/Dialog";
import { I18nProvider, useI18n } from "./i18n";
import { ApiError } from "./lib/api";
import { AppProvider } from "./lib/app";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function Toasts() {
  const { dir } = useI18n();
  return <Toaster position={dir === "rtl" ? "bottom-left" : "bottom-right"} dir={dir} richColors closeButton />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <I18nProvider>
          <AppProvider>
            <ConfirmProvider>
              <App />
              <Toasts />
            </ConfirmProvider>
          </AppProvider>
        </I18nProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
