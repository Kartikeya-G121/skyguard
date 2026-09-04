import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { StreamProvider } from "./lib/useStream.jsx";
import Shell from "./components/Shell.jsx";
import Cover from "./routes/Cover.jsx";
import Network from "./routes/Network.jsx";
import Station from "./routes/Station.jsx";
import Anomaly from "./routes/Anomaly.jsx";
import Alerts from "./routes/Alerts.jsx";
import Edge from "./routes/Edge.jsx";
import { applyTheme, storedTheme } from "./lib/theme.js";
import "./styles/base.css";
import "./styles/app.css";

// Applied before the first paint so the page never flashes the other palette.
applyTheme(storedTheme());

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <StreamProvider>
        <Routes>
          <Route path="/" element={<Cover />} />
          <Route element={<Shell />}>
            <Route path="/network" element={<Network />} />
            <Route path="/station/:id" element={<Station />} />
            <Route path="/anomaly/:id" element={<Anomaly />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/edge" element={<Edge />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </StreamProvider>
    </BrowserRouter>
  </StrictMode>
);
