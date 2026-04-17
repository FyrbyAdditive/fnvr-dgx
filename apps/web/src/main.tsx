import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Login } from "@/routes/login/Login";
import { Live } from "@/routes/live/Live";
import { Timeline } from "@/routes/timeline/Timeline";
import { Cameras } from "@/routes/cameras/Cameras";
import { Events } from "@/routes/events/Events";
import { Rules } from "@/routes/rules/Rules";
import { Settings } from "@/routes/settings/Settings";
import "./index.css";

const qc = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/live" replace />} />
            <Route path="/live" element={<Live />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/events" element={<Events />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
