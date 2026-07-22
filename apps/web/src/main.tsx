import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { Login } from "@/routes/login/Login";
import { Live } from "@/routes/live/Live";
import "./index.css";

// Live (the landing route) and Layout stay eager; everything else
// code-splits so the always-open wall doesn't parse the Timeline/
// Faces/Settings bundles it may never visit. Vite emits one chunk per
// dynamic import.
const Timeline = lazy(() => import("@/routes/timeline/Timeline").then((m) => ({ default: m.Timeline })));
const Cameras = lazy(() => import("@/routes/cameras/Cameras").then((m) => ({ default: m.Cameras })));
const Events = lazy(() => import("@/routes/events/Events").then((m) => ({ default: m.Events })));
const Faces = lazy(() => import("@/routes/faces/Faces").then((m) => ({ default: m.Faces })));
const Plates = lazy(() => import("@/routes/plates/Plates").then((m) => ({ default: m.Plates })));
const Rules = lazy(() => import("@/routes/rules/Rules").then((m) => ({ default: m.Rules })));
const Settings = lazy(() => import("@/routes/settings/Settings").then((m) => ({ default: m.Settings })));
const Storage = lazy(() => import("@/routes/storage/Storage").then((m) => ({ default: m.Storage })));
const Flags = lazy(() => import("@/routes/flags/Flags").then((m) => ({ default: m.Flags })));

const qc = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <ConfirmProvider>
      <BrowserRouter>
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center text-neutral-500 text-sm p-8">
              Loading…
            </div>
          }
        >
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/live" replace />} />
              <Route path="/live" element={<Live />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/cameras" element={<Cameras />} />
              <Route path="/events" element={<Events />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="/plates" element={<Plates />} />
              <Route path="/faces" element={<Faces />} />
              <Route path="/storage" element={<Storage />} />
              <Route path="/flags" element={<Flags />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
      </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
