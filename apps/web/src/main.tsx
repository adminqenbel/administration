import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@qenbel/ui/theme.css";
import "@qenbel/ui/components.css";
import "./app.css";
import { ToastProvider } from "@qenbel/ui";
import { App } from "./App.tsx";
import { AuthProviderRoot } from "./auth/AuthContext.tsx";
import { createAuthProvider } from "./auth/createAuthProvider.ts";
import { BusinessProvider } from "./business.tsx";

const provider = createAuthProvider({ dev: import.meta.env.DEV, hostname: window.location.hostname });

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProviderRoot provider={provider}>
          <BusinessProvider>
            <App />
          </BusinessProvider>
        </AuthProviderRoot>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
