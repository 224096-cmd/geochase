import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// CDN(unpkg)から読み込むとオフラインで地図が崩れるため、バンドルに含める
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { registerPwa } from "./lib/registerPwa";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerPwa();